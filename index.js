'use strict';

/**
 * 剧情指导 StoryGuide (SillyTavern UI Extension)
 * v0.3.1
 *
 * 重点改动（参考“数据库独立API”方式，降低连不上/跨域问题）：
 * - custom provider 不再优先浏览器直连第三方；优先走 SillyTavern 后端代理：
 *   - POST /api/backends/chat-completions/status  获取状态/模型列表
 *   - POST /api/backends/chat-completions/generate 进行生成
 * - 若酒馆版本不支持上述接口（404），才回退到浏览器直连（可能 CORS）
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

  // 自动刷新（面板报告）
  autoRefresh: false,
  autoRefreshOn: 'received', // received | sent | both
  debounceMs: 1200,

  // 自动追加到正文末尾
  autoAppendBox: true,
  appendMode: 'compact', // compact | standard
  appendDebounceMs: 700,

  // provider
  provider: 'st', // st | custom

  // custom API（建议填“API基础URL”，如 https://api.openai.com/v1 ）
  customEndpoint: '',
  customApiKey: '',
  customModel: 'gpt-4o-mini',
  customModelsCache: [],

  // custom advanced (hidden in UI for now)
  customTopP: 0.95,
  customMaxTokens: 8192,
});

const META_KEYS = Object.freeze({
  canon: 'storyguide_canon_outline',
  world: 'storyguide_world_setup',
});

let lastReport = null;
let lastJsonText = '';
let refreshTimer = null;
let appendTimer = null;

// -------------------- utils --------------------

function clone(obj) { try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); } }
function ensureSettings() {
  const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
    saveSettingsDebounced();
  } else {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) extensionSettings[MODULE_NAME][k] = DEFAULT_SETTINGS[k];
    }
  }
  return extensionSettings[MODULE_NAME];
}
function saveSettings() { SillyTavern.getContext().saveSettingsDebounced(); }
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
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) t = t.slice(first, last + 1);
  try { return JSON.parse(t); } catch { return null; }
}
function renderMarkdownToHtml(markdown) {
  const { showdown, DOMPurify } = SillyTavern.libs;
  const converter = new showdown.Converter({ simplifiedAutoLink: true, strikethrough: true, tables: true });
  const html = converter.makeHtml(markdown || '');
  return DOMPurify.sanitize(html);
}
function renderMarkdownInto($el, markdown) { $el.html(renderMarkdownToHtml(markdown)); }

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

// -------------------- prompt (database-like sections) --------------------

function spoilerPolicyText(level) {
  switch (level) {
    case 'none': return `【剧透策略】严格不剧透：不要透露原著明确未来事件与真相；只给“行动建议/风险提示”，避免点名关键反转。`;
    case 'full': return `【剧透策略】允许全剧透：可以直接指出原著后续的关键事件/真相，并解释如何影响当前路线。`;
    case 'mild':
    default: return `【剧透策略】轻剧透：可以用“隐晦提示 + 关键风险点”，避免把原著后续完整摊开；必要时可点到为止。`;
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
function buildPromptMessages(snapshotText, spoilerLevel, tipCount, mode /* panel|append */) {
  const compactHint = mode === 'append'
    ? `【输出偏好】更精简：current_scene 1~3句，next_events 2~4条，tips ${Math.min(tipCount, 3)}条。`
    : `【输出偏好】适度详细：current_scene 可 3~6句，next_events 3~6条，tips ${tipCount}条。`;

  const system = [
    `---BEGIN PROMPT---`,
    `[System]`,
    `你是执行型“剧情指导/编剧顾问”。从“正在经历的世界”（聊天+设定）提炼结构，并给出后续引导。`,
    spoilerPolicyText(spoilerLevel),
    compactHint,
    ``,
    `[Constraints]`,
    `1) 不要凭空杜撰世界观/人物/地点；不确定写“未知/待确认”。`,
    `2) 不要复述流水账；只提炼关键矛盾、动机、风险与走向。`,
    `3) 输出必须是 JSON 对象本体（无 Markdown、无代码块、无多余解释）。`,
    ``,
    `[Output Fields]`,
    `- world_summary: 1~3句，概括世界与局势`,
    `- key_plot_points: 3~8条关键剧情点（短句）`,
    `- current_scene: 当前时间点发生了什么（地点/人物动机/冲突/悬念）`,
    `- next_events: 接下来最可能发生的事（条目）`,
    `- protagonist_impact: 主角行为对剧情/关系/风险造成的改变`,
    `- tips: 可执行提示（尽量具体）`,
    `---END PROMPT---`
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: snapshotText }
  ];
}

