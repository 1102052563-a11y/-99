'use strict';

/**
 * 剧情指导 StoryGuide (SillyTavern UI Extension)
 * - 不依赖油猴
 * - 从当前聊天/角色卡/聊天元数据读取“正在经历的世界”
 * - 生成：世界简介、关键剧情点、当前场景、后续事件、主角影响、提示
 *
 * 依赖：
 * - SillyTavern.getContext()（扩展API）
 * - extensionSettings / saveSettingsDebounced（持久化设置）
 * - chatMetadata / saveMetadata（按聊天存原著/设定）
 * - eventSource / event_types（监听聊天切换、消息产生）
 */

const MODULE_NAME = 'storyguide';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,

  // 分析输入
  maxMessages: 40,
  maxCharsPerMessage: 1600,
  includeUser: true,
  includeAssistant: true,

  // 生成控制
  spoilerLevel: 'mild', // none | mild | full
  tipCount: 4,

  // 自动刷新
  autoRefresh: false,
  autoRefreshOn: 'received', // received | sent | both
  debounceMs: 1200,

  // 模型调用方式：
  // st = 使用 SillyTavern 当前连接的模型 (推荐，最稳)
  // custom = 直接请求 OpenAI 兼容 endpoint（可能遇到 CORS）
  provider: 'st',
  customEndpoint: '', // 例如：https://api.openai.com/v1/chat/completions
  customApiKey: '',
  customModel: 'gpt-4o-mini',
  temperature: 0.4
});

// chatMetadata（每个聊天不同）
const META_KEYS = Object.freeze({
  canon: 'storyguide_canon_outline',     // 原著后续/大纲
  world: 'storyguide_world_setup',       // 世界观/设定补充
});

let lastReport = null;   // { json, markdown, createdAt, sourceSummary }
let lastJsonText = '';
let refreshTimer = null;

// -------------------- 工具函数 --------------------

function clone(obj) {
  try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
}

function ensureSettings() {
  const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
    saveSettingsDebounced();
  } else {
    // 补齐新字段
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) {
        extensionSettings[MODULE_NAME][k] = DEFAULT_SETTINGS[k];
      }
    }
  }
  return extensionSettings[MODULE_NAME];
}

function stripHtml(input) {
  if (!input) return '';
  return String(input).replace(/<[^>]*>/g, '').replace(/\s+\n/g, '\n').trim();
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  return fallback;
}

function clampFloat(v, min, max, fallback) {
  const n = Number.parseFloat(v);
  if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  return fallback;
}

