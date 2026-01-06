'use strict';

/**
 * 剧情指导 StoryGuide (SillyTavern UI Extension)
 * v0.5.3
 *
 * 新增：输出模块自定义（更高自由度）
 * - 你可以自定义“输出模块列表”以及每个模块自己的提示词（prompt）
 * - 面板提供一个「模块配置(JSON)」编辑区：可增删字段、改顺序、改提示词、控制是否在面板/自动追加中展示
 * - 插件会根据模块自动生成 JSON Schema（动态字段）并要求模型按该 Schema 输出
 *
 * 兼容：仍然保持 v0.3.x 的“独立API走后端代理 + 抗变量更新覆盖（自动补贴）+ 点击折叠”能力
 */

const MODULE_NAME = 'storyguide';

/**
 * 模块配置格式（JSON 数组）示例：
 * [
 *   {"key":"world_summary","title":"世界简介","type":"text","prompt":"1~3句概括世界与局势","required":true,"panel":true,"inline":true},
 *   {"key":"key_plot_points","title":"重要剧情点","type":"list","prompt":"3~8条关键剧情点（短句）","maxItems":8,"required":true,"panel":true,"inline":false}
 * ]
 *
 * 字段说明：
 * - key: JSON 输出字段名（唯一）
 * - title: 渲染到报告的标题
 * - type: "text" 或 "list"（list = string[]）
 * - prompt: 该模块的生成提示词（会写进 Output Fields）
 * - required: 是否强制要求该字段输出
 * - panel: 是否在“报告”里展示
 * - inline: 是否在“自动追加分析框”里展示
 * - maxItems: type=list 时限制最大条目（可选）
 */

const DEFAULT_MODULES = Object.freeze([
  { key: 'world_summary', title: '世界简介', type: 'text', prompt: '1~3句概括世界与局势', required: true, panel: true, inline: true },
  { key: 'key_plot_points', title: '重要剧情点', type: 'list', prompt: '3~8条关键剧情点（短句）', maxItems: 8, required: true, panel: true, inline: false },
  { key: 'current_scene', title: '当前时间点 · 具体剧情', type: 'text', prompt: '描述当前发生了什么（地点/人物动机/冲突/悬念）', required: true, panel: true, inline: true },
  { key: 'next_events', title: '后续将会发生的事', type: 'list', prompt: '接下来最可能发生的事（条目）', maxItems: 6, required: true, panel: true, inline: true },
  { key: 'protagonist_impact', title: '主角行为造成的影响', type: 'text', prompt: '主角行为对剧情/关系/风险造成的改变', required: true, panel: true, inline: false },
  { key: 'tips', title: '给主角的提示（基于原著后续/大纲）', type: 'list', prompt: '给出可执行提示（尽量具体）', maxItems: 4, required: true, panel: true, inline: true },
]);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,

  // 输入截取
  maxMessages: 40,
  maxCharsPerMessage: 1600,
  includeUser: true,
  includeAssistant: true,

  // 生成控制（仍保留剧透与 temperature；更多风格可通过自定义 system/constraints 做）
  spoilerLevel: 'mild', // none | mild | full
  temperature: 0.4,

  // 自动刷新（面板报告）
  autoRefresh: false,
  autoRefreshOn: 'received', // received | sent | both
  debounceMs: 1200,

  // 自动追加到正文末尾
  autoAppendBox: true,
  appendMode: 'compact', // compact | standard
  appendFieldsSource: 'inline', // inline | panel
  appendDebounceMs: 700,

  // provider
  provider: 'st', // st | custom

  // custom API（建议填“API基础URL”，如 https://api.openai.com/v1 ）
  customEndpoint: '',
  customApiKey: '',
  customModel: 'gpt-4o-mini',
  customModelsCache: [],
  customTopP: 0.95,
  customMaxTokens: 8192,

  // 预设导入/导出
  presetIncludeApiKey: false,

  // 世界书（World Info/Lorebook）导入与注入
  worldbookEnabled: false,
  worldbookMode: 'active', // active | all
  worldbookInsertPos: 'afterCanon', // afterWorld | afterCanon | beforeChat
  worldbookMaxChars: 6000,
  worldbookWindowMessages: 18,
  worldbookJson: '',

  // 模块自定义（JSON 字符串 + 解析备份）
  modulesJson: '',
  // 额外可自定义提示词“骨架”
  customSystemPreamble: '',     // 附加在默认 system 之后
  customConstraints: '',        // 附加在默认 constraints 之后
});

const META_KEYS = Object.freeze({
  canon: 'storyguide_canon_outline',
  world: 'storyguide_world_setup',
});

let lastReport = null;
let lastWorldbookStats = null;
let lastJsonText = '';
let refreshTimer = null;
let appendTimer = null;

// ============== 关键：DOM 追加缓存 & 观察者（抗重渲染） ==============
/**
 * inlineCache: Map<mesKey, { htmlInner: string, collapsed: boolean, createdAt: number }>
 * mesKey 优先用 DOM 的 mesid（如果拿不到则用 chatIndex）
 */
const inlineCache = new Map();
let chatDomObserver = null;
let bodyDomObserver = null;
let reapplyTimer = null;

// -------------------- ST request headers compatibility --------------------
function getCsrfTokenCompat() {
  const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrf_token"], meta[name="csrfToken"]');
  if (meta && meta.content) return meta.content;
  const ctx = SillyTavern.getContext?.() ?? {};
  return ctx.csrfToken || ctx.csrf_token || globalThis.csrf_token || globalThis.csrfToken || '';
}

function getStRequestHeadersCompat() {
  const ctx = SillyTavern.getContext?.() ?? {};
  let h = {};
  try {
    if (typeof SillyTavern.getRequestHeaders === 'function') h = SillyTavern.getRequestHeaders();
    else if (typeof ctx.getRequestHeaders === 'function') h = ctx.getRequestHeaders();
    else if (typeof globalThis.getRequestHeaders === 'function') h = globalThis.getRequestHeaders();
  } catch { h = {}; }

  h = { ...(h || {}) };

  const token = getCsrfTokenCompat();
  if (token) {
    if (!('X-CSRF-Token' in h) && !('X-CSRF-TOKEN' in h) && !('x-csrf-token' in h)) {
      h['X-CSRF-Token'] = token;
    }
  }
  return h;
}