// -------------------- snapshot --------------------

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

// -------------------- provider=st --------------------

async function callViaSillyTavern(messages, schema, temperature) {
  const ctx = SillyTavern.getContext();
  if (typeof ctx.generateRaw === 'function') return await ctx.generateRaw({ prompt: messages, jsonSchema: schema, temperature });
  if (typeof ctx.generateQuietPrompt === 'function') return await ctx.generateQuietPrompt({ messages, jsonSchema: schema, temperature });
  if (globalThis.TavernHelper && typeof globalThis.TavernHelper.generateRaw === 'function') {
    const txt = await globalThis.TavernHelper.generateRaw({ ordered_prompts: messages, should_stream: false });
    return String(txt || '');
  }
  throw new Error('未找到可用的生成函数（generateRaw/generateQuietPrompt）。');
}

async function fallbackAskJson(messages, temperature) {
  const ctx = SillyTavern.getContext();
  const retry = clone(messages);
  retry.unshift({ role: 'system', content: `再次强调：只输出 JSON 对象本体，不要任何额外文字。` });
  if (typeof ctx.generateRaw === 'function') return await ctx.generateRaw({ prompt: retry, temperature });
  if (typeof ctx.generateQuietPrompt === 'function') return await ctx.generateQuietPrompt({ messages: retry, temperature });
  throw new Error('fallback 失败：缺少 generateRaw/generateQuietPrompt');
}

// -------------------- custom provider: prefer ST backend proxy --------------------

function normalizeBaseUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  u = u.replace(/\/+$/, '');

  // if user pasted full completions url, trim it
  u = u.replace(/\/v1\/chat\/completions$/i, '');
  u = u.replace(/\/chat\/completions$/i, '');
  u = u.replace(/\/v1\/completions$/i, '');
  u = u.replace(/\/completions$/i, '');

  return u;
}

function deriveChatCompletionsUrl(base) {
  // for direct browser fallback
  const u = normalizeBaseUrl(base);
  if (!u) return '';
  if (/\/v1$/.test(u)) return u + '/chat/completions';
  if (/\/v1\/?$/.test(u)) return u.replace(/\/+$/, '') + '/chat/completions';
  // if already contains /v1 somewhere, try append
  if (/\/v1\b/i.test(u)) return u.replace(/\/+$/, '') + '/chat/completions';
  return u + '/v1/chat/completions';
}

