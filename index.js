'use strict';

/**
 * 剧情指导 StoryGuide (SillyTavern UI Extension)
 * v0.2.0
 * - 顶栏按钮：在顶部工具栏添加 📘 按钮打开面板
 * - 自定义API：选择 custom 后自动显示 endpoint / key / model
 * - UI 美化：弹窗式设置 + 右侧结果区（报告/JSON/来源）+ 一键复制/注入
 *
 * 注意：
 * - provider=st：使用 SillyTavern 当前连接的 API（最稳）
 * - provider=custom：浏览器直连 OpenAI 兼容 endpoint（可能 CORS）
 */

const MODULE_NAME = 'storyguide';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,

  // 输入截取
  maxMessages: 40,
  maxCharsPerMessage: 1600,
  includeUser: true,
  includeAssistant: true,

  // 生成控制
  spoilerLevel: 'mild', // none | mild | full
  tipCount: 4,
  temperature: 0.4,

  // 自动刷新
  autoRefresh: false,
  autoRefreshOn: 'received', // received | sent | both
  debounceMs: 1200,

  // provider
  provider: 'st', // st | custom

  // custom endpoint (OpenAI compatible)
  customEndpoint: '', // https://api.openai.com/v1/chat/completions
  customApiKey: '',
  customModel: 'gpt-4o-mini',
});

const META_KEYS = Object.freeze({
  canon: 'storyguide_canon_outline',
  world: 'storyguide_world_setup',
});

const UI = Object.freeze({
  topBtnId: 'sg_topbar_btn',
  modalId: 'sg_modal',
  modalBackdropId: 'sg_modal_backdrop',
  settingsPanelId: 'sg_settings_panel_min',
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
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) {
        extensionSettings[MODULE_NAME][k] = DEFAULT_SETTINGS[k];
      }
    }
  }
  return extensionSettings[MODULE_NAME];
}

function saveSettings() {
  const { saveSettingsDebounced } = SillyTavern.getContext();
  saveSettingsDebounced();
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

  // remove ```json fences
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

  // best-effort: first { ... last }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) t = t.slice(first, last + 1);

  try { return JSON.parse(t); } catch { return null; }
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
  lines.push(w || '（空）');
  lines.push('');
  lines.push(`## 重要剧情点`);
  if (points.length) points.forEach(p => lines.push(`- ${p}`)); else lines.push('（空）');
  lines.push('');
  lines.push(`## 当前时间点 · 具体剧情`);
  lines.push(now || '（空）');
  lines.push('');
  lines.push(`## 后续将会发生的事`);
  if (next.length) next.forEach(n => lines.push(`- ${n}`)); else lines.push('（空）');
  lines.push('');
  lines.push(`## 主角行为造成的影响`);
  lines.push(impact || '（空）');
  lines.push('');
  lines.push(`## 给主角的提示（基于原著后续/大纲）`);
  if (tips.length) tips.forEach((t, i) => lines.push(`${i + 1}. ${t}`)); else lines.push('（未提供原著后续/大纲，或模型未生成提示）');
  return lines.join('\n');
}

function renderMarkdownInto($el, markdown) {
  const { showdown, DOMPurify } = SillyTavern.libs;
  const converter = new showdown.Converter({ simplifiedAutoLink: true, strikethrough: true, tables: true });
  const html = converter.makeHtml(markdown || '');
  const safe = DOMPurify.sanitize(html);
  $el.html(safe);
}

function getChatMetaValue(key) {
  const { chatMetadata } = SillyTavern.getContext();
  return chatMetadata?.[key] ?? '';
}

async function setChatMetaValue(key, value) {
  const ctx = SillyTavern.getContext();
  ctx.chatMetadata[key] = value;
  await ctx.saveMetadata();
}

function setStatus(text, kind = '') {
  const $s = $('#sg_status');
  $s.removeClass('ok err warn').addClass(kind || '');
  $s.text(text || '');
}

function updateButtonsEnabled() {
  const ok = Boolean(lastReport?.markdown);
  $('#sg_copyMd').prop('disabled', !ok);
  $('#sg_copyJson').prop('disabled', !Boolean(lastJsonText));
  $('#sg_injectTips').prop('disabled', !ok);
}

function showPane(name) {
  $('#sg_modal .sg-tab').removeClass('active');
  $(`#sg_tab_${name}`).addClass('active');

  $('#sg_modal .sg-pane').removeClass('active');
  $(`#sg_pane_${name}`).addClass('active');
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
      required: ['world_summary', 'key_plot_points', 'current_scene', 'next_events', 'protagonist_impact', 'tips']
    }
  };
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