function safeJsonParse(maybeJson) {
  if (!maybeJson) return null;
  let t = String(maybeJson).trim();

  // 去掉 ```json ... ```
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

  // 有些模型会在 JSON 前后加废话，粗暴截取第一个 { 到最后一个 }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }

  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function toMarkdown(reportJson) {
  const w = reportJson?.world_summary ?? '';
  const points = Array.isArray(reportJson?.key_plot_points) ? reportJson.key_plot_points : [];
  const now = reportJson?.current_scene ?? '';
  const next = Array.isArray(reportJson?.next_events) ? reportJson.next_events : [];
  const impact = reportJson?.protagonist_impact ?? '';
  const tips = Array.isArray(reportJson?.tips) ? reportJson.tips : [];

  const lines = [];
  lines.push(`# 剧情指导报告`);
  lines.push('');
  lines.push(`## 世界简介`);
  lines.push(w ? w : '（空）');
  lines.push('');
  lines.push(`## 重要剧情点`);
  if (points.length) {
    for (const p of points) lines.push(`- ${p}`);
  } else {
    lines.push('（空）');
  }
  lines.push('');
  lines.push(`## 当前时间点 · 具体剧情`);
  lines.push(now ? now : '（空）');
  lines.push('');
  lines.push(`## 后续将会发生的事`);
  if (next.length) {
    for (const n of next) lines.push(`- ${n}`);
  } else {
    lines.push('（空）');
  }
  lines.push('');
  lines.push(`## 主角行为造成的影响`);
  lines.push(impact ? impact : '（空）');
  lines.push('');
  lines.push(`## 给主角的提示（基于原著后续/大纲）`);
  if (tips.length) {
    tips.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  } else {
    lines.push('（未提供原著后续/大纲，或模型未生成提示）');
  }
  return lines.join('\n');
}

function renderMarkdownInto($el, markdown) {
  const { showdown, DOMPurify } = SillyTavern.libs; // shared libs
  const converter = new showdown.Converter({
    simplifiedAutoLink: true,
    strikethrough: true,
    tables: true
  });
  const html = converter.makeHtml(markdown || '');
  const safe = DOMPurify.sanitize(html);
  $el.html(safe);
}

function getChatMetaValue(key) {
  // 注意：不要长期持有 chatMetadata 引用
  const { chatMetadata } = SillyTavern.getContext();
  return chatMetadata?.[key] ?? '';
}

async function setChatMetaValue(key, value) {
  const ctx = SillyTavern.getContext();
  ctx.chatMetadata[key] = value;
  await ctx.saveMetadata();
}

// -------------------- 快照构建 --------------------

function buildSnapshot() {
  const ctx = SillyTavern.getContext();
  const s = ensureSettings();

  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const maxMessages = clampInt(s.maxMessages, 5, 200, DEFAULT_SETTINGS.maxMessages);
  const maxChars = clampInt(s.maxCharsPerMessage, 200, 8000, DEFAULT_SETTINGS.maxCharsPerMessage);

  // 角色卡信息（尽量兼容字段名）
  let charBlock = '';
  try {
    if (ctx.characterId !== undefined && ctx.characterId !== null && Array.isArray(ctx.characters)) {
      const c = ctx.characters[ctx.characterId];
      if (c) {
        const name = c.name ?? '';
        const desc = c.description ?? c.desc ?? '';
        const personality = c.personality ?? '';
        const scenario = c.scenario ?? '';
        const first = c.first_mes ?? c.first_message ?? '';
        charBlock =
          `【角色卡】\n` +
          `- 名称：${stripHtml(name)}\n` +
          `- 描述：${stripHtml(desc)}\n` +
          `- 性格：${stripHtml(personality)}\n` +
          `- 场景/设定：${stripHtml(scenario)}\n` +
          (first ? `- 开场白：${stripHtml(first)}\n` : '');
      }
    }
  } catch (e) {
    console.warn('[StoryGuide] character read failed:', e);
  }

  // 聊天元数据（原著/设定）
  const canon = stripHtml(getChatMetaValue(META_KEYS.canon));
  const world = stripHtml(getChatMetaValue(META_KEYS.world));

  // 最近消息（按配置过滤）
  const picked = [];
  for (let i = chat.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const m = chat[i];
    if (!m) continue;

    const isUser = m.is_user === true;
    if (isUser && !s.includeUser) continue;
    if (!isUser && !s.includeAssistant) continue;

    const name = stripHtml(m.name || (isUser ? 'User' : 'Assistant'));
    let text = stripHtml(m.mes ?? m.message ?? '');
    if (!text) continue;
    if (text.length > maxChars) text = text.slice(0, maxChars) + '…(截断)';

    picked.push(`【${name}】${text}`);
  }
  picked.reverse();

  const sourceSummary = {
    totalMessages: chat.length,
    usedMessages: picked.length,
    hasCanon: Boolean(canon),
    hasWorld: Boolean(world),
    characterSelected: ctx.characterId !== undefined && ctx.characterId !== null
  };

  const snapshotText = [
    `【任务】你是“剧情指导”。根据下方“正在经历的世界”（聊天 + 设定）输出结构化报告。`,
    ``,
    charBlock ? charBlock : `【角色卡】（未获取到/可能是群聊）`,
    ``,
    world ? `【世界观/设定补充】\n${world}\n` : `【世界观/设定补充】（未提供）\n`,
    canon ? `【原著后续/大纲】\n${canon}\n` : `【原著后续/大纲】（未提供）\n`,
    `【聊天记录（最近${picked.length}条）】`,
    picked.length ? picked.join('\n\n') : '（空）'
  ].join('\n');

  return { snapshotText, sourceSummary };
}

// -------------------- 生成（两种provider）--------------------

function buildSchema(tipCount) {
  return {
    name: 'StoryGuideReport',
    description: '剧情指导输出：世界简介、关键点、当前场景、后续事件、主角影响、提示',
    strict: true,
    value: {
      '$schema': 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        world_summary: { type: 'string' },
        key_plot_points: { type: 'array', items: { type: 'string' } },
        current_scene: { type: 'string' },
        next_events: { type: 'array', items: { type: 'string' } },
        protagonist_impact: { type: 'string' },
        tips: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: Math.max(1, tipCount) }
      },
      required: [
        'world_summary',
        'key_plot_points',
        'current_scene',
        'next_events',
        'protagonist_impact',
        'tips'
      ]
    }
  };
}