async function callViaCustomBackendProxy(apiBaseUrl, apiKey, model, messages, temperature, maxTokens, topP) {
  const url = '/api/backends/chat-completions/generate';

  const requestBody = {
    messages,
    model: String(model || '').replace(/^models\//, '') || 'gpt-4o-mini',
    max_tokens: maxTokens ?? 8192,
    temperature: temperature ?? 0.7,
    top_p: topP ?? 0.95,
    stream: false,
    chat_completion_source: 'custom',
    group_names: [],
    include_reasoning: false,
    reasoning_effort: 'medium',
    enable_web_search: false,
    request_images: false,
    custom_prompt_post_processing: 'strict',
    reverse_proxy: apiBaseUrl,
    proxy_password: '',
    custom_url: apiBaseUrl,
    custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : '',
  };

  const headers = { ...SillyTavern.getRequestHeaders(), 'Content-Type': 'application/json' };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`后端代理请求失败: HTTP ${res.status} ${res.statusText}\n${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (data?.choices?.[0]?.message?.content) return String(data.choices[0].message.content);
  if (typeof data?.content === 'string') return data.content;
  return JSON.stringify(data ?? '');
}

async function callViaCustomBrowserDirect(apiBaseUrl, apiKey, model, messages, temperature) {
  const endpoint = deriveChatCompletionsUrl(apiBaseUrl);
  if (!endpoint) throw new Error('custom 模式：API基础URL 为空');

  const body = { model, messages, temperature, stream: false };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`直连请求失败: HTTP ${res.status} ${res.statusText}\n${text}`);
  }
  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '');
}

async function callViaCustom(apiBaseUrl, apiKey, model, messages, temperature, maxTokens, topP) {
  const base = normalizeBaseUrl(apiBaseUrl);
  if (!base) throw new Error('custom 模式需要填写 API基础URL');

  // Prefer backend proxy; fallback if not supported
  try {
    return await callViaCustomBackendProxy(base, apiKey, model, messages, temperature, maxTokens, topP);
  } catch (e) {
    // If 404/405 likely endpoint missing; fallback to browser direct
    const status = e?.status;
    if (status === 404 || status === 405) {
      console.warn('[StoryGuide] backend proxy unavailable; fallback to browser direct');
      return await callViaCustomBrowserDirect(base, apiKey, model, messages, temperature);
    }
    throw e;
  }
}

// -------------------- report markdown --------------------

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

// -------------------- panel analysis --------------------

async function runAnalysis() {
  const s = ensureSettings();
  if (!s.enabled) { setStatus('插件未启用', 'warn'); return; }

  setStatus('分析中…', 'warn');
  $('#sg_analyze').prop('disabled', true);

  try {
    const { snapshotText, sourceSummary } = buildSnapshot();
    const tipCount = clampInt(s.tipCount, 1, 8, DEFAULT_SETTINGS.tipCount);
    const schema = buildSchema(tipCount);
    const messages = buildPromptMessages(snapshotText, s.spoilerLevel, tipCount, 'panel');

    let jsonText = '';
    if (s.provider === 'custom') {
      jsonText = await callViaCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, s.customMaxTokens, s.customTopP);
    } else {
      jsonText = await callViaSillyTavern(messages, schema, s.temperature);
      if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
      const parsedTry = safeJsonParse(jsonText);
      if (!parsedTry || Object.keys(parsedTry).length === 0) jsonText = await fallbackAskJson(messages, s.temperature);
    }

    const parsed = safeJsonParse(jsonText);
    lastJsonText = (parsed ? JSON.stringify(parsed, null, 2) : String(jsonText || ''));

    $('#sg_json').text(lastJsonText);
    $('#sg_src').text(JSON.stringify(sourceSummary, null, 2));

    if (!parsed) { showPane('json'); throw new Error('模型输出无法解析为 JSON（已切到 JSON 标签，看看原文）'); }

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

// -------------------- inline append --------------------

function buildInlineMarkdown(parsedJson) {
  const s = ensureSettings();
  const mode = s.appendMode || 'compact';
  const spoiler = s.spoilerLevel || 'mild';

  const w = parsedJson?.world_summary ?? '';
  const now = parsedJson?.current_scene ?? '';
  const impact = parsedJson?.protagonist_impact ?? '';
  const tips = Array.isArray(parsedJson?.tips) ? parsedJson.tips : [];
  const next = Array.isArray(parsedJson?.next_events) ? parsedJson.next_events : [];

  const lines = [];
  lines.push(`**剧情指导**（剧透：${spoiler}）`);
  if (w) lines.push(`- **世界**：${w}`);
  if (now) lines.push(`- **当前**：${now}`);

  if (mode === 'standard') {
    if (impact) lines.push(`- **影响**：${impact}`);
    if (next.length) lines.push(`- **后续**：${next.slice(0, 4).join(' / ')}`);
    if (tips.length) {
      lines.push(`- **提示**：`);
      tips.slice(0, 4).forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
    }
  } else {
    if (tips.length) lines.push(`- **提示**：${tips.slice(0, 3).join(' / ')}`);
    if (next.length) lines.push(`- **走向**：${next.slice(0, 2).join(' / ')}`);
  }
  return lines.join('\n');
}

function appendInlineBoxToLastAssistant(htmlInner) {
  const nodes = Array.from(document.querySelectorAll('.mes'));
  for (let i = nodes.length - 1; i >= 0; i--) {
    const mes = nodes[i];
    if (!mes) continue;
    if (mes.classList.contains('mes_user')) continue;

    const textEl = mes.querySelector('.mes_text');
    if (!textEl) continue;
    if (textEl.querySelector('.sg-inline-box')) return false;

    const box = document.createElement('div');
    box.className = 'sg-inline-box';
    box.innerHTML = `
      <div class="sg-inline-head">
        <span class="sg-inline-badge">📘</span>
        <span class="sg-inline-title">剧情指导</span>
        <span class="sg-inline-sub">（自动分析）</span>
      </div>
      <div class="sg-inline-body">${htmlInner}</div>
    `.trim();

    textEl.appendChild(box);
    return true;
  }
  return false;
}

async function runInlineAppend() {
  const s = ensureSettings();
  if (!s.enabled || !s.autoAppendBox) return;

  try {
    const { snapshotText } = buildSnapshot();

    const tipCount = clampInt(s.tipCount, 1, 8, DEFAULT_SETTINGS.tipCount);
    const inlineTipCount = Math.min(tipCount, s.appendMode === 'standard' ? 4 : 3);

    const schema = buildSchema(inlineTipCount);
    const messages = buildPromptMessages(snapshotText, s.spoilerLevel, inlineTipCount, 'append');

    let jsonText = '';
    if (s.provider === 'custom') {
      jsonText = await callViaCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, Math.min(s.customMaxTokens, 4096), s.customTopP);
    } else {
      jsonText = await callViaSillyTavern(messages, schema, s.temperature);
      if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
      const parsedTry = safeJsonParse(jsonText);
      if (!parsedTry || Object.keys(parsedTry).length === 0) jsonText = await fallbackAskJson(messages, s.temperature);
    }

    const parsed = safeJsonParse(jsonText);
    if (!parsed) return;

    const md = buildInlineMarkdown(parsed);
    const innerHtml = renderMarkdownToHtml(md);
    requestAnimationFrame(() => { appendInlineBoxToLastAssistant(innerHtml); });
  } catch (e) {
    console.warn('[StoryGuide] inline append failed:', e);
  }
}

function scheduleInlineAppend() {
  const s = ensureSettings();
  const delay = clampInt(s.appendDebounceMs, 150, 5000, DEFAULT_SETTINGS.appendDebounceMs);
  if (appendTimer) clearTimeout(appendTimer);
  appendTimer = setTimeout(() => {
    runInlineAppend().catch(() => void 0);
    appendTimer = null;
  }, delay);
}

// -------------------- models refresh (custom) --------------------

async function refreshModels() {
  const s = ensureSettings();
  const raw = String($('#sg_customEndpoint').val() || s.customEndpoint || '').trim();
  const apiBase = normalizeBaseUrl(raw);
  if (!apiBase) { setStatus('请先填写 API基础URL 再刷新模型', 'warn'); return; }

  setStatus('正在刷新模型列表…', 'warn');

  // Prefer ST backend status endpoint
  const statusUrl = '/api/backends/chat-completions/status';
  const apiKey = String($('#sg_customApiKey').val() || s.customApiKey || '');

  const body = {
    reverse_proxy: apiBase,
    proxy_password: '',
    chat_completion_source: 'custom',
    custom_url: apiBase,
    custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : ''
  };

  try {
    const headers = { ...SillyTavern.getRequestHeaders(), 'Content-Type': 'application/json' };
    const res = await fetch(statusUrl, { method: 'POST', headers, body: JSON.stringify(body) });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`状态检查失败: HTTP ${res.status} ${res.statusText}\n${txt}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json().catch(() => ({}));

    let modelsList = [];
    if (data && data.models && Array.isArray(data.models)) modelsList = data.models;
    else if (data && data.data && Array.isArray(data.data)) modelsList = data.data;
    else if (Array.isArray(data)) modelsList = data;

    let ids = [];
    if (modelsList.length) ids = modelsList.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);

    ids = Array.from(new Set(ids)).sort((a,b) => String(a).localeCompare(String(b)));

    if (!ids.length) {
      setStatus('刷新成功，但未解析到模型列表（返回格式不兼容）', 'warn');
      return;
    }

    s.customModelsCache = ids;
    saveSettings();
    fillModelSelect(ids, s.customModel);
    setStatus(`已刷新模型：${ids.length} 个（走后端代理）`, 'ok');
    return;
  } catch (e) {
    const status = e?.status;
    if (status === 404 || status === 405) {
      // fallback: direct browser fetch /models
      console.warn('[StoryGuide] status endpoint unavailable; fallback to direct /models');
    } else {
      // other errors: still allow fallback attempt, but show warn after
      console.warn('[StoryGuide] status check failed; fallback to direct /models', e);
    }
  }

  // Fallback: direct browser request to /models
  try {
    const modelsUrl = (function deriveModelsUrl(base) {
      const u = normalizeBaseUrl(base);
      if (!u) return '';
      if (/\/v1$/.test(u)) return u + '/models';
      if (/\/v1\b/i.test(u)) return u.replace(/\/+$/, '') + '/models';
      return u + '/v1/models';
    })(apiBase);

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(modelsUrl, { method: 'GET', headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`直连 /models 失败: HTTP ${res.status} ${res.statusText}\n${txt}`);
    }
    const data = await res.json().catch(() => ({}));

    let modelsList = [];
    if (data && data.models && Array.isArray(data.models)) modelsList = data.models;
    else if (data && data.data && Array.isArray(data.data)) modelsList = data.data;
    else if (Array.isArray(data)) modelsList = data;

    let ids = [];
    if (modelsList.length) ids = modelsList.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
    ids = Array.from(new Set(ids)).sort((a,b) => String(a).localeCompare(String(b)));

    if (!ids.length) { setStatus('直连刷新失败：未解析到模型列表', 'warn'); return; }

    s.customModelsCache = ids;
    saveSettings();
    fillModelSelect(ids, s.customModel);
    setStatus(`已刷新模型：${ids.length} 个（直连 fallback）`, 'ok');
  } catch (e) {
    setStatus(`刷新模型失败：${e?.message ?? e}`, 'err');
  }
}