// -------------------- utils --------------------

function clone(obj) { try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); } }

function ensureSettings() {
  const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
    // 初始写入默认 modulesJson
    extensionSettings[MODULE_NAME].modulesJson = JSON.stringify(DEFAULT_MODULES, null, 2);
    saveSettingsDebounced();
  } else {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) extensionSettings[MODULE_NAME][k] = DEFAULT_SETTINGS[k];
    }
    // 兼容旧版：若 modulesJson 为空，补默认
    if (!extensionSettings[MODULE_NAME].modulesJson) {
      extensionSettings[MODULE_NAME].modulesJson = JSON.stringify(DEFAULT_MODULES, null, 2);
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


function renderWorldbookInfoText() {
  const s = ensureSettings();
  let count = 0;
  try { count = parseWorldbookJson(String(s.worldbookJson || '')).length; } catch { count = 0; }

  if (!count) return '（未导入世界书）';

  let txt = `已导入世界书：${count} 条`;
  if (!s.worldbookEnabled) return txt + '（未启用注入）';

  const st = lastWorldbookStats;
  if (st) {
    txt += ` | 上次注入：${st.injectedEntries}/${st.matchedEntries} 条`;
    txt += ` | 字符：${st.injectedChars}/${st.maxChars}`;
    txt += ` | tokens≈${st.injectedTokens}`;
  }
  txt += ` | 位置：${String(s.worldbookInsertPos || 'afterCanon')}`;
  return txt;
}

function refreshWorldbookInfoLabel() {
  const $el = $('#sg_worldbookInfo');
  if (!$el.length) return;
  try { $el.text(renderWorldbookInfoText()); } catch { /* ignore */ }
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

// -------------------- modules config --------------------

function validateAndNormalizeModules(raw) {
  const mods = Array.isArray(raw) ? raw : null;
  if (!mods) return { ok: false, error: '模块配置必须是 JSON 数组。', modules: null };

  const seen = new Set();
  const normalized = [];

  for (const m of mods) {
    if (!m || typeof m !== 'object') continue;
    const key = String(m.key || '').trim();
    if (!key) continue;
    if (seen.has(key)) return { ok: false, error: `模块 key 重复：${key}`, modules: null };
    seen.add(key);

    const type = String(m.type || 'text').trim();
    if (type !== 'text' && type !== 'list') return { ok: false, error: `模块 ${key} 的 type 必须是 "text" 或 "list"`, modules: null };

    const title = String(m.title || key).trim();
    const prompt = String(m.prompt || '').trim();

    const required = m.required !== false; // default true
    const panel = m.panel !== false;       // default true
    const inline = m.inline === true;      // default false unless explicitly true

    const maxItems = (type === 'list' && Number.isFinite(Number(m.maxItems))) ? clampInt(m.maxItems, 1, 50, 8) : undefined;

    normalized.push({ key, title, type, prompt, required, panel, inline, ...(maxItems ? { maxItems } : {}) });
  }

  if (!normalized.length) return { ok: false, error: '模块配置为空：至少需要 1 个模块。', modules: null };
  return { ok: true, error: '', modules: normalized };
}



// -------------------- presets & worldbook --------------------

function downloadTextFile(filename, text, mime='application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept || '';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(file);
    });
    input.click();
  });
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('FileReader error'));
    r.readAsText(file);
  });
}

// 尝试解析 SillyTavern 世界书导出 JSON（不同版本结构可能不同）
// 返回：[{ title, keys: string[], content: string }]
function parseWorldbookJson(rawText) {
  if (!rawText) return [];
  let data = null;
  try { data = JSON.parse(rawText); } catch { return []; }

  const candidates = [
    data?.entries,
    data?.world_info?.entries,
    data?.worldInfo?.entries,
    data?.lorebook?.entries,
    data?.data?.entries,
    data?.items,
    Array.isArray(data) ? data : null,
  ].filter(Boolean);

  let entries = null;
  for (const c of candidates) {
    if (Array.isArray(c)) { entries = c; break; }
  }
  if (!entries) return [];

  const norm = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;

    const title = String(e.title ?? e.name ?? e.comment ?? e.uid ?? '').trim();

    const kRaw = e.keys ?? e.key ?? e.keywords ?? e.trigger ?? e.triggers ?? e.pattern ?? e.match ?? e.tags ?? [];
    let keys = [];
    if (Array.isArray(kRaw)) keys = kRaw.map(x => String(x || '').trim()).filter(Boolean);
    else if (typeof kRaw === 'string') keys = kRaw.split(/[,，;；\n]/).map(s => s.trim()).filter(Boolean);

    const content = String(e.content ?? e.entry ?? e.text ?? e.description ?? e.desc ?? e.body ?? '').trim();
    if (!content) continue;

    norm.push({ title: title || (keys[0] ? `条目：${keys[0]}` : '条目'), keys, content });
  }
  return norm;
}

function selectActiveWorldbookEntries(entries, recentText) {
  const text = String(recentText || '').toLowerCase();
  if (!text) return [];
  const picked = [];
  for (const e of entries) {
    const keys = Array.isArray(e.keys) ? e.keys : [];
    if (!keys.length) continue;
    const hit = keys.some(k => k && text.includes(String(k).toLowerCase()));
    if (hit) picked.push(e);
  }
  return picked;
}


function countTokensCompat(text) {
  const t = String(text || '');
  if (!t) return 0;

  // 尝试使用酒馆/模型侧的 tokenizer（不同版本可能不同）
  const ctx = SillyTavern.getContext?.() ?? {};
  const candidates = [
    ctx.tokenizer,
    ctx.tokenizers?.main,
    globalThis.tokenizer,
    globalThis.tokenizers?.main,
    SillyTavern?.tokenizer,
    SillyTavern?.tokenizers?.main,
  ].filter(Boolean);

  for (const tok of candidates) {
    try {
      if (typeof tok.countTokens === 'function') return Number(tok.countTokens(t)) || 0;
      if (typeof tok.encode === 'function') {
        const enc = tok.encode(t);
        if (Array.isArray(enc)) return enc.length;
      }
    } catch { /* ignore */ }
  }

  // 兜底估算：中文大致 ~1字≈1token，英文 ~4字符≈1token
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const nonCjk = t.length - cjk;
  return Math.ceil(cjk * 1.0 + nonCjk / 4.0);
}