function spoilerPolicyText(level) {
  switch (level) {
    case 'none':
      return `【剧透策略】严格不剧透：不要透露原著明确未来事件与真相；只给“行动建议/风险提示”，避免点名关键反转。`;
    case 'full':
      return `【剧透策略】允许全剧透：可以直接指出原著后续的关键事件/真相，并解释如何影响当前路线。`;
    case 'mild':
    default:
      return `【剧透策略】轻剧透：可以用“隐晦提示 + 关键风险点”，避免把原著后续完整摊开；必要时可点到为止。`;
  }
}

function buildPromptMessages(snapshotText, spoilerLevel, tipCount) {
  const system = [
    `你是资深“剧情指导/编剧顾问”。`,
    `你要从用户提供的“正在经历的世界”中提炼剧情结构，并给出后续引导。`,
    spoilerPolicyText(spoilerLevel),
    ``,
    `输出必须是 JSON（不要 Markdown，不要代码块，不要多余解释）。`,
    `要求：`,
    `- world_summary：1~3 句话，极简但信息密度高`,
    `- key_plot_points：列出最重要的剧情点（3~8条，短句）`,
    `- current_scene：当前时间点发生了什么（包含“地点/人物动机/冲突/悬念”）`,
    `- next_events：接下来“最可能发生”的事（3~6条）`,
    `- protagonist_impact：主角（用户侧行动）对剧情造成的改变（对比“若按原著/常规走向”）`,
    `- tips：给主角 ${tipCount} 条可执行提示（每条一句话，尽量具体）`,
    ``,
    `如果没有提供“原著后续/大纲”，tips 允许基于叙事逻辑推测，但要避免编造具体原著事件。`
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: snapshotText }
  ];
}

async function callViaSillyTavern(messages, schema, temperature) {
  const ctx = SillyTavern.getContext();
  const result = await ctx.generateRaw({
    prompt: messages,
    jsonSchema: schema,
    temperature
  });

  return typeof result === 'string' ? result : JSON.stringify(result ?? '');
}

