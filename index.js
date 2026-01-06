'use strict';

/**
 * 剧情指导 StoryGuide (SillyTavern UI Extension)
 * v0.5.2
 *
 * BUG FIXES:
 * - Fixed MutationObserver infinite loop (DOM thrashing).
 * - Improved JSON parsing robustness against preamble text.
 * - Added safer context checks for `ctx.chat`.
 */

const MODULE_NAME = 'storyguide';

/**
 * 模块配置格式（JSON 数组）示例：
 * [
 * {"key":"world_summary","title":"世界简介","type":"text","prompt":"1~3句概括世界与局势","required":true,"panel":true,"inline":true},
 * {"key":"key_plot_points","title":"重要剧情点","type":"list","prompt":"3~8条关键剧情点（短句）","maxItems":8,"required":true,"panel":true,"inline":false}
 * ]
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

  // 生成控制
  spoilerLevel: 'mild', // none | mild | full
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

  // custom API
  customEndpoint: '',
  customApiKey: '',
  customModel: 'gpt-4o-mini',
  customModelsCache: [],
  customTopP: 0.95,
  customMaxTokens: 8192,

  // 预设导入/导出
  presetIncludeApiKey: false,

  // 世界书
  worldbookEnabled: false,
  worldbookMode: 'active', // active | all
  worldbookMaxChars: 6000,
  worldbookWindowMessages: 18,
  worldbookJson: '',

  // 模块自定义
  modulesJson: '',
  customSystemPreamble: '',
  customConstraints: '',
});

const META_KEYS = Object.freeze({
  canon: 'storyguide_canon_outline',
  world: 'storyguide_world_setup',
});

let lastReport = null;
let lastJsonText = '';
let refreshTimer = null;
let appendTimer = null;

// ============== 关键：DOM 追加缓存 & 观察者（抗重渲染） ==============
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
  const ctx = SillyTavern.getContext();
  if (!ctx.extensionSettings) ctx.extensionSettings = {}; // Safety
  const { extensionSettings, saveSettingsDebounced } = ctx;

  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
    extensionSettings[MODULE_NAME].modulesJson = JSON.stringify(DEFAULT_MODULES, null, 2);
    if(saveSettingsDebounced) saveSettingsDebounced();
  } else {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) extensionSettings[MODULE_NAME][k] = DEFAULT_SETTINGS[k];
    }
    if (!extensionSettings[MODULE_NAME].modulesJson) {
      extensionSettings[MODULE_NAME].modulesJson = JSON.stringify(DEFAULT_MODULES, null, 2);
    }
  }
  return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const ctx = SillyTavern.getContext();
    if(ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
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

/**
 * Enhanced JSON Parser (Bug Fix 2)
 * Searches for the outermost {} to ignore preamble/postamble text.
 */
function safeJsonParse(maybeJson) {
  if (!maybeJson) return null;
  let t = String(maybeJson).trim();

  // Attempt to find the first '{' and last '}'
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');

  if (first !== -1 && last !== -1 && last > first) {
    t = t.substring(first, last + 1);
  }

  // Common cleanup
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

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
  const ctx = SillyTavern.getContext();
  return ctx.chatMetadata?.[key] ?? '';
}
async function setChatMetaValue(key, value) {
  const ctx = SillyTavern.getContext();
  if(!ctx.chatMetadata) ctx.chatMetadata = {};
  ctx.chatMetadata[key] = value;
  if(ctx.saveMetadata) await ctx.saveMetadata();
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

// (The remainder of index.js is omitted in this environment due to tool message size limits.)