function buildWorldbookBlock() {
  const s = ensureSettings();

  // 默认先记录“未注入”状态，方便 UI 显示
  lastWorldbookStats = {
    enabled: !!s.worldbookEnabled,
    mode: String(s.worldbookMode || 'active'),
    insertPos: String(s.worldbookInsertPos || 'afterCanon'),
    totalEntries: 0,
    matchedEntries: 0,
    injectedEntries: 0,
    injectedChars: 0,
    injectedTokens: 0,
    maxChars: clampInt(s.worldbookMaxChars, 500, 50000, 6000),
    windowMessages: clampInt(s.worldbookWindowMessages, 5, 80, 18),
  };

  if (!s.worldbookEnabled) return '';
  const raw = String(s.worldbookJson || '').trim();
  if (!raw) return '';

  const entries = parseWorldbookJson(raw);
  lastWorldbookStats.totalEntries = entries.length;
  if (!entries.length) return '';

  // recent window text for activation
  const ctx = SillyTavern.getContext();
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const win = clampInt(s.worldbookWindowMessages, 5, 80, 18);
  const pickedMsgs = [];
  for (let i = chat.length - 1; i >= 0 && pickedMsgs.length < win; i--) {
    const m = chat[i];
    if (!m) continue;
    const t = stripHtml(m.mes ?? m.message ?? '');
    if (t) pickedMsgs.push(t);
  }
  const recentText = pickedMsgs.reverse().join('
');

  let use = entries;
  if (s.worldbookMode === 'active') {
    const act = selectActiveWorldbookEntries(entries, recentText);
    use = act.length ? act : [];
  }

  lastWorldbookStats.matchedEntries = use.length;
  if (!use.length) return '';

  const maxChars = clampInt(s.worldbookMaxChars, 500, 50000, 6000);
  let acc = '';
  let injected = 0;

  for (const e of use) {
    const head = `- 【${e.title}】${(e.keys && e.keys.length) ? `（触发：${e.keys.slice(0,6).join(' / ')}）` : ''}
`;
    const body = e.content.trim() + '
';
    const chunk = head + body + '
';
    if ((acc.length + chunk.length) > maxChars) break;
    acc += chunk;
    injected += 1;
  }

  lastWorldbookStats.injectedEntries = injected;
  lastWorldbookStats.injectedChars = acc.length;
  lastWorldbookStats.injectedTokens = countTokensCompat(acc);

  if (!acc) return '';
  return `
【世界书/World Info（注入：${injected}条；字符：${acc.length}；tokens≈${lastWorldbookStats.injectedTokens}；模式：${s.worldbookMode}）】
${acc}
`;
}
function getModules(mode /* panel|append */) {
  const s = ensureSettings();
  const rawText = String(s.modulesJson || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch { parsed = null; }

  const v = validateAndNormalizeModules(parsed);
  const base = v.ok ? v.modules : clone(DEFAULT_MODULES);

  if (mode === 'append') {
    const src = String(s.appendFieldsSource || 'inline');
    return (src === 'panel') ? base.filter(m => m.panel) : base.filter(m => m.inline);
  }
  return base.filter(m => m.panel); // panel
}

// -------------------- prompt (database-like skeleton + modules) --------------------

function spoilerPolicyText(level) {
  switch (level) {
    case 'none': return `【剧透策略】严格不剧透：不要透露原著明确未来事件与真相；只给“行动建议/风险提示”，避免点名关键反转。`;
    case 'full': return `【剧透策略】允许全剧透：可以直接指出原著后续的关键事件/真相，并解释如何影响当前路线。`;
    case 'mild':
    default: return `【剧透策略】轻剧透：可以用“隐晦提示 + 关键风险点”，避免把原著后续完整摊开；必要时可点到为止。`;
  }
}

function buildSchemaFromModules(modules) {
  const properties = {};
  const required = [];

  for (const m of modules) {
    if (m.type === 'list') {
      properties[m.key] = {
        type: 'array',
        items: { type: 'string' },
        ...(m.maxItems ? { maxItems: m.maxItems } : {}),
        minItems: 0
      };
    } else {
      properties[m.key] = { type: 'string' };
    }
    if (m.required) required.push(m.key);
  }

  return {
    name: 'StoryGuideDynamicReport',
    description: '剧情指导动态输出（按模块配置生成）',
    strict: true,
    value: {
      '$schema': 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      additionalProperties: false,
      properties,
      required
    }
  };
}

function buildOutputFieldsText(modules) {
  // 每个模块一行：key: title — prompt
  const lines = [];
  for (const m of modules) {
    const p = m.prompt ? ` — ${m.prompt}` : '';
    const t = m.title ? `（${m.title}）` : '';
    if (m.type === 'list') {
      lines.push(`- ${m.key}${t}: string[]${m.maxItems ? ` (<=${m.maxItems})` : ''}${p}`);
    } else {
      lines.push(`- ${m.key}${t}: string${p}`);
    }
  }
  return lines.join('\n');
}

function buildPromptMessages(snapshotText, spoilerLevel, modules, mode /* panel|append */) {
  const s = ensureSettings();
  const compactHint = mode === 'append'
    ? `【输出偏好】更精简：少废话、少铺垫、直给关键信息。`
    : `【输出偏好】适度详细：以“可执行引导”为主，不要流水账。`;

  const extraSystem = String(s.customSystemPreamble || '').trim();
  const extraConstraints = String(s.customConstraints || '').trim();

  const system = [
    `---BEGIN PROMPT---`,
    `[System]`,
    `你是执行型“剧情指导/编剧顾问”。从“正在经历的世界”（聊天+设定）提炼结构，并给出后续引导。`,
    spoilerPolicyText(spoilerLevel),
    compactHint,
    extraSystem ? `\n【自定义 System 补充】\n${extraSystem}` : ``,
    ``,
    `[Constraints]`,
    `1) 不要凭空杜撰世界观/人物/地点；不确定写“未知/待确认”。`,
    `2) 不要复述流水账；只提炼关键矛盾、动机、风险与走向。`,
    `3) 输出必须是 JSON 对象本体（无 Markdown、无代码块、无多余解释）。`,
    `4) 只输出下面列出的字段，不要额外字段。`,
    extraConstraints ? `\n【自定义 Constraints 补充】\n${extraConstraints}` : ``,
    ``,
    `[Output Fields]`,
    buildOutputFieldsText(modules),
    `---END PROMPT---`
  ].filter(Boolean).join('\n');

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
  } catch (e) { console.warn('[StoryGuide] character read failed:', e); }

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
    characterSelected: ctx.characterId !== undefined && ctx.characterId !== null,
    hasWorldbook: !!(s.worldbookEnabled && String(s.worldbookJson || '').trim()),
    worldbookMode: String(s.worldbookMode || 'active'),
    worldbookInsertPos: String(s.worldbookInsertPos || 'afterCanon'),
    worldbookInjectedEntries: lastWorldbookStats?.injectedEntries ?? 0,
    worldbookInjectedChars: lastWorldbookStats?.injectedChars ?? 0,
    worldbookInjectedTokens: lastWorldbookStats?.injectedTokens ?? 0
  };

  const worldbookBlock = buildWorldbookBlock();

  const snapshotText = [
    `【任务】你是“剧情指导”。根据下方“正在经历的世界”（聊天 + 设定）输出结构化报告。`,
    ``,
    charBlock ? charBlock : `【角色卡】（未获取到/可能是群聊）`,
    ``,
    world ? `【世界观/设定补充】\n${world}\n` : `【世界观/设定补充】（未提供）\n`,
    (s.worldbookInsertPos === 'afterWorld' ? worldbookBlock : ''),
    canon ? `【原著后续/大纲】\n${canon}\n` : `【原著后续/大纲】（未提供）\n`,
    (s.worldbookInsertPos === 'afterCanon' ? worldbookBlock : ''),
    (s.worldbookInsertPos === 'beforeChat' ? worldbookBlock : ''),
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

// -------------------- custom provider (proxy-first) --------------------

function normalizeBaseUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/v1\/chat\/completions$/i, '');
  u = u.replace(/\/chat\/completions$/i, '');
  u = u.replace(/\/v1\/completions$/i, '');
  u = u.replace(/\/completions$/i, '');
  return u;
}
function deriveChatCompletionsUrl(base) {
  const u = normalizeBaseUrl(base);
  if (!u) return '';
  if (/\/v1$/.test(u)) return u + '/chat/completions';
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
    reverse_proxy: apiBaseUrl,
    custom_url: apiBaseUrl,
    custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : '',
  };

  const headers = { ...getStRequestHeadersCompat(), 'Content-Type': 'application/json' };
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

  try {
    return await callViaCustomBackendProxy(base, apiKey, model, messages, temperature, maxTokens, topP);
  } catch (e) {
    const status = e?.status;
    if (status === 404 || status === 405) {
      console.warn('[StoryGuide] backend proxy unavailable; fallback to browser direct');
      return await callViaCustomBrowserDirect(base, apiKey, model, messages, temperature);
    }
    throw e;
  }
}