async function callViaCustomEndpoint(endpoint, apiKey, model, messages, temperature) {
  const body = {
    model,
    messages,
    temperature
  };

  const headers = {
    'Content-Type': 'application/json'
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Custom endpoint error: HTTP ${res.status} ${res.statusText}\n${text}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? '';
  return String(content);
}

async function fallbackAskJson(messages, temperature) {
  const ctx = SillyTavern.getContext();
  const retry = clone(messages);
  retry.unshift({
    role: 'system',
    content: `再次强调：只输出 JSON 对象本体，不要任何额外文字。`
  });
  const result = await ctx.generateRaw({
    prompt: retry,
    temperature
  });
  return typeof result === 'string' ? result : JSON.stringify(result ?? '');
}

// -------------------- UI --------------------

function getUiRoot() {
  const $root = $('#extensions_settings');
  if ($root.length) return $root;
  const $root2 = $('#extensions_settings2');
  if ($root2.length) return $root2;
  return null;
}

function buildUiHtml() {
  return `
  <div class="sg-panel" id="sg_panel">
    <div class="sg-header">
      <div class="sg-title">剧情指导 <span class="sg-sub">StoryGuide</span></div>
      <label class="sg-toggle">
        <input type="checkbox" id="sg_enabled">
        <span>启用</span>
      </label>
    </div>

    <div class="sg-row sg-grid2">
      <div class="sg-field">
        <label>provider</label>
        <select id="sg_provider">
          <option value="st">使用当前 SillyTavern API（推荐）</option>
          <option value="custom">自定义 OpenAI 兼容 endpoint（可能 CORS）</option>
        </select>
      </div>
      <div class="sg-field">
        <label>剧透等级</label>
        <select id="sg_spoiler">
          <option value="none">不剧透</option>
          <option value="mild">轻剧透</option>
          <option value="full">全剧透</option>
        </select>
      </div>
    </div>

    <div class="sg-row sg-grid3">
      <div class="sg-field">
        <label>最近消息条数</label>
        <input id="sg_maxMessages" type="number" min="5" max="200">
      </div>
      <div class="sg-field">
        <label>每条最大字符</label>
        <input id="sg_maxChars" type="number" min="200" max="8000">
      </div>
      <div class="sg-field">
        <label>提示条数</label>
        <input id="sg_tipCount" type="number" min="1" max="8">
      </div>
    </div>

    <div class="sg-row sg-grid2">
      <label class="sg-check"><input type="checkbox" id="sg_includeUser">包含用户消息</label>
      <label class="sg-check"><input type="checkbox" id="sg_includeAssistant">包含AI消息</label>
    </div>

    <div class="sg-row">
      <label class="sg-check">
        <input type="checkbox" id="sg_autoRefresh">
        自动刷新（监听消息）
      </label>
      <select id="sg_autoRefreshOn">
        <option value="received">AI回复时</option>
        <option value="sent">用户发送时</option>
        <option value="both">两者都触发</option>
      </select>
      <span class="sg-hint">（会做防抖）</span>
    </div>

    <details class="sg-details">
      <summary>自定义 endpoint 设置（可选）</summary>
      <div class="sg-row sg-field">
        <label>Endpoint（完整URL）</label>
        <input id="sg_customEndpoint" type="text" placeholder="https://api.openai.com/v1/chat/completions">
      </div>
      <div class="sg-row sg-grid2">
        <div class="sg-field">
          <label>API Key</label>
          <input id="sg_customApiKey" type="password" placeholder="可留空">
        </div>
        <div class="sg-field">
          <label>Model</label>
          <input id="sg_customModel" type="text" placeholder="gpt-4o-mini">
        </div>
      </div>
      <div class="sg-row sg-field">
        <label>temperature</label>
        <input id="sg_temperature" type="number" step="0.05" min="0" max="2">
      </div>
      <div class="sg-hint sg-warn">
        注意：浏览器直连第三方 API 可能被 CORS 拦截。最稳的是选择 “使用当前 SillyTavern API”。
      </div>
    </details>

    <details class="sg-details" open>
      <summary>本聊天专用：原著后续/大纲 & 世界观补充</summary>
      <div class="sg-row sg-field">
        <label>世界观/设定补充（建议：势力、规则、地理、时间线）</label>
        <textarea id="sg_worldText" rows="4" placeholder="写/粘贴你的世界观补充（仅本聊天生效）"></textarea>
        <div class="sg-actions">
          <button class="menu_button" id="sg_saveWorld">保存到本聊天</button>
        </div>
      </div>
      <div class="sg-row sg-field">
        <label>原著后续/大纲（用于给主角提示，可很粗略）</label>
        <textarea id="sg_canonText" rows="6" placeholder="粘贴原著后续/章节大纲/关键事件列表（仅本聊天生效）"></textarea>
        <div class="sg-actions">
          <button class="menu_button" id="sg_saveCanon">保存到本聊天</button>
        </div>
      </div>
    </details>

    <div class="sg-actions sg-row">
      <button class="menu_button" id="sg_analyze">分析当前剧情</button>
      <button class="menu_button" id="sg_copyMd" disabled>复制报告(MD)</button>
      <button class="menu_button" id="sg_copyJson" disabled>复制JSON</button>
      <button class="menu_button" id="sg_injectTips" disabled>把提示放入输入框</button>
    </div>

    <div class="sg-status" id="sg_status"></div>

    <div class="sg-output">
      <div class="sg-tabs">
        <button class="sg-tab active" data-tab="md" id="sg_tab_md">报告</button>
        <button class="sg-tab" data-tab="json" id="sg_tab_json">JSON</button>
        <button class="sg-tab" data-tab="src" id="sg_tab_src">来源</button>
      </div>

      <div class="sg-pane active" id="sg_pane_md"><div class="sg-md" id="sg_md"></div></div>
      <div class="sg-pane" id="sg_pane_json"><pre class="sg-pre" id="sg_json"></pre></div>
      <div class="sg-pane" id="sg_pane_src"><pre class="sg-pre" id="sg_src"></pre></div>
    </div>
  </div>
  `;
}

function wireTabs() {
  $('#sg_panel .sg-tab').on('click', function () {
    const tab = $(this).data('tab');
    $('#sg_panel .sg-tab').removeClass('active');
    $(this).addClass('active');

    $('#sg_panel .sg-pane').removeClass('active');
    if (tab === 'md') $('#sg_pane_md').addClass('active');
    if (tab === 'json') $('#sg_pane_json').addClass('active');
    if (tab === 'src') $('#sg_pane_src').addClass('active');
  });
}

function setStatus(text, kind = '') {
  const $s = $('#sg_status');
  $s.removeClass('ok err warn').addClass(kind || '');
  $s.text(text || '');
}

function updateButtonsEnabled() {
  const enabled = Boolean(lastReport?.markdown);
  $('#sg_copyMd').prop('disabled', !enabled);
  $('#sg_copyJson').prop('disabled', !Boolean(lastJsonText));
  $('#sg_injectTips').prop('disabled', !enabled);
}

function fillUiFromSettings() {
  const s = ensureSettings();

  $('#sg_enabled').prop('checked', !!s.enabled);
  $('#sg_provider').val(s.provider);
  $('#sg_spoiler').val(s.spoilerLevel);

  $('#sg_maxMessages').val(s.maxMessages);
  $('#sg_maxChars').val(s.maxCharsPerMessage);
  $('#sg_tipCount').val(s.tipCount);

  $('#sg_includeUser').prop('checked', !!s.includeUser);
  $('#sg_includeAssistant').prop('checked', !!s.includeAssistant);

  $('#sg_autoRefresh').prop('checked', !!s.autoRefresh);
  $('#sg_autoRefreshOn').val(s.autoRefreshOn);

  $('#sg_customEndpoint').val(s.customEndpoint);
  $('#sg_customApiKey').val(s.customApiKey);
  $('#sg_customModel').val(s.customModel);
  $('#sg_temperature').val(s.temperature);

  // chatMetadata
  $('#sg_worldText').val(getChatMetaValue(META_KEYS.world));
  $('#sg_canonText').val(getChatMetaValue(META_KEYS.canon));
}

function bindUiEvents() {
  const { saveSettingsDebounced } = SillyTavern.getContext();
  const s = ensureSettings();

  function save() { saveSettingsDebounced(); }

  $('#sg_enabled').on('change', function () { s.enabled = $(this).is(':checked'); save(); });
  $('#sg_provider').on('change', function () { s.provider = String($(this).val()); save(); });
  $('#sg_spoiler').on('change', function () { s.spoilerLevel = String($(this).val()); save(); });

  $('#sg_maxMessages').on('change', function () { s.maxMessages = clampInt($(this).val(), 5, 200, s.maxMessages); $(this).val(s.maxMessages); save(); });
  $('#sg_maxChars').on('change', function () { s.maxCharsPerMessage = clampInt($(this).val(), 200, 8000, s.maxCharsPerMessage); $(this).val(s.maxCharsPerMessage); save(); });
  $('#sg_tipCount').on('change', function () { s.tipCount = clampInt($(this).val(), 1, 8, s.tipCount); $(this).val(s.tipCount); save(); });

  $('#sg_includeUser').on('change', function () { s.includeUser = $(this).is(':checked'); save(); });
  $('#sg_includeAssistant').on('change', function () { s.includeAssistant = $(this).is(':checked'); save(); });

  $('#sg_autoRefresh').on('change', function () { s.autoRefresh = $(this).is(':checked'); save(); });
  $('#sg_autoRefreshOn').on('change', function () { s.autoRefreshOn = String($(this).val()); save(); });

  $('#sg_customEndpoint').on('change', function () { s.customEndpoint = String($(this).val() || '').trim(); save(); });
  $('#sg_customApiKey').on('change', function () { s.customApiKey = String($(this).val() || ''); save(); });
  $('#sg_customModel').on('change', function () { s.customModel = String($(this).val() || '').trim(); save(); });
  $('#sg_temperature').on('change', function () { s.temperature = clampFloat($(this).val(), 0, 2, s.temperature); $(this).val(s.temperature); save(); });

  $('#sg_saveWorld').on('click', async function () {
    try {
      await setChatMetaValue(META_KEYS.world, String($('#sg_worldText').val() || ''));
      setStatus('已保存：世界观/设定补充（本聊天）', 'ok');
    } catch (e) {
      setStatus(`保存失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_saveCanon').on('click', async function () {
    try {
      await setChatMetaValue(META_KEYS.canon, String($('#sg_canonText').val() || ''));
      setStatus('已保存：原著后续/大纲（本聊天）', 'ok');
    } catch (e) {
      setStatus(`保存失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_analyze').on('click', async function () {
    await runAnalysis();
  });

  $('#sg_copyMd').on('click', async function () {
    try {
      await navigator.clipboard.writeText(lastReport?.markdown ?? '');
      setStatus('已复制：Markdown 报告', 'ok');
    } catch (e) {
      setStatus(`复制失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_copyJson').on('click', async function () {
    try {
      await navigator.clipboard.writeText(lastJsonText || '');
      setStatus('已复制：JSON', 'ok');
    } catch (e) {
      setStatus(`复制失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_injectTips').on('click', function () {
    // 放入输入框（不强行发送）
    const tips = Array.isArray(lastReport?.json?.tips) ? lastReport.json.tips : [];
    const spoiler = ensureSettings().spoilerLevel;

    const text =
      tips.length
        ? `/sys 【剧情指导提示｜${spoiler}】\n` + tips.map((t, i) => `${i + 1}. ${t}`).join('\n')
        : (lastReport?.markdown ?? '');

    const $ta = $('#send_textarea');
    if ($ta.length) {
      $ta.val(text).trigger('input');
      setStatus('已把提示放入输入框（你可以手动发送）', 'ok');
    } else {
      setStatus('找不到输入框 #send_textarea，无法注入', 'err');
    }
  });
}

// -------------------- 核心：分析 --------------------

async function runAnalysis() {
  const s = ensureSettings();
  if (!s.enabled) {
    setStatus('插件未启用', 'warn');
    return;
  }

  setStatus('分析中…', 'warn');
  $('#sg_analyze').prop('disabled', true);

  try {
    const { snapshotText, sourceSummary } = buildSnapshot();
    const tipCount = clampInt(s.tipCount, 1, 8, DEFAULT_SETTINGS.tipCount);
    const schema = buildSchema(tipCount);
    const messages = buildPromptMessages(snapshotText, s.spoilerLevel, tipCount);

    let jsonText = '';
    if (s.provider === 'custom') {
      const endpoint = String(s.customEndpoint || '').trim();
      if (!endpoint) throw new Error('custom provider 需要填写 Endpoint（完整URL）');
      jsonText = await callViaCustomEndpoint(
        endpoint,
        s.customApiKey,
        s.customModel || DEFAULT_SETTINGS.customModel,
        messages,
        s.temperature
      );
    } else {
      jsonText = await callViaSillyTavern(messages, schema, s.temperature);

      const parsedTry = safeJsonParse(jsonText);
      if (!parsedTry || Object.keys(parsedTry).length === 0) {
        jsonText = await fallbackAskJson(messages, s.temperature);
      }
    }

    const parsed = safeJsonParse(jsonText);
    if (!parsed) {
      // 保存原文供查看
      lastJsonText = String(jsonText || '');
      $('#sg_json').text(lastJsonText);
      throw new Error('模型输出无法解析为 JSON（你可以切到 JSON 选项卡查看原文）');
    }

    const md = toMarkdown(parsed);
    lastReport = {
      json: parsed,
      markdown: md,
      createdAt: Date.now(),
      sourceSummary
    };
    lastJsonText = JSON.stringify(parsed, null, 2);

    renderMarkdownInto($('#sg_md'), md);
    $('#sg_json').text(lastJsonText);
    $('#sg_src').text(JSON.stringify(sourceSummary, null, 2));

    updateButtonsEnabled();
    setStatus('完成 ✅', 'ok');
  } catch (e) {
    console.error('[StoryGuide] analysis failed:', e);
    setStatus(`分析失败：${e?.message ?? e}`, 'err');
  } finally {
    $('#sg_analyze').prop('disabled', false);
  }
}

// -------------------- 自动刷新（监听事件）--------------------

function scheduleAutoRefresh() {
  const s = ensureSettings();
  if (!s.enabled || !s.autoRefresh) return;

  const delay = clampInt(s.debounceMs, 300, 10000, DEFAULT_SETTINGS.debounceMs);

  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    runAnalysis().catch(() => void 0);
    refreshTimer = null;
  }, delay);
}

function setupEventListeners() {
  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    // chat 切换时刷新 chatMetadata 输入框
    eventSource.on(event_types.CHAT_CHANGED, () => {
      fillUiFromSettings();
      setStatus('已切换聊天：已同步本聊天的原著/设定字段', 'ok');
    });

    // 自动刷新触发点
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
      const s = ensureSettings();
      if (s.autoRefresh && (s.autoRefreshOn === 'received' || s.autoRefreshOn === 'both')) {
        scheduleAutoRefresh();
      }
    });

    eventSource.on(event_types.MESSAGE_SENT, () => {
      const s = ensureSettings();
      if (s.autoRefresh && (s.autoRefreshOn === 'sent' || s.autoRefreshOn === 'both')) {
        scheduleAutoRefresh();
      }
    });
  });
}

// -------------------- 初始化 --------------------

function initUi() {
  const $root = getUiRoot();
  if (!$root) {
    console.warn('[StoryGuide] Cannot find extensions settings root');
    return;
  }

  if ($('#sg_panel').length) return; // 防止重复注入

  $root.append(buildUiHtml());
  wireTabs();
  fillUiFromSettings();
  bindUiEvents();
  updateButtonsEnabled();

  setStatus('StoryGuide 已加载。建议先在“本聊天专用”里粘贴原著后续/大纲。', 'ok');
}

function init() {
  ensureSettings();
  setupEventListeners();

  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    initUi();
  });

  // 给外部脚本一个“独立 API”（浏览器内）
  globalThis.StoryGuide = {
    runAnalysis,
    buildSnapshot: () => buildSnapshot(),
    getLastReport: () => lastReport
  };
}

init();