// -------------------- 快照构建 --------------------

function buildSnapshot() {
  const ctx = SillyTavern.getContext();
  const s = ensureSettings();

  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const maxMessages = clampInt(s.maxMessages, 5, 200, DEFAULT_SETTINGS.maxMessages);
  const maxChars = clampInt(s.maxCharsPerMessage, 200, 8000, DEFAULT_SETTINGS.maxCharsPerMessage);

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

  const canon = stripHtml(getChatMetaValue(META_KEYS.canon));
  const world = stripHtml(getChatMetaValue(META_KEYS.world));

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

// -------------------- 生成：provider=st / custom --------------------

async function callViaSillyTavern(messages, schema, temperature) {
  const ctx = SillyTavern.getContext();

  // 兼容不同版本：generateRaw / generateQuietPrompt（尽量用 jsonSchema）
  if (typeof ctx.generateRaw === 'function') {
    return await ctx.generateRaw({ prompt: messages, jsonSchema: schema, temperature });
  }
  if (typeof ctx.generateQuietPrompt === 'function') {
    // 某些版本用 messages 字段名
    return await ctx.generateQuietPrompt({ messages, jsonSchema: schema, temperature });
  }

  // 如果有 TavernHelper（某些环境），兜底可用，但没有 schema 保证
  if (globalThis.TavernHelper && typeof globalThis.TavernHelper.generateRaw === 'function') {
    const txt = await globalThis.TavernHelper.generateRaw({ ordered_prompts: messages, should_stream: false });
    return String(txt || '');
  }

  throw new Error('未找到可用的生成函数（generateRaw/generateQuietPrompt）。请升级 SillyTavern 或改用 custom endpoint。');
}

async function callViaCustomEndpoint(endpoint, apiKey, model, messages, temperature) {
  const body = { model, messages, temperature, stream: false };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Custom endpoint error: HTTP ${res.status} ${res.statusText}\n${text}`);
  }
  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '');
}

async function fallbackAskJson(messages, temperature) {
  const ctx = SillyTavern.getContext();
  const retry = clone(messages);
  retry.unshift({ role: 'system', content: `再次强调：只输出 JSON 对象本体，不要任何额外文字。` });

  if (typeof ctx.generateRaw === 'function') {
    return await ctx.generateRaw({ prompt: retry, temperature });
  }
  if (typeof ctx.generateQuietPrompt === 'function') {
    return await ctx.generateQuietPrompt({ messages: retry, temperature });
  }
  throw new Error('fallback 失败：缺少 generateRaw/generateQuietPrompt');
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
      if (!endpoint) throw new Error('custom 模式需要填写 Endpoint（完整URL，如 /v1/chat/completions）');
      jsonText = await callViaCustomEndpoint(endpoint, s.customApiKey, s.customModel || DEFAULT_SETTINGS.customModel, messages, s.temperature);
    } else {
      jsonText = await callViaSillyTavern(messages, schema, s.temperature);
      if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
      const parsedTry = safeJsonParse(jsonText);
      if (!parsedTry || Object.keys(parsedTry).length === 0) {
        jsonText = await fallbackAskJson(messages, s.temperature);
      }
    }

    const parsed = safeJsonParse(jsonText);
    lastJsonText = (parsed ? JSON.stringify(parsed, null, 2) : String(jsonText || ''));

    $('#sg_json').text(lastJsonText);
    $('#sg_src').text(JSON.stringify(sourceSummary, null, 2));

    if (!parsed) {
      showPane('json');
      throw new Error('模型输出无法解析为 JSON（已切到 JSON 标签，看看原文）');
    }

    const md = toMarkdown(parsed);
    lastReport = { json: parsed, markdown: md, createdAt: Date.now(), sourceSummary };

    renderMarkdownInto($('#sg_md'), md);

    updateButtonsEnabled();
    showPane('md');
    setStatus('完成 ✅', 'ok');
  } catch (e) {
    console.error('[StoryGuide] analysis failed:', e);
    setStatus(`分析失败：${e?.message ?? e}`, 'err');
  } finally {
    $('#sg_analyze').prop('disabled', false);
  }
}

// -------------------- 自动刷新 --------------------

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

// -------------------- UI：顶栏按钮 + 弹窗 --------------------

function findTopbarContainer() {
  // 1) 优先找扩展按钮的父容器
  const extBtn =
    document.querySelector('#extensions_button') ||
    document.querySelector('[data-i18n="Extensions"]') ||
    document.querySelector('button[title*="Extensions"]') ||
    document.querySelector('button[aria-label*="Extensions"]');

  if (extBtn && extBtn.parentElement) return extBtn.parentElement;

  // 2) 常见 topbar 容器候选
  const candidates = [
    '#top-bar',
    '#topbar',
    '#topbar_buttons',
    '#topbar-buttons',
    '.topbar',
    '.topbar_buttons',
    '.top-bar',
    '.top-bar-buttons',
    '#rightNav',
    '#top-right',
    '#toolbar',
  ];

  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // 3) 最后兜底：放 body（会变成悬浮）
  return null;
}

function createTopbarButton() {
  if (document.getElementById(UI.topBtnId)) return;

  const container = findTopbarContainer();
  const btn = document.createElement('button');
  btn.id = UI.topBtnId;
  btn.type = 'button';
  btn.className = 'sg-topbar-btn';
  btn.title = '剧情指导 StoryGuide';
  btn.innerHTML = '<span class="sg-topbar-icon">📘</span>';

  btn.addEventListener('click', () => openModal());

  if (container) {
    // 尽量继承同级按钮样式
    const sample = container.querySelector('button');
    if (sample && sample.className) btn.className = sample.className + ' sg-topbar-btn';
    container.appendChild(btn);
  } else {
    // 悬浮兜底
    btn.className += ' sg-topbar-fallback';
    document.body.appendChild(btn);
  }
}

function buildModalHtml() {
  return `
  <div id="${UI.modalBackdropId}" class="sg-backdrop" style="display:none;">
    <div id="${UI.modalId}" class="sg-modal" role="dialog" aria-modal="true">
      <div class="sg-modal-head">
        <div class="sg-modal-title">
          <span class="sg-badge">📘</span>
          剧情指导 <span class="sg-sub">StoryGuide</span>
        </div>
        <div class="sg-modal-actions">
          <button class="menu_button sg-btn" id="sg_close">关闭</button>
        </div>
      </div>

      <div class="sg-modal-body">
        <div class="sg-left">
          <div class="sg-card">
            <div class="sg-card-title">生成设置</div>

            <div class="sg-grid2">
              <div class="sg-field">
                <label>启用</label>
                <label class="sg-switch">
                  <input type="checkbox" id="sg_enabled">
                  <span class="sg-slider"></span>
                </label>
              </div>

              <div class="sg-field">
                <label>剧透等级</label>
                <select id="sg_spoiler">
                  <option value="none">不剧透</option>
                  <option value="mild">轻剧透</option>
                  <option value="full">全剧透</option>
                </select>
              </div>

              <div class="sg-field">
                <label>Provider</label>
                <select id="sg_provider">
                  <option value="st">使用当前 SillyTavern API（推荐）</option>
                  <option value="custom">自定义 OpenAI 兼容 endpoint</option>
                </select>
              </div>

              <div class="sg-field">
                <label>temperature</label>
                <input id="sg_temperature" type="number" step="0.05" min="0" max="2">
              </div>
            </div>

            <div class="sg-grid3">
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

            <div class="sg-row">
              <label class="sg-check"><input type="checkbox" id="sg_includeUser">包含用户消息</label>
              <label class="sg-check"><input type="checkbox" id="sg_includeAssistant">包含AI消息</label>
            </div>

            <div class="sg-row sg-inline">
              <label class="sg-check"><input type="checkbox" id="sg_autoRefresh">自动刷新</label>
              <select id="sg_autoRefreshOn">
                <option value="received">AI回复时</option>
                <option value="sent">用户发送时</option>
                <option value="both">两者都触发</option>
              </select>
              <span class="sg-hint">（会防抖）</span>
            </div>

            <div id="sg_custom_block" class="sg-card sg-subcard" style="display:none;">
              <div class="sg-card-title">自定义 Endpoint（OpenAI 兼容）</div>
              <div class="sg-field">
                <label>Endpoint（完整URL）</label>
                <input id="sg_customEndpoint" type="text" placeholder="https://xxx.com/v1/chat/completions">
                <div class="sg-hint sg-warn">提示：浏览器直连第三方 API 可能被 CORS 拦截；最稳用“当前 SillyTavern API”。</div>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>API Key（可选）</label>
                  <input id="sg_customApiKey" type="password" placeholder="可留空">
                </div>
                <div class="sg-field">
                  <label>Model</label>
                  <input id="sg_customModel" type="text" placeholder="gpt-4o-mini">
                </div>
              </div>
            </div>

            <div class="sg-actions-row">
              <button class="menu_button sg-btn-primary" id="sg_saveSettings">保存设置</button>
              <button class="menu_button sg-btn-primary" id="sg_analyze">分析当前剧情</button>
            </div>
          </div>

          <div class="sg-card">
            <div class="sg-card-title">本聊天专用（会随聊天切换）</div>

            <div class="sg-field">
              <label>世界观/设定补充</label>
              <textarea id="sg_worldText" rows="4" placeholder="势力/规则/地理/时间线…"></textarea>
              <div class="sg-actions-row">
                <button class="menu_button sg-btn" id="sg_saveWorld">保存到本聊天</button>
              </div>
            </div>

            <div class="sg-field">
              <label>原著后续/大纲（用于提示）</label>
              <textarea id="sg_canonText" rows="6" placeholder="章节大纲/关键事件列表/伏笔说明…"></textarea>
              <div class="sg-actions-row">
                <button class="menu_button sg-btn" id="sg_saveCanon">保存到本聊天</button>
              </div>
            </div>
          </div>

          <div class="sg-status" id="sg_status"></div>
        </div>

        <div class="sg-right">
          <div class="sg-card">
            <div class="sg-card-title">输出</div>

            <div class="sg-tabs">
              <button class="sg-tab active" id="sg_tab_md">报告</button>
              <button class="sg-tab" id="sg_tab_json">JSON</button>
              <button class="sg-tab" id="sg_tab_src">来源</button>
              <div class="sg-spacer"></div>
              <button class="menu_button sg-btn" id="sg_copyMd" disabled>复制MD</button>
              <button class="menu_button sg-btn" id="sg_copyJson" disabled>复制JSON</button>
              <button class="menu_button sg-btn" id="sg_injectTips" disabled>注入提示</button>
            </div>

            <div class="sg-pane active" id="sg_pane_md"><div class="sg-md" id="sg_md">(尚未生成)</div></div>
            <div class="sg-pane" id="sg_pane_json"><pre class="sg-pre" id="sg_json"></pre></div>
            <div class="sg-pane" id="sg_pane_src"><pre class="sg-pre" id="sg_src"></pre></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  `;
}

function ensureModal() {
  if (document.getElementById(UI.modalBackdropId)) return;
  document.body.insertAdjacentHTML('beforeend', buildModalHtml());

  // backdrop close
  $(`#${UI.modalBackdropId}`).on('click', (e) => {
    if (e.target && e.target.id === UI.modalBackdropId) closeModal();
  });

  $('#sg_close').on('click', closeModal);

  // tabs
  $('#sg_tab_md').on('click', () => { showPane('md'); });
  $('#sg_tab_json').on('click', () => { showPane('json'); });
  $('#sg_tab_src').on('click', () => { showPane('src'); });

  // actions
  $('#sg_saveSettings').on('click', () => {
    pullUiToSettings();
    saveSettings();
    setStatus('已保存设置', 'ok');
  });

  $('#sg_analyze').on('click', async () => {
    pullUiToSettings();
    saveSettings();
    await runAnalysis();
  });

  $('#sg_saveWorld').on('click', async () => {
    try {
      await setChatMetaValue(META_KEYS.world, String($('#sg_worldText').val() || ''));
      setStatus('已保存：世界观/设定补充（本聊天）', 'ok');
    } catch (e) {
      setStatus(`保存失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_saveCanon').on('click', async () => {
    try {
      await setChatMetaValue(META_KEYS.canon, String($('#sg_canonText').val() || ''));
      setStatus('已保存：原著后续/大纲（本聊天）', 'ok');
    } catch (e) {
      setStatus(`保存失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_copyMd').on('click', async () => {
    try {
      await navigator.clipboard.writeText(lastReport?.markdown ?? '');
      setStatus('已复制：Markdown 报告', 'ok');
    } catch (e) {
      setStatus(`复制失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_copyJson').on('click', async () => {
    try {
      await navigator.clipboard.writeText(lastJsonText || '');
      setStatus('已复制：JSON', 'ok');
    } catch (e) {
      setStatus(`复制失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_injectTips').on('click', () => {
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

  // live toggle: provider change show/hide custom block
  $('#sg_provider').on('change', () => {
    const provider = String($('#sg_provider').val());
    $('#sg_custom_block').toggle(provider === 'custom');
  });
}

function pullSettingsToUi() {
  const s = ensureSettings();

  $('#sg_enabled').prop('checked', !!s.enabled);
  $('#sg_spoiler').val(s.spoilerLevel);
  $('#sg_provider').val(s.provider);
  $('#sg_temperature').val(s.temperature);

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

  // chat meta
  $('#sg_worldText').val(getChatMetaValue(META_KEYS.world));
  $('#sg_canonText').val(getChatMetaValue(META_KEYS.canon));

  // show/hide custom settings
  $('#sg_custom_block').toggle(s.provider === 'custom');

  updateButtonsEnabled();
}

function pullUiToSettings() {
  const s = ensureSettings();

  s.enabled = $('#sg_enabled').is(':checked');
  s.spoilerLevel = String($('#sg_spoiler').val());
  s.provider = String($('#sg_provider').val());

  s.temperature = clampFloat($('#sg_temperature').val(), 0, 2, s.temperature);

  s.maxMessages = clampInt($('#sg_maxMessages').val(), 5, 200, s.maxMessages);
  s.maxCharsPerMessage = clampInt($('#sg_maxChars').val(), 200, 8000, s.maxCharsPerMessage);
  s.tipCount = clampInt($('#sg_tipCount').val(), 1, 8, s.tipCount);

  s.includeUser = $('#sg_includeUser').is(':checked');
  s.includeAssistant = $('#sg_includeAssistant').is(':checked');

  s.autoRefresh = $('#sg_autoRefresh').is(':checked');
  s.autoRefreshOn = String($('#sg_autoRefreshOn').val());

  s.customEndpoint = String($('#sg_customEndpoint').val() || '').trim();
  s.customApiKey = String($('#sg_customApiKey').val() || '');
  s.customModel = String($('#sg_customModel').val() || '').trim();
}

function openModal() {
  ensureModal();
  pullSettingsToUi();
  setStatus('', '');
  $(`#${UI.modalBackdropId}`).show();
  showPane('md');
}

function closeModal() {
  $(`#${UI.modalBackdropId}`).hide();
}

// -------------------- 插件设置页（可选：给一个打开按钮） --------------------

function injectMinimalSettingsPanel() {
  const $root = $('#extensions_settings');
  if (!$root.length) return;
  if ($(`#${UI.settingsPanelId}`).length) return;

  $root.append(`
    <div class="sg-panel-min" id="${UI.settingsPanelId}">
      <div class="sg-min-row">
        <div class="sg-min-title">剧情指导 StoryGuide</div>
        <button class="menu_button sg-btn" id="sg_open_from_settings">打开面板</button>
      </div>
      <div class="sg-min-hint">面板也可从顶栏 📘 打开。</div>
    </div>
  `);

  $('#sg_open_from_settings').on('click', () => openModal());
}

// -------------------- 事件监听 --------------------

function setupEventListeners() {
  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    // chat 切换时同步 chatMetadata 文本框
    eventSource.on(event_types.CHAT_CHANGED, () => {
      if (document.getElementById(UI.modalBackdropId) && $(`#${UI.modalBackdropId}`).is(':visible')) {
        pullSettingsToUi();
        setStatus('已切换聊天：已同步本聊天的原著/设定字段', 'ok');
      }
    });

    // 自动刷新触发点
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
      const s = ensureSettings();
      if (s.autoRefresh && (s.autoRefreshOn === 'received' || s.autoRefreshOn === 'both')) scheduleAutoRefresh();
    });

    eventSource.on(event_types.MESSAGE_SENT, () => {
      const s = ensureSettings();
      if (s.autoRefresh && (s.autoRefreshOn === 'sent' || s.autoRefreshOn === 'both')) scheduleAutoRefresh();
    });
  });
}

// -------------------- 初始化 --------------------

function init() {
  ensureSettings();
  setupEventListeners();

  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    createTopbarButton();
    injectMinimalSettingsPanel();
  });

  // 给外部脚本一个“独立 API”（浏览器内）
  globalThis.StoryGuide = {
    open: openModal,
    close: closeModal,
    runAnalysis,
    buildSnapshot: () => buildSnapshot(),
    getLastReport: () => lastReport
  };
}

init();