// -------------------- render report from modules --------------------

function renderReportMarkdownFromModules(parsedJson, modules) {
  const lines = [];
  lines.push(`# 剧情指导报告`);
  lines.push('');

  for (const m of modules) {
    const val = parsedJson?.[m.key];
    lines.push(`## ${m.title || m.key}`);

    if (m.type === 'list') {
      const arr = Array.isArray(val) ? val : [];
      if (!arr.length) {
        lines.push('（空）');
      } else {
        // tips 用有序列表更舒服
        if (m.key === 'tips') {
          arr.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
        } else {
          arr.forEach(t => lines.push(`- ${t}`));
        }
      }
    } else {
      lines.push(val ? String(val) : '（空）');
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// -------------------- panel analysis --------------------

async function runAnalysis() {
  const s = ensureSettings();
  if (!s.enabled) { setStatus('插件未启用', 'warn'); return; }

  setStatus('分析中…', 'warn');
  $('#sg_analyze').prop('disabled', true);

  try {
    const { snapshotText, sourceSummary } = buildSnapshot();
    const modules = getModules('panel');
    const schema = buildSchemaFromModules(modules);
    const messages = buildPromptMessages(snapshotText, s.spoilerLevel, modules, 'panel');

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

    const md = renderReportMarkdownFromModules(parsed, modules);
    lastReport = { json: parsed, markdown: md, createdAt: Date.now(), sourceSummary };
    renderMarkdownInto($('#sg_md'), md);

    updateButtonsEnabled();
    showPane('md');
    setStatus('完成 ✅', 'ok');
    refreshWorldbookInfoLabel();
  } catch (e) {
    console.error('[StoryGuide] analysis failed:', e);
    setStatus(`分析失败：${e?.message ?? e}`, 'err');
  } finally {
    $('#sg_analyze').prop('disabled', false);
  }
}

// -------------------- inline append (dynamic modules) --------------------

function buildInlineMarkdownFromModules(parsedJson, modules, mode) {
  // mode: compact|standard
  const lines = [];
  lines.push(`**剧情指导**`);

  // compact: 尽量短，标准：多一些
  for (const m of modules) {
    const val = parsedJson?.[m.key];
    const title = m.title || m.key;

    if (m.type === 'list') {
      const arr = Array.isArray(val) ? val : [];
      if (!arr.length) continue;

      const limit = (mode === 'standard') ? Math.min(arr.length, 4) : Math.min(arr.length, 2);
      const picked = arr.slice(0, limit);

      if (m.key === 'tips') {
        lines.push(`- **${title}**：${picked.join(' / ')}`);
      } else {
        lines.push(`- **${title}**：${picked.join(' / ')}`);
      }
    } else {
      const text = val ? String(val).trim() : '';
      if (!text) continue;
      const short = (mode === 'standard') ? text : (text.length > 120 ? text.slice(0, 120) + '…' : text);
      lines.push(`- **${title}**：${short}`);
    }
  }

  return lines.join('\n');
}

// -------------------- message locating & box creation --------------------

function getLastAssistantMessageRef() {
  const ctx = SillyTavern.getContext();
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (!m) continue;
    if (m.is_user === true) continue;
    if (m.is_system === true) continue;
    const mesid = (m.mesid ?? m.id ?? m.message_id ?? String(i));
    return { chatIndex: i, mesKey: String(mesid) };
  }
  return null;
}

function findMesElementByKey(mesKey) {
  if (!mesKey) return null;
  const selectors = [
    `.mes[mesid="${CSS.escape(String(mesKey))}"]`,
    `.mes[data-mesid="${CSS.escape(String(mesKey))}"]`,
    `.mes[data-mes-id="${CSS.escape(String(mesKey))}"]`,
    `.mes[data-id="${CSS.escape(String(mesKey))}"]`,
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  const all = Array.from(document.querySelectorAll('.mes')).filter(x => x && !x.classList.contains('mes_user'));
  return all.length ? all[all.length - 1] : null;
}

function setCollapsed(boxEl, collapsed) {
  if (!boxEl) return;
  boxEl.classList.toggle('collapsed', !!collapsed);
}

function attachToggleHandler(boxEl, mesKey) {
  if (!boxEl) return;
  const head = boxEl.querySelector('.sg-inline-head');
  if (!head) return;
  if (head.dataset.sgBound === '1') return;
  head.dataset.sgBound = '1';

  const rerollBtn = boxEl.querySelector('.sg-inline-reroll');
  if (rerollBtn && rerollBtn.dataset.sgBound !== '1') {
    rerollBtn.dataset.sgBound = '1';
    rerollBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rerollInlineBox(String(mesKey));
    });
  }


  head.addEventListener('click', (e) => {
    if (e.target && (e.target.closest('a'))) return;
    if (e.target && (e.target.closest('.sg-inline-reroll'))) return;

    const cur = boxEl.classList.contains('collapsed');
    const next = !cur;
    setCollapsed(boxEl, next);

    const cached = inlineCache.get(String(mesKey));
    if (cached) {
      cached.collapsed = next;
      inlineCache.set(String(mesKey), cached);
    }
  });
}

function createInlineBoxElement(mesKey, htmlInner, collapsed) {
  const box = document.createElement('div');
  box.className = 'sg-inline-box';
  box.dataset.sgMesKey = String(mesKey);

  box.innerHTML = `
    <div class="sg-inline-head" title="点击折叠/展开">
      <span class="sg-inline-badge">📘</span>
      <span class="sg-inline-title">剧情指导</span>
      <span class="sg-inline-sub">（自动分析）</span>
      <button class="sg-inline-reroll" title="重roll">↻</button>
      <span class="sg-inline-chevron">▾</span>
    </div>
    <div class="sg-inline-body">${htmlInner}</div>
  `.trim();

  setCollapsed(box, !!collapsed);
  attachToggleHandler(box, mesKey);
  return box;
}

function ensureInlineBoxPresent(mesKey) {
  const cached = inlineCache.get(String(mesKey));
  if (!cached) return false;

  const mesEl = findMesElementByKey(mesKey);
  if (!mesEl) return false;

  const textEl = mesEl.querySelector('.mes_text');
  if (!textEl) return false;

  const existing = textEl.querySelector('.sg-inline-box');
  if (existing) {
    setCollapsed(existing, !!cached.collapsed);
    attachToggleHandler(existing, mesKey);
    // 更新 body（有时候被覆盖成空壳）
    const body = existing.querySelector('.sg-inline-body');
    if (body && cached.htmlInner && body.innerHTML !== cached.htmlInner) body.innerHTML = cached.htmlInner;
    return true;
  }

  const box = createInlineBoxElement(mesKey, cached.htmlInner, cached.collapsed);
  textEl.appendChild(box);
  return true;
}

// -------------------- reapply (anti-overwrite) --------------------

function scheduleReapplyAll(reason = '') {
  if (reapplyTimer) clearTimeout(reapplyTimer);
  reapplyTimer = setTimeout(() => {
    reapplyTimer = null;
    reapplyAllInlineBoxes(reason);
  }, 260);
}

function reapplyAllInlineBoxes(reason = '') {
  const s = ensureSettings();
  if (!s.enabled || !s.autoAppendBox) return;
  for (const [mesKey] of inlineCache.entries()) {
    ensureInlineBoxPresent(mesKey);
  }
}

// -------------------- inline append generate & cache --------------------

async function runInlineAppendForMessage(mesKey, force = false) {
  const s = ensureSettings();
  if (!s.enabled || !s.autoAppendBox) return;
  const key = String(mesKey || '').trim();
  if (!key) return;

  const prev = inlineCache.get(key);
  const preservedCollapsed = prev ? !!prev.collapsed : false;

  if (!force && prev && prev.htmlInner) {
    // 已有缓存：确保 DOM 存在
    ensureInlineBoxExistsForMessage(key, prev.htmlInner, preservedCollapsed);
    return;
  }

  // 先放一个占位（避免“点了没反应”）
  ensureInlineBoxExistsForMessage(key, `<div class="sg-inline-loading">⏳ 分析中…</div>`, preservedCollapsed);

  const modules = getModules('append');
  if (!modules.length) return;

  const modeHint = (s.appendMode === 'standard')
    ? `
【附加要求】inline 输出可比面板更短，但不要丢掉关键信息。
`
    : `
【附加要求】inline 输出尽量短：每个字段尽量 1~2 句/2 条以内。
`;

  const schema = buildSchemaFromModules(modules);
  const message = buildPromptMessages({ mode: 'append', modules, modeHint });

  try {
    const raw = await callProvider(message, schema, s.temperature);
    const parsed = safeParseJsonLike(raw);
    const normalized = normalizeBySchema(parsed, schema);
    const htmlInner = renderInlineHtml(modules, normalized);

    inlineCache.set(key, { htmlInner, collapsed: preservedCollapsed, ts: Date.now() });
    ensureInlineBoxExistsForMessage(key, htmlInner, preservedCollapsed);

    // 如果设置面板打开，顺便刷新世界书统计显示
    refreshWorldbookInfoLabel();
  } catch (e) {
    const msg = e?.message ?? String(e);
    const htmlInner = `<div class="sg-inline-error">❌ 分析失败：${escapeHtml(msg)}</div>`;
    inlineCache.set(key, { htmlInner, collapsed: preservedCollapsed, ts: Date.now() });
    ensureInlineBoxExistsForMessage(key, htmlInner, preservedCollapsed);
  }
}

async function runInlineAppendForLastMessage() {
  const ref = getLastAssistantMessageRef();
  if (!ref) return;
  await runInlineAppendForMessage(ref.mesKey, false);
}

async function rerollInlineBox(mesKey) {
  const key = String(mesKey || '').trim();
  if (!key) return;

  const prev = inlineCache.get(key);
  const preservedCollapsed = prev ? !!prev.collapsed : false;
  inlineCache.delete(key);
  inlineCache.set(key, { htmlInner: `<div class="sg-inline-loading">⏳ 重roll中…</div>`, collapsed: preservedCollapsed, ts: Date.now() });
  ensureInlineBoxExistsForMessage(key, `<div class="sg-inline-loading">⏳ 重roll中…</div>`, preservedCollapsed);

  await runInlineAppendForMessage(key, true);
}


function scheduleInlineAppend() {
  const s = ensureSettings();
  const delay = clampInt(s.appendDebounceMs, 150, 5000, DEFAULT_SETTINGS.appendDebounceMs);
  if (appendTimer) clearTimeout(appendTimer);
  appendTimer = setTimeout(() => {
    appendTimer = null;
    runInlineAppendForLastMessage().catch(() => void 0);
  }, delay);
}

// -------------------- models refresh (custom) --------------------

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

async function refreshModels() {
  const s = ensureSettings();
  const raw = String($('#sg_customEndpoint').val() || s.customEndpoint || '').trim();
  const apiBase = normalizeBaseUrl(raw);
  if (!apiBase) { setStatus('请先填写 API基础URL 再刷新模型', 'warn'); return; }

  setStatus('正在刷新模型列表…', 'warn');

  const apiKey = String($('#sg_customApiKey').val() || s.customApiKey || '');
  const statusUrl = '/api/backends/chat-completions/status';

  const body = {
    reverse_proxy: apiBase,
    chat_completion_source: 'custom',
    custom_url: apiBase,
    custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : ''
  };

  // prefer backend status
  try {
    const headers = { ...getStRequestHeadersCompat(), 'Content-Type': 'application/json' };
    const res = await fetch(statusUrl, { method: 'POST', headers, body: JSON.stringify(body) });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`状态检查失败: HTTP ${res.status} ${res.statusText}\n${txt}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json().catch(() => ({}));

    let modelsList = [];
    if (Array.isArray(data?.models)) modelsList = data.models;
    else if (Array.isArray(data?.data)) modelsList = data.data;
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
    setStatus(`已刷新模型：${ids.length} 个（后端代理）`, 'ok');
    return;
  } catch (e) {
    const status = e?.status;
    if (!(status === 404 || status === 405)) console.warn('[StoryGuide] status check failed; fallback to direct /models', e);
  }

  // fallback direct
  try {
    const modelsUrl = (function (base) {
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
    if (Array.isArray(data?.models)) modelsList = data.models;
    else if (Array.isArray(data?.data)) modelsList = data.data;
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

            <div class="sg-grid2">
              <div class="sg-field">
                <label>最近消息条数</label>
                <input id="sg_maxMessages" type="number" min="5" max="200">
              </div>
              <div class="sg-field">
                <label>每条最大字符</label>
                <input id="sg_maxChars" type="number" min="200" max="8000">
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
              <select id="sg_appendFieldsSource">
                <option value="inline">追加字段：inline 模块</option>
                <option value="panel">追加字段：报告模块(panel)</option>
              </select>
              <span class="sg-hint">（点标题折叠；↻重roll）</span>
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
              </div>
            </div>

            <div class="sg-actions-row">
              <button class="menu_button sg-btn-primary" id="sg_saveSettings">保存设置</button>
              <button class="menu_button sg-btn-primary" id="sg_analyze">分析当前剧情</button>
            </div>
          </div>

          <div class="sg-card">
            <div class="sg-card-title">输出模块（JSON，可自定义字段/提示词）</div>
            <div class="sg-hint">你可以增删模块、改 key/title/type/prompt、控制 panel/inline。保存前可点“校验”。</div>

            <div class="sg-field">
              <textarea id="sg_modulesJson" rows="12" spellcheck="false"></textarea>
              <div class="sg-actions-row">
                <button class="menu_button sg-btn" id="sg_validateModules">校验</button>
                <button class="menu_button sg-btn" id="sg_resetModules">恢复默认</button>
                <button class="menu_button sg-btn" id="sg_applyModules">应用到设置</button>
              </div>
            </div>

            <div class="sg-field">
              <label>自定义 System 补充（可选）</label>
              <textarea id="sg_customSystemPreamble" rows="3" placeholder="例如：更偏悬疑、强调线索、避免冗长…"></textarea>
            </div>
            <div class="sg-field">
              <label>自定义 Constraints 补充（可选）</label>
              <textarea id="sg_customConstraints" rows="3" placeholder="例如：必须提到关键人物动机、每条不超过20字…"></textarea>
            </div>
          </div>

          
          <div class="sg-card">
            <div class="sg-card-title">预设与世界书</div>

            <div class="sg-row sg-inline">
              <button class="menu_button sg-btn" id="sg_exportPreset">导出预设</button>
              <label class="sg-check"><input type="checkbox" id="sg_presetIncludeApiKey">导出包含 API Key</label>
              <button class="menu_button sg-btn" id="sg_importPreset">导入预设</button>
            </div>

            <div class="sg-hint">预设会包含：生成设置 / 独立API / 输出模块 / 世界书设置 / 自定义提示骨架。导入会覆盖当前配置。</div>

            <hr class="sg-hr">

            <div class="sg-row sg-inline">
              <label class="sg-check"><input type="checkbox" id="sg_worldbookEnabled">在分析输入中注入世界书</label>
              <select id="sg_worldbookMode">
                <option value="active">仅注入“可能激活”的条目（推荐）</option>
                <option value="all">注入全部条目</option>
              </select>
            </div>

            <div class="sg-row sg-inline">
              <span class="sg-label">世界书注入位置</span>
              <select id="sg_worldbookInsertPos">
                <option value="afterCanon">在「原著后续/大纲」之后</option>
                <option value="afterWorld">在「世界观/设定补充」之后</option>
                <option value="beforeChat">在「聊天记录」之前</option>
              </select>
            </div>

            <div class="sg-grid2">
              <div class="sg-field">
                <label>世界书最大注入字符</label>
                <input id="sg_worldbookMaxChars" type="number" min="500" max="50000">
              </div>
              <div class="sg-field">
                <label>激活检测窗口（最近消息条数）</label>
                <input id="sg_worldbookWindowMessages" type="number" min="5" max="80">
              </div>
            </div>

            <div class="sg-row sg-inline">
              <button class="menu_button sg-btn" id="sg_importWorldbook">导入世界书JSON</button>
              <button class="menu_button sg-btn" id="sg_clearWorldbook">清空世界书</button>
            </div>

            <div class="sg-hint" id="sg_worldbookInfo">（未导入世界书）</div>
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

  
  // presets actions
  $('#sg_exportPreset').on('click', () => {
    try {
      pullUiToSettings();
      const s = ensureSettings();
      const out = clone(s);

      const includeKey = $('#sg_presetIncludeApiKey').is(':checked');
      if (!includeKey) out.customApiKey = '';

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadTextFile(`storyguide-preset-${stamp}.json`, JSON.stringify(out, null, 2));
      setStatus('已导出预设 ✅', 'ok');
    } catch (e) {
      setStatus(`导出失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_importPreset').on('click', async () => {
    try {
      const file = await pickFile('.json,application/json');
      if (!file) return;
      const txt = await readFileText(file);
      const data = JSON.parse(txt);

      if (!data || typeof data !== 'object') {
        setStatus('导入失败：预设文件格式不对', 'err');
        return;
      }

      const s = ensureSettings();
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (Object.hasOwn(data, k)) s[k] = data[k];
      }

      if (!s.modulesJson) s.modulesJson = JSON.stringify(DEFAULT_MODULES, null, 2);

      saveSettings();
      pullSettingsToUi();
      setStatus('已导入预设并应用 ✅', 'ok');

      // 预设变化后：清空 inline 缓存，确保自动追加会用新模块
      inlineCache.clear();
      scheduleReapplyAll('import_preset');
      scheduleInlineAppend('preset_import');
    } catch (e) {
      setStatus(`导入失败：${e?.message ?? e}`, 'err');
    }
  });

  // worldbook actions
  $('#sg_importWorldbook').on('click', async () => {
    try {
      const file = await pickFile('.json,application/json');
      if (!file) return;
      const txt = await readFileText(file);
      const entries = parseWorldbookJson(txt);

      const s = ensureSettings();
      s.worldbookJson = txt;
      saveSettings();

      refreshWorldbookInfoLabel();
      setStatus('世界书已导入 ✅', entries.length ? 'ok' : 'warn');
    } catch (e) {
      setStatus(`导入世界书失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_clearWorldbook').on('click', () => {
    const s = ensureSettings();
    s.worldbookJson = '';
    saveSettings();
    refreshWorldbookInfoLabel();
    setStatus('已清空世界书', 'ok');
  });

// modules json actions
  $('#sg_validateModules').on('click', () => {
    const txt = String($('#sg_modulesJson').val() || '').trim();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch (e) {
      setStatus(`模块 JSON 解析失败：${e?.message ?? e}`, 'err');
      return;
    }
    const v = validateAndNormalizeModules(parsed);
    if (!v.ok) {
      setStatus(`模块校验失败：${v.error}`, 'err');
      return;
    }
    setStatus(`模块校验通过 ✅（${v.modules.length} 个模块）`, 'ok');
  });

  $('#sg_resetModules').on('click', () => {
    $('#sg_modulesJson').val(JSON.stringify(DEFAULT_MODULES, null, 2));
    setStatus('已恢复默认模块（尚未保存，点“应用到设置”）', 'warn');
  });

  $('#sg_applyModules').on('click', () => {
    const txt = String($('#sg_modulesJson').val() || '').trim();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch (e) {
      setStatus(`模块 JSON 解析失败：${e?.message ?? e}`, 'err');
      return;
    }
    const v = validateAndNormalizeModules(parsed);
    if (!v.ok) { setStatus(`模块校验失败：${v.error}`, 'err'); return; }

    const s = ensureSettings();
    s.modulesJson = JSON.stringify(v.modules, null, 2);
    saveSettings();
    $('#sg_modulesJson').val(s.modulesJson);
    setStatus('模块已应用并保存 ✅', 'ok');
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

  $('#sg_includeUser').prop('checked', !!s.includeUser);
  $('#sg_includeAssistant').prop('checked', !!s.includeAssistant);

  $('#sg_autoRefresh').prop('checked', !!s.autoRefresh);
  $('#sg_autoRefreshOn').val(s.autoRefreshOn);

  $('#sg_autoAppendBox').prop('checked', !!s.autoAppendBox);
  $('#sg_appendMode').val(s.appendMode);
  $('#sg_appendFieldsSource').val(String(s.appendFieldsSource || 'inline'));

  $('#sg_customEndpoint').val(s.customEndpoint);
  $('#sg_customApiKey').val(s.customApiKey);
  $('#sg_customModel').val(s.customModel);

  fillModelSelect(Array.isArray(s.customModelsCache) ? s.customModelsCache : [], s.customModel);

  $('#sg_worldText').val(getChatMetaValue(META_KEYS.world));
  $('#sg_canonText').val(getChatMetaValue(META_KEYS.canon));

  $('#sg_modulesJson').val(String(s.modulesJson || JSON.stringify(DEFAULT_MODULES, null, 2)));
  $('#sg_customSystemPreamble').val(String(s.customSystemPreamble || ''));
  $('#sg_customConstraints').val(String(s.customConstraints || ''));

  $('#sg_presetIncludeApiKey').prop('checked', !!s.presetIncludeApiKey);

  $('#sg_worldbookEnabled').prop('checked', !!s.worldbookEnabled);
  $('#sg_worldbookMode').val(String(s.worldbookMode || 'active'));
  $('#sg_worldbookInsertPos').val(String(s.worldbookInsertPos || 'afterCanon'));
  $('#sg_worldbookMaxChars').val(s.worldbookMaxChars);
  $('#sg_worldbookWindowMessages').val(s.worldbookWindowMessages);

  refreshWorldbookInfoLabel();

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

  s.includeUser = $('#sg_includeUser').is(':checked');
  s.includeAssistant = $('#sg_includeAssistant').is(':checked');

  s.autoRefresh = $('#sg_autoRefresh').is(':checked');
  s.autoRefreshOn = String($('#sg_autoRefreshOn').val());

  s.autoAppendBox = $('#sg_autoAppendBox').is(':checked');
  s.appendMode = String($('#sg_appendMode').val() || 'compact');
  s.appendFieldsSource = String($('#sg_appendFieldsSource').val() || 'inline');

  s.customEndpoint = String($('#sg_customEndpoint').val() || '').trim();
  s.customApiKey = String($('#sg_customApiKey').val() || '');
  s.customModel = String($('#sg_customModel').val() || '').trim();

  // modulesJson：先不强行校验（用户可先保存再校验），但会在分析前用默认兜底
  s.modulesJson = String($('#sg_modulesJson').val() || '').trim() || JSON.stringify(DEFAULT_MODULES, null, 2);

  s.customSystemPreamble = String($('#sg_customSystemPreamble').val() || '');
  s.customConstraints = String($('#sg_customConstraints').val() || '');

  s.presetIncludeApiKey = $('#sg_presetIncludeApiKey').is(':checked');

  s.worldbookEnabled = $('#sg_worldbookEnabled').is(':checked');
  s.worldbookMode = String($('#sg_worldbookMode').val() || 'active');
  s.worldbookInsertPos = String($('#sg_worldbookInsertPos').val() || 'afterCanon');
  s.worldbookMaxChars = clampInt($('#sg_worldbookMaxChars').val(), 500, 50000, s.worldbookMaxChars || 6000);
  s.worldbookWindowMessages = clampInt($('#sg_worldbookWindowMessages').val(), 5, 80, s.worldbookWindowMessages || 18);
}

function openModal() {
  ensureModal();
  pullSettingsToUi();
  setStatus('', '');
  $('#sg_modal_backdrop').show();
  showPane('md');
}
function closeModal() {
  try { pullUiToSettings(); saveSettings(); } catch { /* ignore */ }
  $('#sg_modal_backdrop').hide();
}

let settingsPanelObserver = null;

function findExtensionsSettingsRoot() {
  const selectors = [
    '#extensions_settings',
    '#extensions-settings',
    '#extensionsSettings',
    '#extensions_settings_container',
    '#extensionsSettingsContainer',
    '.extensions_settings',
    '.extensions-settings',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return $(el);
  }
  // 有些版本会把扩展设置放在 settings 容器内
  const fallback = document.querySelector('[id*="extensions"][id*="settings"]');
  if (fallback) return $(fallback);
  return $('#extensions_settings');
}

function injectMinimalSettingsPanel() {
  const $root = findExtensionsSettingsRoot();
  if (!$root || !$root.length) return false;
  if ($('#sg_settings_panel_min').length) return true;

  $root.append(`
    <div class="sg-panel-min" id="sg_settings_panel_min">
      <div class="sg-min-row">
        <div class="sg-min-title">剧情指导 StoryGuide</div>
        <button class="menu_button sg-btn" id="sg_open_from_settings">打开面板</button>
      </div>
      <div class="sg-min-hint">支持自定义输出模块（JSON），并且自动追加框会缓存+监听重渲染，尽量不被变量更新覆盖。</div>
    </div>
  `);
  $('#sg_open_from_settings').on('click', () => openModal());
  return true;
}

// 有些酒馆版本在 APP_READY 时还没有渲染扩展设置 DOM，这里用 observer 兜底
function ensureSettingsPanelInjected() {
  if (injectMinimalSettingsPanel()) return;

  if (settingsPanelObserver) return;
  settingsPanelObserver = new MutationObserver(() => {
    if (injectMinimalSettingsPanel()) {
      try { settingsPanelObserver.disconnect(); } catch {}
      settingsPanelObserver = null;
    }
  });
  settingsPanelObserver.observe(document.body, { childList: true, subtree: true });
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

// -------------------- DOM observers (anti overwrite) --------------------

function findChatContainer() {
  const candidates = [
    '#chat',
    '#chat_history',
    '#chatHistory',
    '#chat_container',
    '#chatContainer',
    '#chat_wrapper',
    '#chatwrapper',
    '.chat',
    '.chat_history',
    '.chat-history',
    '#sheldon_chat',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  const mes = document.querySelector('.mes');
  return mes ? mes.parentElement : null;
}

function startObservers() {
  const chatContainer = findChatContainer();
  if (chatContainer) {
    if (chatDomObserver) chatDomObserver.disconnect();
    chatDomObserver = new MutationObserver(() => scheduleReapplyAll('chat'));
    chatDomObserver.observe(chatContainer, { childList: true, subtree: true, characterData: true });
  }

  if (bodyDomObserver) bodyDomObserver.disconnect();
  bodyDomObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      const t = m.target;
      if (t && t.nodeType === 1) {
        const el = /** @type {Element} */ (t);
        if (el.classList?.contains('mes') || el.classList?.contains('mes_text') || el.querySelector?.('.mes') || el.querySelector?.('.mes_text')) {
          scheduleReapplyAll('body');
          break;
        }
      }
    }
  });
  bodyDomObserver.observe(document.body, { childList: true, subtree: true, characterData: false });

  scheduleReapplyAll('start');
}

// -------------------- events --------------------

function setupEventListeners() {
  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    startObservers();

    eventSource.on(event_types.CHAT_CHANGED, () => {
      inlineCache.clear();
      scheduleReapplyAll('chat_changed');
      if (document.getElementById('sg_modal_backdrop') && $('#sg_modal_backdrop').is(':visible')) {
        pullSettingsToUi();
        setStatus('已切换聊天：已同步本聊天字段', 'ok');
      }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
      const s = ensureSettings();
      if (s.autoAppendBox) scheduleInlineAppend();
      if (s.autoRefresh && (s.autoRefreshOn === 'received' || s.autoRefreshOn === 'both')) scheduleAutoRefresh();
      scheduleReapplyAll('msg_received');
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
    ensureSettingsPanelInjected();
  });

  globalThis.StoryGuide = {
    open: openModal,
    close: closeModal,
    runAnalysis,
    runInlineAppendForLastMessage,
    reapplyAllInlineBoxes,
    buildSnapshot: () => buildSnapshot(),
    getLastReport: () => lastReport,
    refreshModels,
    _inlineCache: inlineCache,
  };
}

init();