function fillModelSelect(modelIds, selected) {
  const $sel = $('#sg_modelSelect');
  if (!$sel.length) return;
  $sel.empty();
  $sel.append(`<option value="">（选择模型）</option>`);
  (modelIds || []).forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    if (selected && id === selected) opt.selected = true;
    $sel.append(opt);
  });
}

// -------------------- UI --------------------

function findTopbarContainer() {
  const extBtn =
    document.querySelector('#extensions_button') ||
    document.querySelector('[data-i18n="Extensions"]') ||
    document.querySelector('button[title*="Extensions"]') ||
    document.querySelector('button[aria-label*="Extensions"]');
  if (extBtn && extBtn.parentElement) return extBtn.parentElement;

  const candidates = ['#top-bar', '#topbar', '#topbar_buttons', '#topbar-buttons', '.topbar', '.topbar_buttons', '.top-bar', '.top-bar-buttons', '#rightNav', '#top-right', '#toolbar'];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function createTopbarButton() {
  if (document.getElementById('sg_topbar_btn')) return;
  const container = findTopbarContainer();
  const btn = document.createElement('button');
  btn.id = 'sg_topbar_btn';
  btn.type = 'button';
  btn.className = 'sg-topbar-btn';
  btn.title = '剧情指导 StoryGuide';
  btn.innerHTML = '<span class="sg-topbar-icon">📘</span>';
  btn.addEventListener('click', () => openModal());

  if (container) {
    const sample = container.querySelector('button');
    if (sample && sample.className) btn.className = sample.className + ' sg-topbar-btn';
    container.appendChild(btn);
  } else {
    btn.className += ' sg-topbar-fallback';
    document.body.appendChild(btn);
  }
}

function buildModalHtml() {
  return `
  <div id="sg_modal_backdrop" class="sg-backdrop" style="display:none;">
    <div id="sg_modal" class="sg-modal" role="dialog" aria-modal="true">
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
                  <option value="custom">独立API（走酒馆后端代理，减少跨域）</option>
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
              <label class="sg-check"><input type="checkbox" id="sg_autoRefresh">自动刷新面板报告</label>
              <select id="sg_autoRefreshOn">
                <option value="received">AI回复时</option>
                <option value="sent">用户发送时</option>
                <option value="both">两者都触发</option>
              </select>
            </div>

            <div class="sg-row sg-inline">
              <label class="sg-check"><input type="checkbox" id="sg_autoAppendBox">自动追加分析框到回复末尾</label>
              <select id="sg_appendMode">
                <option value="compact">简洁</option>
                <option value="standard">标准</option>
              </select>
            </div>

            <div id="sg_custom_block" class="sg-card sg-subcard" style="display:none;">
              <div class="sg-card-title">独立API 设置（建议填 API基础URL）</div>

              <div class="sg-field">
                <label>API基础URL（例如 https://api.openai.com/v1 ）</label>
                <input id="sg_customEndpoint" type="text" placeholder="https://xxx.com/v1">
                <div class="sg-hint sg-warn">优先走酒馆后端代理接口（/api/backends/...），比浏览器直连更不容易跨域/连不上。</div>
              </div>

              <div class="sg-grid2">
                <div class="sg-field">
                  <label>API Key（可选）</label>
                  <input id="sg_customApiKey" type="password" placeholder="可留空">
                </div>

                <div class="sg-field">
                  <label>模型（可手填）</label>
                  <input id="sg_customModel" type="text" placeholder="gpt-4o-mini">
                </div>
              </div>

              <div class="sg-row sg-inline">
                <button class="menu_button sg-btn" id="sg_refreshModels">检查/刷新模型</button>
                <select id="sg_modelSelect" class="sg-model-select">
                  <option value="">（选择模型）</option>
                </select>
                <span class="sg-hint">（优先走后端 status；不支持则 fallback 直连 /models）</span>
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
  if (document.getElementById('sg_modal_backdrop')) return;
  document.body.insertAdjacentHTML('beforeend', buildModalHtml());

  $('#sg_modal_backdrop').on('click', (e) => { if (e.target && e.target.id === 'sg_modal_backdrop') closeModal(); });
  $('#sg_close').on('click', closeModal);

  $('#sg_tab_md').on('click', () => showPane('md'));
  $('#sg_tab_json').on('click', () => showPane('json'));
  $('#sg_tab_src').on('click', () => showPane('src'));

  $('#sg_saveSettings').on('click', () => { pullUiToSettings(); saveSettings(); setStatus('已保存设置', 'ok'); });
  $('#sg_analyze').on('click', async () => { pullUiToSettings(); saveSettings(); await runAnalysis(); });

  $('#sg_saveWorld').on('click', async () => {
    try { await setChatMetaValue(META_KEYS.world, String($('#sg_worldText').val() || '')); setStatus('已保存：世界观/设定补充（本聊天）', 'ok'); }
    catch (e) { setStatus(`保存失败：${e?.message ?? e}`, 'err'); }
  });
  $('#sg_saveCanon').on('click', async () => {
    try { await setChatMetaValue(META_KEYS.canon, String($('#sg_canonText').val() || '')); setStatus('已保存：原著后续/大纲（本聊天）', 'ok'); }
    catch (e) { setStatus(`保存失败：${e?.message ?? e}`, 'err'); }
  });

  $('#sg_copyMd').on('click', async () => {
    try { await navigator.clipboard.writeText(lastReport?.markdown ?? ''); setStatus('已复制：Markdown 报告', 'ok'); }
    catch (e) { setStatus(`复制失败：${e?.message ?? e}`, 'err'); }
  });
  $('#sg_copyJson').on('click', async () => {
    try { await navigator.clipboard.writeText(lastJsonText || ''); setStatus('已复制：JSON', 'ok'); }
    catch (e) { setStatus(`复制失败：${e?.message ?? e}`, 'err'); }
  });
  $('#sg_injectTips').on('click', () => {
    const tips = Array.isArray(lastReport?.json?.tips) ? lastReport.json.tips : [];
    const spoiler = ensureSettings().spoilerLevel;
    const text = tips.length
      ? `/sys 【剧情指导提示｜${spoiler}】\n` + tips.map((t, i) => `${i + 1}. ${t}`).join('\n')
      : (lastReport?.markdown ?? '');

    const $ta = $('#send_textarea');
    if ($ta.length) { $ta.val(text).trigger('input'); setStatus('已把提示放入输入框（你可以手动发送）', 'ok'); }
    else setStatus('找不到输入框 #send_textarea，无法注入', 'err');
  });

  $('#sg_provider').on('change', () => {
    const provider = String($('#sg_provider').val());
    $('#sg_custom_block').toggle(provider === 'custom');
  });

  $('#sg_refreshModels').on('click', async () => {
    pullUiToSettings(); saveSettings();
    await refreshModels();
  });

  $('#sg_modelSelect').on('change', () => {
    const id = String($('#sg_modelSelect').val() || '').trim();
    if (id) $('#sg_customModel').val(id);
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

  $('#sg_autoAppendBox').prop('checked', !!s.autoAppendBox);
  $('#sg_appendMode').val(s.appendMode);

  $('#sg_customEndpoint').val(s.customEndpoint);
  $('#sg_customApiKey').val(s.customApiKey);
  $('#sg_customModel').val(s.customModel);

  fillModelSelect(Array.isArray(s.customModelsCache) ? s.customModelsCache : [], s.customModel);

  $('#sg_worldText').val(getChatMetaValue(META_KEYS.world));
  $('#sg_canonText').val(getChatMetaValue(META_KEYS.canon));

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

  s.autoAppendBox = $('#sg_autoAppendBox').is(':checked');
  s.appendMode = String($('#sg_appendMode').val() || 'compact');

  s.customEndpoint = String($('#sg_customEndpoint').val() || '').trim();
  s.customApiKey = String($('#sg_customApiKey').val() || '');
  s.customModel = String($('#sg_customModel').val() || '').trim();
}

function openModal() {
  ensureModal();
  pullSettingsToUi();
  setStatus('', '');
  $('#sg_modal_backdrop').show();
  showPane('md');
}
function closeModal() { $('#sg_modal_backdrop').hide(); }

// minimal settings entry
function injectMinimalSettingsPanel() {
  const $root = $('#extensions_settings');
  if (!$root.length) return;
  if ($('#sg_settings_panel_min').length) return;

  $root.append(`
    <div class="sg-panel-min" id="sg_settings_panel_min">
      <div class="sg-min-row">
        <div class="sg-min-title">剧情指导 StoryGuide</div>
        <button class="menu_button sg-btn" id="sg_open_from_settings">打开面板</button>
      </div>
      <div class="sg-min-hint">也可从顶栏 📘 打开。独立API优先走酒馆后端代理，减少连不上/跨域。</div>
    </div>
  `);
  $('#sg_open_from_settings').on('click', () => openModal());
}

// auto refresh panel only when open
function scheduleAutoRefresh() {
  const s = ensureSettings();
  if (!s.enabled || !s.autoRefresh) return;
  const delay = clampInt(s.debounceMs, 300, 10000, DEFAULT_SETTINGS.debounceMs);

  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (document.getElementById('sg_modal_backdrop') && $('#sg_modal_backdrop').is(':visible')) runAnalysis().catch(() => void 0);
    refreshTimer = null;
  }, delay);
}

// -------------------- events --------------------

function setupEventListeners() {
  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    eventSource.on(event_types.CHAT_CHANGED, () => {
      if (document.getElementById('sg_modal_backdrop') && $('#sg_modal_backdrop').is(':visible')) {
        pullSettingsToUi();
        setStatus('已切换聊天：已同步本聊天字段', 'ok');
      }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
      const s = ensureSettings();
      if (s.autoAppendBox) scheduleInlineAppend();
      if (s.autoRefresh && (s.autoRefreshOn === 'received' || s.autoRefreshOn === 'both')) scheduleAutoRefresh();
    });

    eventSource.on(event_types.MESSAGE_SENT, () => {
      const s = ensureSettings();
      if (s.autoRefresh && (s.autoRefreshOn === 'sent' || s.autoRefreshOn === 'both')) scheduleAutoRefresh();
    });
  });
}

// -------------------- init --------------------

function init() {
  ensureSettings();
  setupEventListeners();

  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    createTopbarButton();
    injectMinimalSettingsPanel();
  });

  globalThis.StoryGuide = {
    open: openModal,
    close: closeModal,
    runAnalysis,
    runInlineAppend,
    buildSnapshot: () => buildSnapshot(),
    getLastReport: () => lastReport,
    refreshModels
  };
}
init();
