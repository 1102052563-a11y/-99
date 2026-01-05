const MODULE_NAME = '"'"'canon_plot_cue'"'"';
const PROMPT_KEY = '"'"'3_canon_plot_cue'"'"';

const DEFAULTS = {
  enabled: true,
  position: 1, // In-Chat
  depth: 0,
  scanWi: false,
  workTitle: '',
  canonMC: '',
  keyNpcs: '',
  canonNotes: '',
};

function getContextSafe() {
  return globalThis.SillyTavern?.getContext ? globalThis.SillyTavern.getContext() : null;
}

function loadSettings(ctx) {
  const store = ctx.extensionSettings;
  if (!store[MODULE_NAME]) store[MODULE_NAME] = structuredClone(DEFAULTS);
  const s = store[MODULE_NAME];
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (s[k] === undefined || s[k] === null) s[k] = v;
  }
  return s;
}

function sanitizeOneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function buildHeader(s) {
  const bits = [];
  const title = sanitizeOneLine(s.workTitle);
  const mc = sanitizeOneLine(s.canonMC);
  const npcs = sanitizeOneLine(s.keyNpcs);
  if (title) bits.push(`原著=${title}`);
  if (mc) bits.push(`主角=${mc}`);
  if (npcs) bits.push(`NPC=${npcs}`);
  return bits.length ? `（${bits.join('｜')}）` : '';
}

function buildInjectionText(s) {
  const header = buildHeader(s);
  const notes = String(s.canonNotes ?? '').trim();

  return [
    '你必须在“本回合正文的最后”追加一次且仅一次【剧情指引】引用块，不要修改正文已有内容。',
    '写作基准：只对照原著时间线与原著人物动作链；缺信息时写“原著线未知”，并用【推测】给出 A/B 分支。',
    '输出格式：整块必须是 Markdown 引用（每行以 "> " 开头）。',
    notes ? `原著时间线要点（高优先级，对照用）：\n${notes}` : '',
    `> **【剧情指引${header}】**`,
    `> 原著此刻：{{写1-3条，谁在做什么/为什么，按时间顺序；未知就写原著线未知并做推测A/B}}`,
    `> 原著将来：{{写2-3条，原著接下来要发生的具体动作；未知同上}}`,
    `> 主角影响：{{对比原著，写主角当前行为带来的1个机会+1个风险，具体到动作和结果}}`,
    `> 行动提示：1){{短可执行建议}} 2){{短可执行建议}} 3){{短可执行建议}}`,
  ].filter(Boolean).join('\n');
}

function applyInjection(ctx, s) {
  if (!ctx?.setExtensionPrompt) return;
  if (!s.enabled) {
    ctx.setExtensionPrompt(PROMPT_KEY, '', Number(s.position ?? 1), Number(s.depth ?? 0), !!s.scanWi);
    return;
  }
  const text = buildInjectionText(s);
  ctx.setExtensionPrompt(PROMPT_KEY, text, Number(s.position ?? 1), Number(s.depth ?? 0), !!s.scanWi);
}

function mountSettingsUI(ctx, s) {
  const html = ctx.renderExtensionTemplateAsync
    ? ctx.renderExtensionTemplateAsync(MODULE_NAME, 'settings')
    : ctx.renderExtensionTemplate(MODULE_NAME, 'settings');
  $('#extensions_settings2').append(html);

  $('#cpc_enabled').prop('checked', !!s.enabled);
  $('#cpc_work_title').val(s.workTitle);
  $('#cpc_canon_mc').val(s.canonMC);
  $('#cpc_key_npcs').val(s.keyNpcs);
  $('#cpc_canon_notes').val(s.canonNotes);
  $('#cpc_position').val(String(s.position));
  $('#cpc_depth').val(String(s.depth));
  $('#cpc_scan_wi').prop('checked', !!s.scanWi);

  const persist = () => {
    s.enabled = !!$('#cpc_enabled').prop('checked');
    s.workTitle = String($('#cpc_work_title').val() ?? '');
    s.canonMC = String($('#cpc_canon_mc').val() ?? '');
    s.keyNpcs = String($('#cpc_key_npcs').val() ?? '');
    s.canonNotes = String($('#cpc_canon_notes').val() ?? '');
    s.position = Number($('#cpc_position').val() ?? 1);
    s.depth = Number($('#cpc_depth').val() ?? 0);
    s.scanWi = !!$('#cpc_scan_wi').prop('checked');

    Object.assign(ctx.extensionSettings[MODULE_NAME], s);
    ctx.saveSettingsDebounced?.();
    applyInjection(ctx, s);
  };

  $('#cpc_enabled, #cpc_position, #cpc_depth, #cpc_scan_wi').on('change input', persist);
  $('#cpc_work_title, #cpc_canon_mc, #cpc_key_npcs, #cpc_canon_notes').on('input', persist);

  $('#cpc_apply').on('click', () => {
    persist();
    toastr?.success?.('剧情指引已应用');
  });

  $('#cpc_disable').on('click', () => {
    s.enabled = false;
    $('#cpc_enabled').prop('checked', false);
    persist();
    toastr?.info?.('已禁用剧情指引');
  });
}

jQuery(async () => {
  const ctx = getContextSafe();
  if (!ctx) return;

  const s = loadSettings(ctx);
  applyInjection(ctx, s);

  const { eventSource } = ctx;
  const events = ctx?.event_types || ctx?.eventTypes || {};
  if (eventSource?.on && events.CHAT_CHANGED) {
    eventSource.on(events.CHAT_CHANGED, () => applyInjection(ctx, s));
  }

  try {
    await mountSettingsUI(ctx, s);
  } catch (e) {
    console.error('Canon Plot Cue: failed to mount settings UI', e);
  }
});