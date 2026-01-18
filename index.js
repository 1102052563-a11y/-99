'use strict';

/**
 * 剧情指导 StoryGuide (SillyTavern UI Extension)
 * v0.9.8
 *
 * 新增：输出模块自定义（更高自由度）
 * - 你可以自定义“输出模块列表”以及每个模块自己的提示词（prompt）
 * - 面板提供一个「模块配置(JSON)」编辑区：可增删字段、改顺序、改提示词、控制是否在面板/自动追加中展示
 * - 插件会根据模块自动生成 JSON Schema（动态字段）并要求模型按该 Schema 输出
 *
 * 兼容：仍然保持 v0.3.x 的“独立API走后端代理 + 抗变量更新覆盖（自动补贴）+ 点击折叠”能力
 *
 * v0.8.2 修复：兼容 SlashCommand 返回 [object Object] 的情况（自动解析 UID / 文本输出）
 * v0.8.3 新增：总结功能支持自定义提示词（system + user 模板，支持占位符）
 * v0.8.6 修复：写入世界书不再依赖 JS 解析 UID（改为在同一段 STscript 管线内用 {{pipe}} 传递 UID），避免误报“无法解析 UID”。
 * v0.9.0 修复：实时读取蓝灯世界书在部分 ST 版本返回包装字段（如 data 为 JSON 字符串）时解析为 0 条的问题；并增强读取端点/文件名兼容。
 * v0.9.1 新增：蓝灯索引→绿灯触发 的“索引日志”（显示命中条目名称/注入关键词），便于排查触发效果。
 * v0.9.2 修复：条目标题前缀（comment）现在始终加在最前（即使模型输出了自定义 title 也会保留前缀）。
 * v0.9.4 新增：总结写入世界书的“主要关键词(key)”可切换为“索引编号”（如 A-001），只写 1 个触发词，触发更精确。
 * v0.9.5 改进：蓝灯索引匹配会综合“最近 N 条消息正文 + 本次用户输入”，而不是只看最近正文（可在面板里关闭/调整权重）。
 * v0.9.6 改进：在面板标题处显示版本号，方便确认是否已正确更新到包含“用户输入权重”设置的版本。
 * v0.9.9 改进：把“剧情指导 / 总结设置 / 索引设置”拆成三页（左侧分页标签），界面更清晰。
 * v0.9.8 新增：手动选择总结楼层范围（例如 20-40）并点击立即总结。
 * v0.10.0 新增：手动楼层范围总结支持“按每 N 层拆分生成多条世界书条目”（例如 1-80 且 N=40 → 2 条）。
 */

const SG_VERSION = '0.10.0';

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
  { key: 'world_summary', title: '世界简介', type: 'text', prompt: '1~3句概括世界与局势', required: true, panel: true, inline: true, static: true },
  { key: 'key_plot_points', title: '重要剧情点', type: 'list', prompt: '3~8条关键剧情点（短句）', maxItems: 8, required: true, panel: true, inline: false, static: true },
  { key: 'current_scene', title: '当前时间点 · 具体剧情', type: 'text', prompt: '描述当前发生了什么（地点/人物动机/冲突/悬念）', required: true, panel: true, inline: true },
  { key: 'next_events', title: '后续将会发生的事', type: 'list', prompt: '接下来最可能发生的事（条目）', maxItems: 6, required: true, panel: true, inline: true },
  { key: 'protagonist_impact', title: '主角行为造成的影响', type: 'text', prompt: '主角行为对剧情/关系/风险造成的改变', required: true, panel: true, inline: false },
  { key: 'tips', title: '给主角的提示（基于原著后续/大纲）', type: 'list', prompt: '给出可执行提示（尽量具体）', maxItems: 4, required: true, panel: true, inline: true },
  { key: 'quick_actions', title: '快捷选项', type: 'list', prompt: '根据当前剧情走向，给出4~6个玩家可以发送的具体行动选项（每项15~40字，可直接作为对话输入发送）', maxItems: 6, required: true, panel: true, inline: true },
]);

// ===== 总结提示词默认值（可在面板中自定义） =====
const DEFAULT_SUMMARY_SYSTEM_PROMPT = `你是一个“剧情总结/世界书记忆”助手。\n\n任务：\n1) 阅读用户与AI对话片段，生成一段简洁摘要（中文，150~400字，尽量包含：主要人物/目标/冲突/关键物品/地点/关系变化/未解决的悬念）。\n2) 提取 6~14 个关键词（中文优先，人物/地点/势力/物品/事件/关系等），用于世界书条目触发词。关键词尽量去重、不要太泛（如“然后”“好的”）。`;

const DEFAULT_SUMMARY_USER_TEMPLATE = `【楼层范围】{{fromFloor}}-{{toFloor}}\n\n【对话片段】\n{{chunk}}`;

// 无论用户怎么自定义提示词，仍会强制追加 JSON 输出结构要求，避免写入世界书失败
const SUMMARY_JSON_REQUIREMENT = `输出要求：\n- 只输出严格 JSON，不要 Markdown、不要代码块、不要任何多余文字。\n- JSON 结构必须为：{"title": string, "summary": string, "keywords": string[]}。\n- keywords 为 6~14 个词/短语，尽量去重、避免泛词。`;


// ===== 索引提示词默认值（可在面板中自定义；用于"LLM 综合判断"模式） =====
const DEFAULT_INDEX_SYSTEM_PROMPT = `你是一个"剧情索引匹配"助手。

【任务】
- 输入包含：最近剧情正文（节选）、用户当前输入、以及若干候选索引条目（含标题/摘要/触发词/类型）。
- 你的目标是：综合判断哪些候选条目与"当前剧情"最相关，并返回这些候选的 id。

【选择优先级】
1. **人物相关**：当前剧情涉及某个NPC时，优先索引该NPC的档案条目
2. **装备相关**：当前剧情涉及某件装备时，优先索引该装备的条目
3. **历史剧情**：优先选择时间较久远但与当前剧情相关的条目（避免索引最近已在上下文中的剧情）
4. **因果关联**：当前事件的前因、伏笔、未解悬念

【避免】
- 不要选择刚刚发生的剧情（最近5层以内的内容通常已在上下文中）
- 避免选择明显无关或过于泛泛的条目

【返回要求】
- 返回条目数量应 <= maxPick
- 分类控制：人物条目 <= maxCharacters，装备条目 <= maxEquipments，剧情条目 <= maxPlot`;

const DEFAULT_INDEX_USER_TEMPLATE = `【用户当前输入】
{{userMessage}}

【最近剧情（节选）】
{{recentText}}

【候选索引条目（JSON）】
{{candidates}}

【选择限制】
- 总数不超过 {{maxPick}} 条
- 人物条目不超过 {{maxCharacters}} 条
- 装备条目不超过 {{maxEquipments}} 条
- 剧情条目不超过 {{maxPlot}} 条

请从候选中选出与当前剧情最相关的条目，优先选择：与当前提到的人物/装备相关的条目、时间较久远的相关剧情。仅输出 JSON。`;

const INDEX_JSON_REQUIREMENT = `输出要求：
- 只输出严格 JSON，不要 Markdown、不要代码块、不要任何多余文字。
- JSON 结构必须为：{"pickedIds": number[]}。
- pickedIds 必须是候选列表里的 id（整数）。
- 返回的 pickedIds 数量 <= maxPick。`;


// ===== 结构化世界书条目提示词默认值 =====
const DEFAULT_STRUCTURED_ENTRIES_SYSTEM_PROMPT = `你是一个"剧情记忆管理"助手，负责从对话片段中提取结构化信息用于长期记忆。

【任务】
1. 识别本次对话中出现的重要 NPC（不含主角）
2. 识别主角当前持有/装备的关键物品
3. 识别主角新增或变化的能力
4. 识别需要删除的条目（死亡的角色、卖掉/分解的装备等）
5. 生成档案式的客观第三人称描述

【筛选标准】
- NPC：只记录有名有姓的角色，忽略杂兵、无名NPC、普通敌人
- 装备：只记录绿色品质以上的装备，或紫色品质以上的重要物品

【去重规则（重要）】
- 仔细检查【已知人物列表】和【已知装备列表】，避免重复创建条目
- 同一角色可能有多种写法（如繁体/简体、英文/中文翻译），必须识别为同一人
- 如果发现角色已存在于列表中，使用 isUpdated=true 更新而不是创建新条目
- 将不同名称写法添加到 aliases 数组中

【删除条目规则】
- 若角色在对话中明确死亡/永久离开，将其加入 deletedCharacters 数组
- 若装备被卖掉/分解/丢弃/彻底损坏，将其加入 deletedEquipments 数组
- 若能力被遗忘/剥夺/彻底失效，将其加入 deletedAbilities 数组

【重要】
- 若提供了 statData，请从中提取该角色/物品的**关键数值**（如属性、等级、状态），精简为1-2行
- 不要完整复制 statData，只提取最重要的信息
- 重点描述：与主角的关系发展、角色背景、性格特点、关键事件

【性格铆钉】
- 为每个重要NPC提取「核心性格」：不会因剧情发展而轻易改变的根本特质
- 提取「角色动机」：该角色自己的目标/追求，不是围绕主角转
- 评估「关系阶段」：陌生/初识/熟悉/信任/亲密，关系发展应循序渐进`;
const DEFAULT_STRUCTURED_ENTRIES_USER_TEMPLATE = `【楼层范围】{{fromFloor}}-{{toFloor}}\\n【对话片段】\\n{{chunk}}\\n【已知人物列表】\\n{{knownCharacters}}\\n【已知装备列表】\\n{{knownEquipments}}`;
const DEFAULT_STRUCTURED_CHARACTER_PROMPT = `只记录有名有姓的重要NPC（不含主角），忽略杂兵、无名敌人、路人。

【必填字段】阵营身份、性格特点、背景故事、与主角关系及发展、关键事件

【性格铆钉字段（重要）】
- corePersonality：核心性格锚点，不会轻易改变的根本特质（如"傲慢"、"多疑"、"重义"），即使与主角关系改善也会保持
- motivation：角色自己的独立目标/动机，不应为了主角而放弃
- relationshipStage：与主角的关系阶段（陌生/初识/熟悉/信任/亲密），关系不应跳跃式发展

若角色死亡/永久离开，将其名字加入 deletedCharacters。若有 statData，在 statInfo 中精简总结。信息不足写"待确认"。`;
const DEFAULT_STRUCTURED_EQUIPMENT_PROMPT = `只记录绿色品质以上的装备，或紫色品质以上的重要物品（忽略白色/灰色普通物品）。必须记录：获得时间、获得地点、来源（掉落/购买/锻造/奖励等）、当前状态。若有强化/升级，描述主角如何培养这件装备。若装备被卖掉/分解/丢弃/损坏，将其名字加入 deletedEquipments。若有 statData，精简总结其属性。`;
const DEFAULT_STRUCTURED_ABILITY_PROMPT = `记录主角的能力/技能。说明类型、效果、触发条件、代价。若能力被遗忘/剥夺/失效，将其名字加入 deletedAbilities。若有 statData，精简总结其数值。`;
const STRUCTURED_ENTRIES_JSON_REQUIREMENT = `输出要求：只输出严格 JSON。各字段要填写完整，statInfo 只填关键数值的精简总结（1-2行）。

结构：{"characters":[...],"equipments":[...],"abilities":[...],"deletedCharacters":[...],"deletedEquipments":[...],"deletedAbilities":[...]}

characters 条目结构：{name,uid,aliases[],faction,status,personality,corePersonality:"核心性格锚点（不轻易改变）",motivation:"角色独立动机/目标",relationshipStage:"陌生|初识|熟悉|信任|亲密",background,relationToProtagonist,keyEvents[],statInfo,isNew,isUpdated}

equipments 条目结构：{name,uid,type,rarity,effects,source,currentState,statInfo,boundEvents[],isNew}

abilities 条目结构：{name,uid,type,effects,trigger,cost,statInfo,boundEvents[],isNegative,isNew}`;

// ===== ROLL 判定默认配置 =====
const DEFAULT_ROLL_ACTIONS = Object.freeze([
  { key: 'combat', label: '战斗', keywords: ['战斗', '攻击', '出手', '挥剑', '射击', '格挡', '闪避', '搏斗', '砍', '杀', '打', 'fight', 'attack', 'strike'] },
  { key: 'persuade', label: '劝说', keywords: ['劝说', '说服', '谈判', '交涉', '威胁', '恐吓', '欺骗', 'persuade', 'negotiate', 'intimidate', 'deceive'] },
  { key: 'learn', label: '学习', keywords: ['学习', '修炼', '练习', '研究', '掌握', '学会', '技能', 'learn', 'train', 'practice'] },
]);
const DEFAULT_ROLL_FORMULAS = Object.freeze({
  combat: '(PC.str + PC.dex + PC.atk + MOD.total + CTX.bonus + CTX.penalty) / 4',
  persuade: '(PC.cha + PC.int + MOD.total) / 3',
  learn: '(PC.int + PC.wis + MOD.total) / 3',
  default: 'MOD.total',
});
const DEFAULT_ROLL_MODIFIER_SOURCES = Object.freeze(['skill', 'talent', 'trait', 'buff', 'equipment']);
const DEFAULT_ROLL_SYSTEM_PROMPT = `你是一个专业的TRPG/ROLL点裁判。

【任务】
- 根据用户行为与属性数据 (statDataJson) 进行动作判定。
- 难度模式 difficulty：simple (简单) / normal (普通) / hard (困难) / hell (地狱)。
- 设定 成功阈值/DC (Difficulty Class)：
  - normal: DC 15~20
  - hard: DC 20~25
  - hell: DC 25~30
  - 成功判定基于 margin (final - threshold)：
    - margin >= 8 : critical_success (大成功)
    - margin 0 ~ 7 : success (成功)
    - margin -1 ~ -7 : failure (失败)
    - margin <= -8 : fumble (大失败)

【数值映射建议】
- 将文本描述的等级转化为数值修正 (MOD)：
  - F=0, E=+0.5, D=+1, C=+2, B=+3, A=+4, S=+6, SS=+8, SSS=+10
  - 若为数值 (如 Lv.5)，则直接取值 (如 +5)。
- 品级修正：若装备/技能有稀有度划分，可参考上述映射给予额外加值。
- Buff/Debuff：根据上下文给予 +/- 1~5 的临时调整。

【D20 规则参考】
- 核心公式：d20 + 属性修正 + 熟练值 + 其他修正 >= DC
- randomRoll (1~100) 换算为 d20 = ceil(randomRoll / 5)。
- 大成功/大失败：
  - d20 = 20 (即 randomRoll 96~100) 视为“大成功”(不论数值，除非 DC 极高)。
  - d20 = 1 (即 randomRoll 1~5) 视为“大失败”。

【计算流程】
1. 确定 action (动作类型) 与 formula (计算公式)。
2. 计算 base (基础值) 与 mods (所有修正来源之和)。
3. 计算 final = base + mods + 随机要素。
4. 比较 final 与 threshold，得出 success (true/false) 与 outcomeTier。

【输出要求】
- 必须输出符合 JSON Requirement 的 JSON 格式。
- explanation: 简短描述判定过程与结果 (1~2句)。
- analysisSummary: 汇总修正来源与关键映射逻辑。
`;

const DEFAULT_ROLL_USER_TEMPLATE = `动作={{action}}\n公式={{formula}}\nrandomWeight={{randomWeight}}\ndifficulty={{difficulty}}\nrandomRoll={{randomRoll}}\nmodifierSources={{modifierSourcesJson}}\nstatDataJson={{statDataJson}}`;
const ROLL_JSON_REQUIREMENT = `输出要求（严格 JSON）：\n{"action": string, "formula": string, "base": number, "mods": [{"source": string, "value": number}], "random": {"roll": number, "weight": number}, "final": number, "threshold": number, "success": boolean, "outcomeTier": string, "explanation": string, "analysisSummary"?: string}\n- analysisSummary 可选，用于日志显示，建议包含“修正来源汇总/映射应用”两段；explanation 建议 1~2 句。`;
const ROLL_DECISION_JSON_REQUIREMENT = `输出要求（严格 JSON）：\n- 若无需判定：只输出 {"needRoll": false}。\n- 若需要判定：输出 {"needRoll": true, "result": {action, formula, base, mods, random, final, threshold, success, outcomeTier, explanation, analysisSummary?}}。\n- 不要 Markdown、不要代码块、不要任何多余文字。`;

const DEFAULT_ROLL_DECISION_SYSTEM_PROMPT = `你是一个判定动作是否需要ROLL点的辅助AI。

【任务】
- 核心任务是判断用户的行为是否需要进行随机性判定 (ROLL)。
- 只有当行为具有不确定性、挑战性或对抗性时才需要 ROLL。
- 若 needRoll=true，则同时进行判定计算。

【判定原则 (needRoll)】
- needRoll = false: 
  - 日常行为 (吃饭/走路/闲聊)。
  - 必定成功的行为 (没有干扰/难度极低)。
  - 纯粹的情感表达或心理活动。
- needRoll = true:
  - 战斗/攻击/防御。
  - 尝试说服/欺骗/恐吓他人。
  - 具有风险或难度的动作 (撬锁/攀爬/潜行)。
  - 知识检定/感知检定 (发现隐藏线索)。

【若 needRoll=true，计算参考】
- 难度模式 difficulty 与 成功阈值/DC (simple/normal/hard/hell)。
- 数值映射建议：F=0, E=+0.5, D=+1, C=+2, B=+3, A=+4, S=+6, SS=+8, SSS=+10。
- 品级修正：参考装备/技能品级。
- margin 判定：>=8 大成功，0~7 成功，-1~-7 失败，<=-8 大失败。

【输出要求】
- 若无需判定：{"needRoll": false}
- 若需要判定：{"needRoll": true, "result": { ...完整计算过程... }}
- 严格遵循 JSON Requirement 格式，不要输出 Markdown 代码块。
`;

const DEFAULT_ROLL_DECISION_USER_TEMPLATE = `用户输入={{userText}}\nrandomWeight={{randomWeight}}\ndifficulty={{difficulty}}\nrandomRoll={{randomRoll}}\nstatDataJson={{statDataJson}}`;

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
  appendDebounceMs: 700,

  // 追加框展示哪些模块
  inlineModulesSource: 'inline', // inline | panel | all
  inlineShowEmpty: false,        // 是否显示空字段占位

  // provider
  provider: 'st', // st | custom

  // custom API（建议填“API基础URL”，如 https://api.openai.com/v1 ）
  customEndpoint: '',
  customApiKey: '',
  customModel: 'gpt-4o-mini',
  customModelsCache: [],
  customTopP: 0.95,
  customMaxTokens: 8192,
  customStream: false,

  // 预设导入/导出
  presetIncludeApiKey: false,

  // 世界书（World Info/Lorebook）导入与注入
  worldbookEnabled: false,
  worldbookMode: 'active', // active | all
  worldbookMaxChars: 6000,
  worldbookWindowMessages: 18,
  worldbookJson: '',

  // ===== 总结功能（独立于剧情提示的 API 设置） =====
  summaryEnabled: false,
  // 多少“楼层”总结一次（楼层统计方式见 summaryCountMode）
  summaryEvery: 20,
  // 手动楼层范围总结：是否按“每 N 层”拆分生成多条（N=summaryEvery）
  summaryManualSplit: false,
  // assistant: 仅统计 AI 回复；all: 统计全部消息（用户+AI）
  summaryCountMode: 'assistant',
  // 自动总结时，默认只总结“上次总结之后新增”的内容；首次则总结最近 summaryEvery 段
  summaryMaxCharsPerMessage: 4000,
  summaryMaxTotalChars: 24000,

  // 是否读取 stat_data 变量作为总结上下文（类似 roll 点模块）
  summaryReadStatData: false,
  summaryStatVarName: 'stat_data',

  // 总结调用方式：st=走酒馆当前已连接的 LLM；custom=独立 OpenAI 兼容 API
  summaryProvider: 'st',
  summaryTemperature: 0.4,

  // 自定义总结提示词（可选）
  // - system：决定总结风格/重点
  // - userTemplate：决定如何把楼层范围/对话片段塞给模型（支持占位符）
  summarySystemPrompt: DEFAULT_SUMMARY_SYSTEM_PROMPT,
  summaryUserTemplate: DEFAULT_SUMMARY_USER_TEMPLATE,
  summaryCustomEndpoint: '',
  summaryCustomApiKey: '',
  summaryCustomModel: 'gpt-4o-mini',
  summaryCustomModelsCache: [],
  summaryCustomMaxTokens: 2048,
  summaryCustomStream: false,

  // 总结结果写入世界书（Lorebook / World Info）
  // —— 绿灯世界书（关键词触发）——
  summaryToWorldInfo: true,
  // chatbook=写入当前聊天绑定世界书；file=写入指定世界书文件名
  summaryWorldInfoTarget: 'chatbook',
  summaryWorldInfoFile: '',
  summaryWorldInfoCommentPrefix: '剧情总结',

  // 总结写入世界书 key（触发词）的来源
  // - keywords: 使用模型输出的 keywords（默认）
  // - indexId: 使用自动生成的索引编号（如 A-001），只写 1 个触发词，触发更精确
  summaryWorldInfoKeyMode: 'keywords',
  // 当 keyMode=indexId 时：索引编号格式
  summaryIndexPrefix: 'A-',
  summaryIndexPad: 3,
  summaryIndexStart: 1,
  // 是否把索引编号写入条目标题（comment），便于世界书列表定位
  summaryIndexInComment: true,

  // —— 蓝灯世界书（常开索引：给本插件做检索用）——
  // 注意：蓝灯世界书建议写入“指定世界书文件名”，因为 chatbook 通常只有一个。
  summaryToBlueWorldInfo: false,
  summaryBlueWorldInfoFile: '',
  summaryBlueWorldInfoCommentPrefix: '剧情总结',

  // —— 自动绑定世界书（每个聊天自动生成专属世界书）——
  autoBindWorldInfo: false,
  autoBindWorldInfoPrefix: 'SG',

  // —— 蓝灯索引 → 绿灯触发 ——
  wiTriggerEnabled: false,

  // 匹配方式：local=本地相似度；llm=LLM 综合判断（可自定义提示词 & 独立 API）
  wiTriggerMatchMode: 'local',

  // —— 索引 LLM（独立于总结 API 的第二套配置）——
  wiIndexProvider: 'st',         // st | custom
  wiIndexTemperature: 0.2,
  wiIndexTopP: 0.95,
  wiIndexSystemPrompt: DEFAULT_INDEX_SYSTEM_PROMPT,
  wiIndexUserTemplate: DEFAULT_INDEX_USER_TEMPLATE,

  // LLM 模式：先用本地相似度预筛选 TopK，再交给模型综合判断（更省 tokens）
  wiIndexPrefilterTopK: 24,
  // 每条候选摘要截断字符（控制 tokens）
  wiIndexCandidateMaxChars: 420,

  // 索引独立 OpenAI 兼容 API
  wiIndexCustomEndpoint: '',
  wiIndexCustomApiKey: '',
  wiIndexCustomModel: 'gpt-4o-mini',
  wiIndexCustomModelsCache: [],
  wiIndexCustomMaxTokens: 1024,
  wiIndexCustomStream: false,

  // 在用户发送消息前（MESSAGE_SENT）读取“最近 N 条消息正文”（不含当前条），从蓝灯索引里挑相关条目。
  wiTriggerLookbackMessages: 20,
  // 是否把“本次用户输入”纳入索引匹配（综合判断）。
  wiTriggerIncludeUserMessage: true,
  // 本次用户输入在相似度向量中的权重（越大越看重用户输入；1=与最近正文同权重）
  wiTriggerUserMessageWeight: 1.6,
  // 至少已有 N 条 AI 回复（楼层）才开始索引触发；0=立即
  wiTriggerStartAfterAssistantMessages: 0,
  // 最多选择多少条 summary 条目来触发
  wiTriggerMaxEntries: 4,
  // 分类最大索引数
  wiTriggerMaxCharacters: 2, // 最多索引多少个人物条目
  wiTriggerMaxEquipments: 2, // 最多索引多少个装备条目
  wiTriggerMaxPlot: 3,       // 最多索引多少个剧情条目（优先较久远的）
  // 相关度阈值（0~1，越大越严格）
  wiTriggerMinScore: 0.08,
  // 最多注入多少个触发词（去重后）
  wiTriggerMaxKeywords: 24,
  // 注入模式：appendToUser = 追加到用户消息末尾
  wiTriggerInjectMode: 'appendToUser',
  // 注入样式：hidden=HTML 注释隐藏；plain=直接文本（更稳）
  wiTriggerInjectStyle: 'hidden',
  wiTriggerTag: 'SG_WI_TRIGGERS',
  wiTriggerDebugLog: false,

  // ROLL 判定（本回合行动判定）
  wiRollEnabled: false,
  wiRollStatSource: 'variable', // variable (综合多来源) | template | latest
  wiRollStatVarName: 'stat_data',
  wiRollRandomWeight: 0.3,
  wiRollDifficulty: 'normal',
  wiRollInjectStyle: 'hidden',
  wiRollTag: 'SG_ROLL',
  wiRollDebugLog: false,
  wiRollStatParseMode: 'json', // json | kv
  wiRollProvider: 'custom', // custom | local
  wiRollSystemPrompt: DEFAULT_ROLL_SYSTEM_PROMPT,
  wiRollCustomEndpoint: '',
  wiRollCustomApiKey: '',
  wiRollCustomModel: 'gpt-4o-mini',
  wiRollCustomMaxTokens: 512,
  wiRollCustomTopP: 0.95,
  wiRollCustomTemperature: 0.2,
  wiRollCustomStream: false,

  // 蓝灯索引读取方式：默认“实时读取蓝灯世界书文件”
  // - live：每次触发前会按需拉取蓝灯世界书（带缓存/节流）
  // - cache：只使用导入/缓存的 summaryBlueIndex
  wiBlueIndexMode: 'live',
  // 读取蓝灯索引时使用的世界书文件名；留空则回退使用 summaryBlueWorldInfoFile
  wiBlueIndexFile: '',
  // 实时读取的最小刷新间隔（秒），防止每条消息都请求一次
  wiBlueIndexMinRefreshSec: 20,

  // 蓝灯索引缓存（可选：用于检索；每条为 {title, summary, keywords, range?}）
  summaryBlueIndex: [],

  // 模块自定义（JSON 字符串 + 解析备份）
  modulesJson: '',
  // 额外可自定义提示词“骨架”
  customSystemPreamble: '',     // 附加在默认 system 之后
  customConstraints: '',        // 附加在默认 constraints 之后

  // ===== 结构化世界书条目（人物/装备/能力） =====
  structuredEntriesEnabled: true,
  characterEntriesEnabled: true,
  equipmentEntriesEnabled: true,
  abilityEntriesEnabled: false, // 默认关闭
  characterEntryPrefix: '人物',
  equipmentEntryPrefix: '装备',
  abilityEntryPrefix: '能力',
  structuredEntriesSystemPrompt: '',
  structuredEntriesUserTemplate: '',
  structuredCharacterPrompt: '',
  structuredEquipmentPrompt: '',
  structuredAbilityPrompt: '',

  // ===== 快捷选项功能 =====
  quickOptionsEnabled: true,
  quickOptionsShowIn: 'inline', // inline | panel | both
  // 预设默认选项（JSON 字符串）: [{label, prompt}]
  quickOptionsJson: JSON.stringify([
    { label: '继续', prompt: '继续当前剧情发展' },
    { label: '详述', prompt: '请更详细地描述当前场景' },
    { label: '对话', prompt: '让角色之间展开更多对话' },
    { label: '行动', prompt: '描述接下来的具体行动' },
  ], null, 2),

  // ===== 地图功能 =====
  mapEnabled: false,
  mapAutoUpdate: true,
  mapSystemPrompt: `从对话中提取地点信息，并尽量还原空间关系：
  1. 识别当前主角所在的地点名称
  2. 识别提及的新地点
  3. 判断地点之间的连接关系（哪些地点相邻/可通行，方向感如：北/南/东/西/楼上/楼下）
  4. 记录该地点发生的重要事件（事件用一句话，包含触发条件/影响）
  5. 若文本明确提到相对位置/楼层/方位，请给出 row/col（网格坐标）或相邻关系
  6. 在原著世界观下，结合谷歌搜索的原著资料补充“待探索地点”，并为每个地点写明可能触发的任务/简介
  7. 待探索地点数量不超过 6 个，避免与已有地点重复；若对话中地点较少，至少补充 2 个待探索地点
  8. 若无法给出 row/col，至少给出 connectedTo 或方位词
  9. 没有明确依据时用“待确认”描述，不要乱猜
  10. 必须输出 currentLocation/newLocations/events 三个字段，数组可为空但字段必须存在；newLocations 总数不少于 3（含待探索地点）
  11. 为地点补充分组/图层信息：group（室外/室内/楼层区域等），layer（如“一层/二层/地下”）
  12. 事件允许附带 tags（如：战斗/任务/对话/解谜/探索），每个事件 1~3 个标签
  13. 避免同义地点重复：输出前先合并同义词（如 豪宅/宅邸/府邸/公馆；学园/学院/学校；城堡/要塞/王城；寺庙/神殿/道观/教堂；洞穴/洞窟；遗迹/秘境）
  14. 仅依据对话/设定/原著信息进行推断，不要引入无根据的信息
  
  输出 JSON 格式：
  {
    "currentLocation": "主角当前所在地点",
    "newLocations": [
      { "name": "地点名", "description": "简述", "connectedTo": ["相邻地点1"], "row": 0, "col": 0, "group": "室外", "layer": "一层" }
    ],
    "events": [
      { "location": "地点名", "event": "事件描述", "tags": ["任务"] }
    ]
  }`,
});

const META_KEYS = Object.freeze({
  canon: 'storyguide_canon_outline',
  world: 'storyguide_world_setup',
  summaryMeta: 'storyguide_summary_meta',
  staticModulesCache: 'storyguide_static_modules_cache',
  boundGreenWI: 'storyguide_bound_green_wi',
  boundBlueWI: 'storyguide_bound_blue_wi',
  autoBindCreated: 'storyguide_auto_bind_created',
  mapData: 'storyguide_map_data',
});

let lastReport = null;
let lastJsonText = '';
let lastSummary = null; // { title, summary, keywords, ... }
let lastSummaryText = '';
let refreshTimer = null;
let appendTimer = null;
let summaryTimer = null;
let isSummarizing = false;
let summaryCancelled = false;
let sgToastTimer = null;

// 蓝灯索引“实时读取”缓存（防止每条消息都请求一次）
let blueIndexLiveCache = { file: '', loadedAt: 0, entries: [], lastError: '' };

// ============== 关键：DOM 追加缓存 & 观察者（抗重渲染） ==============
/**
 * inlineCache: Map<mesKey, { htmlInner: string, collapsed: boolean, createdAt: number }>
 * mesKey 优先用 DOM 的 mesid（如果拿不到则用 chatIndex）
 */
const inlineCache = new Map();
const panelCache = new Map(); // <mesKey, { htmlInner, collapsed, createdAt }>
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
  if (typeof extensionSettings[MODULE_NAME].wiRollSystemPrompt === 'string') {
    const cur = extensionSettings[MODULE_NAME].wiRollSystemPrompt;
    const hasMojibake = /\?{5,}/.test(cur);
    if (hasMojibake) {
      extensionSettings[MODULE_NAME].wiRollSystemPrompt = DEFAULT_ROLL_SYSTEM_PROMPT;
      saveSettingsDebounced();
    }
  }
  if (typeof extensionSettings[MODULE_NAME].wiRollUserTemplate === 'string') {
    const curTpl = extensionSettings[MODULE_NAME].wiRollUserTemplate;
    if (curTpl.includes('{{threshold}}')) {
      extensionSettings[MODULE_NAME].wiRollUserTemplate = DEFAULT_ROLL_USER_TEMPLATE;
      saveSettingsDebounced();
    }
  }
  return extensionSettings[MODULE_NAME];
}

function saveSettings() { SillyTavern.getContext().saveSettingsDebounced(); }

// 导出全局预设
function exportPreset() {
  const s = ensureSettings();
  const preset = {
    _type: 'StoryGuide_Preset',
    _version: '1.0',
    _exportedAt: new Date().toISOString(),
    settings: { ...s }
  };
  // 移除敏感信息（API Key）
  delete preset.settings.customApiKey;
  delete preset.settings.summaryCustomApiKey;
  delete preset.settings.wiIndexCustomApiKey;
  delete preset.settings.wiRollCustomApiKey;
  // 移除缓存数据
  delete preset.settings.customModelsCache;
  delete preset.settings.summaryCustomModelsCache;
  delete preset.settings.wiIndexCustomModelsCache;
  delete preset.settings.wiRollCustomModelsCache;

  const json = JSON.stringify(preset, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `StoryGuide_Preset_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('预设已导出 ✅', { kind: 'ok' });
}

// 导入全局预设
async function importPreset(file) {
  if (!file) return;

  try {
    const text = await file.text();
    const preset = JSON.parse(text);

    // 验证格式
    if (preset._type !== 'StoryGuide_Preset') {
      showToast('无效的预设文件格式', { kind: 'err' });
      return;
    }

    if (!preset.settings || typeof preset.settings !== 'object') {
      showToast('预设文件内容无效', { kind: 'err' });
      return;
    }

    // 获取当前设置并保留敏感信息
    const currentSettings = ensureSettings();
    const preservedKeys = [
      'customApiKey', 'summaryCustomApiKey', 'wiIndexCustomApiKey', 'wiRollCustomApiKey',
      'customModelsCache', 'summaryCustomModelsCache', 'wiIndexCustomModelsCache', 'wiRollCustomModelsCache'
    ];

    // 合并设置（保留敏感信息）
    const newSettings = { ...preset.settings };
    for (const key of preservedKeys) {
      if (currentSettings[key]) {
        newSettings[key] = currentSettings[key];
      }
    }

    // 应用新设置
    Object.assign(extensionSettings[MODULE_NAME], newSettings);
    saveSettings();

    // 刷新 UI
    pullSettingsToUi();

    showToast(`预设已导入 ✅\n版本: ${preset._version || '未知'}\n导出时间: ${preset._exportedAt || '未知'}`, { kind: 'ok', duration: 3000 });
  } catch (e) {
    console.error('[StoryGuide] Import preset failed:', e);
    showToast(`导入失败: ${e.message}`, { kind: 'err' });
  }
}

function stripHtml(input) {
  if (!input) return '';
  return String(input).replace(/<[^>]*>/g, '').replace(/\s+\n/g, '\n').trim();
}

function escapeHtml(input) {
  const s = String(input ?? '');
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
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

// 简易模板替换：支持 {{fromFloor}} / {{toFloor}} / {{chunk}} 等占位符
function renderTemplate(tpl, vars = {}) {
  const str = String(tpl ?? '');
  return str.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
    const v = vars?.[k];
    return v == null ? '' : String(v);
  });
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

function parseJsonArrayAttr(maybeJsonArray) {
  if (!maybeJsonArray) return [];
  const t = String(maybeJsonArray || '').trim();
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeMapName(name) {
  let out = String(name || '').replace(/\s+/g, ' ').trim();
  // common CN place variants (reduce duplicates like "豪宅/宅邸/府邸/公馆")
  out = out.replace(/(家|宅)(豪宅|宅邸|府邸|公馆|别墅|庄园|大宅|府|宅|宅子)$/g, '宅邸');
  out = out.replace(/(豪宅|府邸|公馆|别墅|庄园|大宅|府|宅|宅子)$/g, '宅邸');
  out = out.replace(/宅邸$/g, '宅邸');
  // broader suffix normalization
  const rules = [
    [/学校$/g, '学校'],
    [/学园$/g, '学校'],
    [/学院$/g, '学校'],
    [/大学$/g, '学校'],
    [/大桥$/g, '桥'],
    [/桥梁$/g, '桥'],
    [/桥$/g, '桥'],
    [/大道$/g, '路'],
    [/大街$/g, '街'],
    [/街道$/g, '街'],
    [/街$/g, '街'],
    [/商业街区$/g, '商业街'],
    [/商业街$/g, '商业街'],
    [/步行街$/g, '商业街'],
    [/购物中心$/g, '商场'],
    [/商城$/g, '商场'],
    [/商场$/g, '商场'],
    [/商业区$/g, '商业区'],
    [/广场$/g, '广场'],
    [/公园$/g, '公园'],
    [/园区$/g, '公园'],
    [/体育馆$/g, '体育馆'],
    [/运动馆$/g, '体育馆'],
    [/体育中心$/g, '体育馆'],
    [/图书馆$/g, '图书馆'],
    [/阅览室$/g, '图书馆'],
    [/医院$/g, '医院'],
    [/诊所$/g, '医院'],
    [/车站$/g, '车站'],
    [/站点$/g, '车站'],
    [/地铁站$/g, '地铁站'],
    [/地铁口$/g, '地铁站'],
    [/机场$/g, '机场'],
    [/港口$/g, '港口'],
    [/码头$/g, '港口'],
    [/旅馆$/g, '旅馆'],
    [/酒店$/g, '旅馆'],
    [/宾馆$/g, '旅馆'],
    [/大厦$/g, '大楼'],
    [/大楼$/g, '大楼'],
    [/楼宇$/g, '大楼'],
    [/楼栋$/g, '大楼'],
    [/中心$/g, '中心'],
    [/森林$/g, '森林'],
    [/林地$/g, '森林'],
    [/树林$/g, '森林'],
    [/山脉$/g, '山'],
    [/高地$/g, '山'],
    [/河流$/g, '河'],
    [/河$/g, '河'],
    [/湖泊$/g, '湖'],
    [/湖$/g, '湖'],
    [/海岸$/g, '海边'],
    [/海滩$/g, '海边'],
    [/海边$/g, '海边'],
    [/地下室$/g, '地下'],
    [/地底$/g, '地下'],
    [/地下$/g, '地下'],
    // fantasy/setting-specific systems
    [/宫殿$/g, '城堡'],
    [/王城$/g, '城堡'],
    [/城堡$/g, '城堡'],
    [/要塞$/g, '城堡'],
    [/城邦$/g, '城堡'],
    [/堡垒$/g, '城堡'],
    [/神殿$/g, '寺庙'],
    [/寺庙$/g, '寺庙'],
    [/道观$/g, '寺庙'],
    [/教堂$/g, '寺庙'],
    [/大教堂$/g, '寺庙'],
    [/修道院$/g, '寺庙'],
    [/洞穴$/g, '洞穴'],
    [/洞窟$/g, '洞穴'],
    [/遗迹$/g, '遗迹'],
    [/秘境$/g, '遗迹'],
    [/秘境之门$/g, '遗迹'],
    [/遗址$/g, '遗迹'],
    [/门派$/g, '宗门'],
    [/宗门$/g, '宗门'],
    [/帮会$/g, '宗门'],
    [/门派驻地$/g, '宗门'],
    [/宗门驻地$/g, '宗门'],
  ];
  for (const [re, rep] of rules) out = out.replace(re, rep);
  return out.toLowerCase();
}

let sgMapPopoverEl = null;
let sgMapPopoverHost = null;
let sgMapEventHandlerBound = false;

function isMapAutoUpdateEnabled(s) {
  const v = s?.mapAutoUpdate;
  if (v === undefined || v === null) return true;
  if (v === false) return false;
  if (typeof v === 'string') return !['false', '0', 'off', 'no'].includes(v.toLowerCase());
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}

function bindMapEventPanelHandler() {
  if (sgMapEventHandlerBound) return;
  sgMapEventHandlerBound = true;

    $(document).on('click', '.sg-map-location', (e) => {
      const $cell = $(e.currentTarget);
      const $wrap = $cell.closest('.sg-map-wrapper');
      let $panel = $wrap.find('.sg-map-event-panel');
      if (!$panel.length) {
        $wrap.append('<div class="sg-map-event-panel"></div>');
        $panel = $wrap.find('.sg-map-event-panel');
      }

    const name = String($cell.attr('data-name') || '').trim();
    const desc = String($cell.attr('data-desc') || '').trim();
    const group = String($cell.attr('data-group') || '').trim();
    const layer = String($cell.attr('data-layer') || '').trim();
    const events = parseJsonArrayAttr($cell.attr('data-events'));

    const headerBits = [];
    if (name) headerBits.push(`<span class="sg-map-event-title">${escapeHtml(name)}</span>`);
    if (layer) headerBits.push(`<span class="sg-map-event-chip">${escapeHtml(layer)}</span>`);
    if (group) headerBits.push(`<span class="sg-map-event-chip">${escapeHtml(group)}</span>`);
      const header = headerBits.length ? `<div class="sg-map-event-header">${headerBits.join('')}</div>` : '';
      const descHtml = desc ? `<div class="sg-map-event-desc">${escapeHtml(desc)}</div>` : '';

      let listHtml = '';
      if (events.length) {
      const items = events.map((ev) => {
        const text = escapeHtml(String(ev?.text || ev?.event || ev || '').trim());
        const tags = Array.isArray(ev?.tags) ? ev.tags : [];
        const tagsHtml = tags.length
          ? `<span class="sg-map-event-tags">${tags.map(t => `<span class="sg-map-event-tag">${escapeHtml(String(t || ''))}</span>`).join('')}</span>`
          : '';
        return `<li><span class="sg-map-event-text">${text || '（无内容）'}</span>${tagsHtml}</li>`;
      }).join('');
      listHtml = `<ul class="sg-map-event-list">${items}</ul>`;
    } else {
      listHtml = '<div class="sg-map-event-empty">暂无事件</div>';
    }

      const deleteBtn = name
        ? `<button class="sg-map-event-delete" data-name="${escapeHtml(name)}">删除地点</button>`
        : '';
      $panel.html(`${header}${descHtml}${listHtml}${deleteBtn}`);
      $panel.addClass('sg-map-event-panel--floating');
    });

    $(document).on('click', '.sg-map-wrapper', (e) => {
      if ($(e.target).closest('.sg-map-location, .sg-map-event-panel').length) return;
      const $wrap = $(e.currentTarget);
      $wrap.find('.sg-map-event-panel').remove();
    });

    $(document).on('click', '.sg-map-event-delete', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const name = String($(e.currentTarget).attr('data-name') || '').trim();
      if (!name) return;
      try {
        const map = getMapData();
        const key = map.locations?.[name] ? name : (normalizeMapName(name) ? Array.from(Object.keys(map.locations || {})).find(k => normalizeMapName(k) === normalizeMapName(name)) : null);
        if (key && map.locations && map.locations[key]) {
          delete map.locations[key];
        }
        for (const loc of Object.values(map.locations || {})) {
          if (!Array.isArray(loc.connections)) continue;
          loc.connections = loc.connections.filter(c => normalizeMapName(c) !== normalizeMapName(name));
        }
        if (map.protagonistLocation && normalizeMapName(map.protagonistLocation) === normalizeMapName(name)) {
          map.protagonistLocation = '';
        }
        await setMapData(map);
        updateMapPreview();
      } catch (err) {
        console.warn('[StoryGuide] delete map location failed:', err);
      }
    });
  }

function showMapPopover($cell) {
  const name = String($cell.attr('data-name') || '').trim();
  const desc = String($cell.attr('data-desc') || '').trim();
  const events = parseJsonArrayAttr($cell.attr('data-events'));

  const parts = [];
  if (name) parts.push(`<div class="sg-map-popover-title">${escapeHtml(name)}</div>`);
  if (desc) parts.push(`<div class="sg-map-popover-desc">${escapeHtml(desc)}</div>`);
  if (events.length) {
    const items = events.map(e => `<li>${escapeHtml(String(e || ''))}</li>`).join('');
    parts.push(`<div class="sg-map-popover-events"><div class="sg-map-popover-label">事件</div><ul>${items}</ul></div>`);
  } else {
    parts.push('<div class="sg-map-popover-empty">暂无事件</div>');
  }

  const $panelHost = $cell.closest('#sg_floating_panel, .sg-modal');
  const usePanel = $panelHost.length > 0;
  const hostEl = usePanel ? $panelHost[0] : document.body;

  if (!sgMapPopoverEl || sgMapPopoverHost !== hostEl) {
    if (sgMapPopoverEl && sgMapPopoverEl.parentElement) {
      sgMapPopoverEl.parentElement.removeChild(sgMapPopoverEl);
    }
    sgMapPopoverEl = document.createElement('div');
    sgMapPopoverEl.className = usePanel ? 'sg-map-popover sg-map-popover-inpanel' : 'sg-map-popover';
    hostEl.appendChild(sgMapPopoverEl);
    sgMapPopoverHost = hostEl;
  } else {
    sgMapPopoverEl.className = usePanel ? 'sg-map-popover sg-map-popover-inpanel' : 'sg-map-popover';
  }

  sgMapPopoverEl.innerHTML = parts.join('');

  const rect = $cell[0].getBoundingClientRect();
  const pop = sgMapPopoverEl;
  pop.style.display = 'block';
  pop.style.visibility = 'hidden';

  const popRect = pop.getBoundingClientRect();
  if (usePanel) {
    const hostRect = hostEl.getBoundingClientRect();
    let left = rect.left - hostRect.left + rect.width / 2 - popRect.width / 2;
    let top = rect.top - hostRect.top - popRect.height - 8;
    if (top < 8) top = rect.bottom - hostRect.top + 8;
    const maxLeft = hostEl.clientWidth - popRect.width - 8;
    const maxTop = hostEl.clientHeight - popRect.height - 8;
    if (left < 8) left = 8;
    if (left > maxLeft) left = maxLeft;
    if (top < 8) top = 8;
    if (top > maxTop) top = maxTop;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  } else {
    let left = rect.left + rect.width / 2 - popRect.width / 2;
    let top = rect.top - popRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  pop.style.visibility = 'visible';
}

// ===== 快捷选项功能 =====

function getQuickOptions() {
  const s = ensureSettings();
  if (!s.quickOptionsEnabled) return [];

  const raw = String(s.quickOptionsJson || '').trim();
  if (!raw) return [];

  try {
    let arr = JSON.parse(raw);
    // 支持 [[label, prompt], ...] 和 [{label, prompt}, ...] 两种格式
    if (!Array.isArray(arr)) return [];
    return arr.map((item, i) => {
      if (Array.isArray(item)) {
        return { label: String(item[0] || `选项${i + 1}`), prompt: String(item[1] || '') };
      }
      if (item && typeof item === 'object') {
        return { label: String(item.label || `选项${i + 1}`), prompt: String(item.prompt || '') };
      }
      return null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function injectToUserInput(text) {
  // 尝试多种可能的输入框选择器
  const selectors = ['#send_textarea', 'textarea#send_textarea', '.send_textarea', 'textarea.send_textarea'];
  let textarea = null;

  for (const sel of selectors) {
    textarea = document.querySelector(sel);
    if (textarea) break;
  }

  if (!textarea) {
    console.warn('[StoryGuide] 未找到聊天输入框');
    return false;
  }

  // 设置文本值
  textarea.value = String(text || '');

  // 触发 input 事件以通知 SillyTavern
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  // 聚焦输入框
  textarea.focus();

  // 将光标移到末尾
  if (textarea.setSelectionRange) {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  return true;
}

function renderQuickOptionsHtml(context = 'inline') {
  const s = ensureSettings();
  if (!s.quickOptionsEnabled) return '';

  const showIn = String(s.quickOptionsShowIn || 'inline');
  // 检查当前上下文是否应该显示
  if (showIn !== 'both' && showIn !== context) return '';

  const options = getQuickOptions();
  if (!options.length) return '';

  const buttons = options.map((opt, i) => {
    const label = escapeHtml(opt.label || `选项${i + 1}`);
    const prompt = escapeHtml(opt.prompt || '');
    return `<button class="sg-quick-option" data-sg-prompt="${prompt}" title="${prompt}">${label}</button>`;
  }).join('');

  return `<div class="sg-quick-options">${buttons}</div>`;
}

// 渲染AI生成的动态快捷选项（从分析结果的quick_actions数组生成按钮，直接显示选项内容）
function renderDynamicQuickActionsHtml(quickActions, context = 'inline') {
  const s = ensureSettings();

  // 如果没有动态选项，返回空
  if (!Array.isArray(quickActions) || !quickActions.length) {
    return '';
  }

  const buttons = quickActions.map((action, i) => {
    const text = String(action || '').trim();
    if (!text) return '';

    // 移除可能的编号前缀如 "【1】" 或 "1."
    const cleaned = text.replace(/^【\d+】\s*/, '').replace(/^\d+[\.\)\:：]\s*/, '').trim();
    if (!cleaned) return '';

    const escapedText = escapeHtml(cleaned);
    // 按钮直接显示完整选项内容，点击后输入到聊天框
    return `<button class="sg-quick-option sg-dynamic-option" data-sg-prompt="${escapedText}" title="点击输入到聊天框">${escapedText}</button>`;
  }).filter(Boolean).join('');

  if (!buttons) return '';

  return `<div class="sg-quick-options sg-dynamic-options">
    <div class="sg-quick-options-title">💡 快捷选项（点击输入）</div>
    ${buttons}
  </div>`;
}

function installQuickOptionsClickHandler() {
  if (window.__storyguide_quick_options_installed) return;
  window.__storyguide_quick_options_installed = true;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.sg-quick-option');
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const prompt = btn.dataset.sgPrompt || '';
    if (prompt) {
      injectToUserInput(prompt);
    }
  }, true);
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

// -------------------- summary meta (per chat) --------------------
function getDefaultSummaryMeta() {
  return {
    lastFloor: 0,
    lastChatLen: 0,
    // 用于“索引编号触发”（A-001/A-002…）的递增计数器（按聊天存储）
    nextIndex: 1,
    history: [], // [{title, summary, keywords, createdAt, range:{fromFloor,toFloor,fromIdx,toIdx}, worldInfo:{file,uid}}]
    wiTriggerLogs: [], // [{ts,userText,picked:[{title,score,keywordsPreview}], injectedKeywords, lookback, style, tag}]
    rollLogs: [], // [{ts, action, summary, final, success, userText}]
    // 结构化条目缓存（用于去重与更新 - 方案C混合策略）
    characterEntries: {}, // { uid: { name, aliases, lastUpdated, wiEntryUid, content } }
    equipmentEntries: {}, // { uid: { name, aliases, lastUpdated, wiEntryUid, content } }
    abilityEntries: {}, // { uid: { name, lastUpdated, wiEntryUid, content } }
    nextCharacterIndex: 1, // NPC-001, NPC-002...
    nextEquipmentIndex: 1, // EQP-001, EQP-002...
    nextAbilityIndex: 1, // ABL-001, ABL-002...
  };
}

function getSummaryMeta() {
  const raw = String(getChatMetaValue(META_KEYS.summaryMeta) || '').trim();
  if (!raw) return getDefaultSummaryMeta();
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return getDefaultSummaryMeta();
    return {
      ...getDefaultSummaryMeta(),
      ...data,
      history: Array.isArray(data.history) ? data.history : [],
      wiTriggerLogs: Array.isArray(data.wiTriggerLogs) ? data.wiTriggerLogs : [],
      rollLogs: Array.isArray(data.rollLogs) ? data.rollLogs : [],
    };
  } catch {
    return getDefaultSummaryMeta();
  }
}

async function setSummaryMeta(meta) {
  await setChatMetaValue(META_KEYS.summaryMeta, JSON.stringify(meta ?? getDefaultSummaryMeta()));
}

// ===== 静态模块缓存（只在首次或手动刷新时生成的模块结果）=====
function getStaticModulesCache() {
  const raw = String(getChatMetaValue(META_KEYS.staticModulesCache) || '').trim();
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch {
    return {};
  }
}

async function setStaticModulesCache(cache) {
  await setChatMetaValue(META_KEYS.staticModulesCache, JSON.stringify(cache ?? {}));
}

// ===== 地图数据（网格地图功能）=====
function getDefaultMapData() {
  return {
    locations: {},
    protagonistLocation: '',
    gridSize: { rows: 5, cols: 7 },
    lastUpdated: null,
  };
}

function getMapData() {
  const raw = String(getChatMetaValue(META_KEYS.mapData) || '').trim();
  if (!raw) return getDefaultMapData();
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return getDefaultMapData();
    return {
      ...getDefaultMapData(),
      ...data,
      locations: (data.locations && typeof data.locations === 'object') ? data.locations : {},
    };
  } catch {
    return getDefaultMapData();
  }
}

async function setMapData(mapData) {
  await setChatMetaValue(META_KEYS.mapData, JSON.stringify(mapData ?? getDefaultMapData()));
}

// 更新地图预览
function updateMapPreview() {
  try {
    const mapData = getMapData();
    const html = renderGridMap(mapData);
    const $preview = $('#sg_mapPreview');
    if ($preview.length) {
      $preview.html(html);
    }
  } catch (e) {
    console.warn('[StoryGuide] updateMapPreview error:', e);
  }
}

const MAP_JSON_REQUIREMENT = `输出要求：
- 只输出严格 JSON，不要 Markdown、不要代码块、不要任何多余文字。`;

function getMapSchema() {
  return {
    type: 'object',
    properties: {
      currentLocation: { type: 'string' },
      newLocations: {
        type: 'array',
        items: {
          type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              connectedTo: { type: 'array', items: { type: 'string' } },
              group: { type: 'string' },
              layer: { type: 'string' },
              row: { type: 'number' },
              col: { type: 'number' },
            },
          required: ['name'],
          additionalProperties: true,
        },
      },
      events: {
        type: 'array',
        items: {
          type: 'object',
            properties: {
              location: { type: 'string' },
              event: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          required: ['location', 'event'],
          additionalProperties: true,
        },
      },
    },
    required: ['currentLocation', 'newLocations', 'events'],
    additionalProperties: true,
  };
}

function buildMapPromptMessages(snapshotText) {
  const s = ensureSettings();
  let sys = String(s.mapSystemPrompt || '').trim();
  if (!sys) sys = String(DEFAULT_SETTINGS.mapSystemPrompt || '').trim();
  sys = sys + '\n\n' + MAP_JSON_REQUIREMENT;
  const user = String(snapshotText || '').trim();
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

async function updateMapFromSnapshot(snapshotText) {
  const s = ensureSettings();
  if (!s.mapEnabled) return;
  if (!isMapAutoUpdateEnabled(s)) return;
  const user = String(snapshotText || '').trim();
  if (!user) return;

  try {
    const messages = buildMapPromptMessages(user);
    let jsonText = '';
    if (s.provider === 'custom') {
      jsonText = await callViaCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, s.customMaxTokens, s.customTopP, s.customStream);
    } else {
      jsonText = await callViaSillyTavern(messages, getMapSchema(), s.temperature);
      if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
    }

    let parsed = parseMapLLMResponse(jsonText);
    if (!parsed) {
      try {
        const retryText = (s.provider === 'custom')
          ? await fallbackAskJsonCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, s.customMaxTokens, s.customTopP, s.customStream)
          : await fallbackAskJson(messages, s.temperature);
        parsed = parseMapLLMResponse(retryText);
      } catch { /* ignore */ }
    }
      if (!parsed) return;

      if (parsed?.newLocations) {
        parsed.newLocations = normalizeNewLocations(parsed.newLocations);
      }
      parsed = ensureMapMinimums(parsed);

      const merged = mergeMapData(getMapData(), parsed);
    await setMapData(merged);
    updateMapPreview();
  } catch (e) {
    console.warn('[StoryGuide] map update failed:', e);
  }
}

// 合并静态模块缓存到分析结果中
function mergeStaticModulesIntoResult(parsedJson, modules) {
  const cache = getStaticModulesCache();
  const result = { ...parsedJson };

  for (const m of modules) {
    if (m.static && cache[m.key] !== undefined) {
      // 使用缓存值替代（如果AI此次没生成或我们跳过了生成）
      if (result[m.key] === undefined || result[m.key] === null || result[m.key] === '') {
        result[m.key] = cache[m.key];
      }
    }
  }

  return result;
}

// 更新静态模块缓存
async function updateStaticModulesCache(parsedJson, modules) {
  const cache = getStaticModulesCache();
  let changed = false;

  for (const m of modules) {
    if (m.static && parsedJson[m.key] !== undefined && parsedJson[m.key] !== null && parsedJson[m.key] !== '') {
      // 只在首次生成或值有变化时更新缓存
      if (cache[m.key] === undefined || JSON.stringify(cache[m.key]) !== JSON.stringify(parsedJson[m.key])) {
        cache[m.key] = parsedJson[m.key];
        changed = true;
      }
    }
  }

  if (changed) {
    await setStaticModulesCache(cache);
  }
}

// ===== 地图功能：提取和渲染 =====

// 从 LLM 响应中提取地图数据
function parseMapLLMResponse(responseText) {
  const parsed = safeJsonParse(responseText);
  if (!parsed) return null;
  return {
    currentLocation: String(parsed.currentLocation || '').trim(),
    newLocations: Array.isArray(parsed.newLocations) ? parsed.newLocations : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
  };
}

function ensureMapMinimums(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const out = {
    currentLocation: String(parsed.currentLocation || '').trim(),
    newLocations: Array.isArray(parsed.newLocations) ? parsed.newLocations.slice() : [],
    events: Array.isArray(parsed.events) ? parsed.events.slice() : [],
  };

  const existingNames = new Set(
    out.newLocations.map(l => String(l?.name || '').trim()).filter(Boolean)
  );

  let exploreCount = 0;
  for (const loc of out.newLocations) {
    const desc = String(loc?.description || '').trim();
    if (desc.includes('待探索')) exploreCount += 1;
  }

  const desiredMin = 3;
  const desiredExploreMin = 2;
  const neededTotal = Math.max(0, desiredMin - out.newLocations.length);
  const neededExplore = Math.max(0, desiredExploreMin - exploreCount);
  const addCount = Math.max(neededTotal, neededExplore);

  if (addCount > 0) {
    const baseName = out.currentLocation ? `${out.currentLocation}·待探索` : '待探索地点';
    for (let i = 0; i < addCount; i++) {
      let name = `${baseName}${i + 1}`;
      let n = 1;
      while (existingNames.has(name)) {
        n += 1;
        name = `${baseName}${i + 1}-${n}`;
      }
      existingNames.add(name);
      out.newLocations.push({
        name,
        description: '待探索',
        connectedTo: out.currentLocation ? [out.currentLocation] : [],
        group: '',
        layer: '',
      });
    }
  }

  return out;
}

function normalizeNewLocations(list) {
  const result = [];
  const seen = new Map();
  for (const loc of Array.isArray(list) ? list : []) {
    const rawName = String(loc?.name || '').trim();
    if (!rawName) continue;
    const key = normalizeMapName(rawName);
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, {
        ...loc,
        name: rawName,
        connectedTo: Array.isArray(loc.connectedTo) ? loc.connectedTo.slice() : [],
      });
      result.push(seen.get(key));
      continue;
    }
    const existing = seen.get(key);
    // Merge connections
    const conn = Array.isArray(loc.connectedTo) ? loc.connectedTo : [];
    for (const c of conn) {
      if (!existing.connectedTo.includes(c)) existing.connectedTo.push(c);
    }
    // Prefer non-empty description/group/layer
    if (!existing.description && loc.description) existing.description = loc.description;
    if (!existing.group && loc.group) existing.group = loc.group;
    if (!existing.layer && loc.layer) existing.layer = loc.layer;
    // Prefer valid coordinates if existing lacks
    const hasRow = Number.isFinite(Number(existing.row));
    const hasCol = Number.isFinite(Number(existing.col));
    const newRow = Number.isFinite(Number(loc.row)) ? Number(loc.row) : null;
    const newCol = Number.isFinite(Number(loc.col)) ? Number(loc.col) : null;
    if ((!hasRow || !hasCol) && newRow != null && newCol != null) {
      existing.row = newRow;
      existing.col = newCol;
    }
  }
  return result;
}

function normalizeMapEvent(evt) {
  if (typeof evt === 'string') return { text: evt, tags: [] };
  if (!evt || typeof evt !== 'object') return null;
  const text = String(evt.event || evt.text || '').trim();
  if (!text) return null;
  const tags = Array.isArray(evt.tags) ? evt.tags.map(t => String(t || '').trim()).filter(Boolean) : [];
  return { text, tags };
}

function formatMapEventText(evt) {
  const text = typeof evt === 'string' ? evt : String(evt?.text || evt?.event || '').trim();
  const tags = Array.isArray(evt?.tags) ? evt.tags : [];
  const tagText = tags.length ? ` [${tags.join('/')}]` : '';
  return `${text}${tagText}`.trim();
}


// 合并新地图数据到现有地图
function mergeMapData(existingMap, newData) {
  if (!newData) return existingMap;

  const map = { ...existingMap, locations: { ...existingMap.locations } };
  const existingNameMap = new Map();
  for (const key of Object.keys(map.locations)) {
    const norm = normalizeMapName(key);
    if (norm) existingNameMap.set(norm, key);
  }

  // 更新主角位置
  if (newData.currentLocation) {
    const normalized = normalizeMapName(newData.currentLocation);
    const existingKey = existingNameMap.get(normalized);
    map.protagonistLocation = existingKey || newData.currentLocation;
    // 确保当前位置存在
    if (!map.locations[map.protagonistLocation]) {
      map.locations[map.protagonistLocation] = {
        row: 0, col: 0, connections: [], events: [], visited: true, description: ''
      };
    }
    map.locations[map.protagonistLocation].visited = true;
  }

  // 添加新地点
  for (const loc of newData.newLocations) {
    const name = String(loc.name || '').trim();
    if (!name) continue;
    const normalized = normalizeMapName(name);
    const existingKey = existingNameMap.get(normalized);
    const targetKey = existingKey || name;

    if (!map.locations[targetKey]) {
      let row = Number.isFinite(Number(loc.row)) ? Number(loc.row) : null;
      let col = Number.isFinite(Number(loc.col)) ? Number(loc.col) : null;
      if (row == null || col == null) {
        const anchorName = Array.isArray(loc.connectedTo)
          ? loc.connectedTo.map(x => String(x || '').trim()).find(n => map.locations[n])
          : null;
        if (anchorName) {
          const anchor = map.locations[anchorName];
          const pos = findAdjacentGridPosition(map, anchor.row, anchor.col);
          row = pos.row;
          col = pos.col;
        } else {
          const pos = findNextGridPosition(map);
          row = pos.row;
          col = pos.col;
        }
      }
      map.locations[targetKey] = {
        row, col,
        connections: Array.isArray(loc.connectedTo) ? loc.connectedTo : [],
        events: [],
        visited: targetKey === map.protagonistLocation,
        description: String(loc.description || ''),
        group: String(loc.group || '').trim(),
        layer: String(loc.layer || '').trim(),
      };
      ensureGridSize(map, row, col);
      if (!existingKey && normalized) existingNameMap.set(normalized, targetKey);
    } else {
      // 更新现有地点的连接
      if (Array.isArray(loc.connectedTo)) {
        for (const conn of loc.connectedTo) {
          if (!map.locations[targetKey].connections.includes(conn)) {
            map.locations[targetKey].connections.push(conn);
          }
        }
      }
      if (loc.group) map.locations[targetKey].group = String(loc.group || '').trim();
      if (loc.layer) map.locations[targetKey].layer = String(loc.layer || '').trim();
      const hasRow = Number.isFinite(Number(map.locations[targetKey].row));
      const hasCol = Number.isFinite(Number(map.locations[targetKey].col));
      const newRow = Number.isFinite(Number(loc.row)) ? Number(loc.row) : null;
      const newCol = Number.isFinite(Number(loc.col)) ? Number(loc.col) : null;
      if ((!hasRow || !hasCol) && newRow != null && newCol != null) {
        map.locations[targetKey].row = newRow;
        map.locations[targetKey].col = newCol;
        ensureGridSize(map, map.locations[targetKey].row, map.locations[targetKey].col);
      }
    }
  }

  // 添加事件
  for (const evt of newData.events) {
    const locName = String(evt.location || '').trim();
    const normalized = normalizeMapName(locName);
    const targetKey = existingNameMap.get(normalized) || locName;
    const eventObj = normalizeMapEvent(evt);
    if (locName && eventObj && map.locations[targetKey]) {
      const list = Array.isArray(map.locations[targetKey].events) ? map.locations[targetKey].events : [];
      const exists = list.some(e => String(e?.text || e?.event || e || '').trim() === eventObj.text);
      if (!exists) list.push(eventObj);
      map.locations[targetKey].events = list;
    }
  }

  // 更新双向连接
  for (const [name, loc] of Object.entries(map.locations)) {
    for (const conn of loc.connections) {
      if (map.locations[conn] && !map.locations[conn].connections.includes(name)) {
        map.locations[conn].connections.push(name);
      }
    }
  }

  map.lastUpdated = new Date().toISOString();
  return map;
}

function findAdjacentGridPosition(map, baseRow, baseCol) {
  const occupied = new Set();
  for (const loc of Object.values(map.locations)) {
    occupied.add(`${loc.row},${loc.col}`);
  }
  const candidates = [
    { row: baseRow - 1, col: baseCol },
    { row: baseRow + 1, col: baseCol },
    { row: baseRow, col: baseCol - 1 },
    { row: baseRow, col: baseCol + 1 },
    { row: baseRow - 1, col: baseCol - 1 },
    { row: baseRow - 1, col: baseCol + 1 },
    { row: baseRow + 1, col: baseCol - 1 },
    { row: baseRow + 1, col: baseCol + 1 },
  ];
  for (const pos of candidates) {
    if (pos.row < 0 || pos.col < 0) continue;
    if (!occupied.has(`${pos.row},${pos.col}`)) return pos;
  }
  return findNextGridPosition(map);
}

function ensureGridSize(map, row, col) {
  if (!map || !map.gridSize) return;
  const r = Number(row);
  const c = Number(col);
  if (!Number.isFinite(r) || !Number.isFinite(c)) return;
  if (r >= map.gridSize.rows) map.gridSize.rows = r + 1;
  if (c >= map.gridSize.cols) map.gridSize.cols = c + 1;
}

// 寻找网格中的下一个空位
function findNextGridPosition(map) {
  const occupied = new Set();
  for (const loc of Object.values(map.locations)) {
    occupied.add(`${loc.row},${loc.col}`);
  }

  for (let r = 0; r < map.gridSize.rows; r++) {
    for (let c = 0; c < map.gridSize.cols; c++) {
      if (!occupied.has(`${r},${c}`)) {
        return { row: r, col: c };
      }
    }
  }
  // 扩展网格
  map.gridSize.rows++;
  return { row: map.gridSize.rows - 1, col: 0 };
}

// 渲染网格地图为 HTML（纯 HTML/CSS 网格）
function renderGridMap(mapData) {
  if (!mapData || Object.keys(mapData.locations).length === 0) {
    return `<div class="sg-map-empty">暂无地图数据。开启地图功能并进行剧情分析后，地图将自动生成。</div>`;
  }

  const locList = Object.values(mapData.locations);
  const rawRows = locList.map(l => Number(l.row)).filter(Number.isFinite);
  const rawCols = locList.map(l => Number(l.col)).filter(Number.isFinite);
  const rowVals = Array.from(new Set(rawRows)).sort((a, b) => a - b);
  const colVals = Array.from(new Set(rawCols)).sort((a, b) => a - b);
  const maxDim = 20;
  const rowCount = Math.max(mapData.gridSize.rows, rowVals.length || mapData.gridSize.rows);
  const colCount = Math.max(mapData.gridSize.cols, colVals.length || mapData.gridSize.cols);
  const rows = Math.min(maxDim, rowCount);
  const cols = Math.min(maxDim, colCount);

  const mapIndex = (vals, v, limit) => {
    const idx = vals.indexOf(v);
    if (idx < 0) return null;
    if (vals.length <= limit) return idx;
    return Math.round(idx * (limit - 1) / Math.max(1, vals.length - 1));
  };

  const findNextEmptyCell = (grid, startRow, startCol) => {
    const rLen = grid.length;
    const cLen = grid[0]?.length || 0;
    for (let r = startRow; r < rLen; r++) {
      for (let c = (r === startRow ? startCol : 0); c < cLen; c++) {
        if (!grid[r][c]) return { row: r, col: c };
      }
    }
    for (let r = 0; r < rLen; r++) {
      for (let c = 0; c < cLen; c++) {
        if (!grid[r][c]) return { row: r, col: c };
      }
    }
    return null;
  };

  const grid = Array(rows).fill(null).map(() => Array(cols).fill(null));

  // 填充网格
  for (const [name, loc] of Object.entries(mapData.locations)) {
    const rr = mapIndex(rowVals, Number(loc.row), rows);
    const cc = mapIndex(colVals, Number(loc.col), cols);
    if (Number.isFinite(rr) && Number.isFinite(cc) && rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
      if (!grid[rr][cc]) {
        grid[rr][cc] = { name, ...loc };
      } else {
        const next = findNextEmptyCell(grid, rr, cc);
        if (next) grid[next.row][next.col] = { name, ...loc };
      }
    }
  }

  // 渲染 HTML（使用 CSS Grid）
  const gridInlineStyle = `display:grid;grid-template-columns:repeat(${cols},80px);grid-auto-rows:50px;gap:4px;justify-content:center;`;
  const baseCellStyle = 'width:80px;height:50px;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;text-align:center;position:relative;';
  const emptyCellStyle = baseCellStyle + 'background:rgba(255,255,255,0.03);border:1px dashed rgba(255,255,255,0.08);';
  const locationBaseStyle = baseCellStyle + 'background:rgba(100,150,200,0.2);border:1px solid rgba(100,150,200,0.35);';

  let html = `<div class="sg-map-wrapper">`;
  html += `<div class="sg-map-grid" style="--sg-map-cols:${cols};${gridInlineStyle}">`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      if (cell) {
        const isProtagonist = cell.name === mapData.protagonistLocation;
        const hasEvents = cell.events && cell.events.length > 0;
        const classes = ['sg-map-cell', 'sg-map-location'];
        if (isProtagonist) classes.push('sg-map-protagonist');
        if (hasEvents) classes.push('sg-map-has-events');
        if (!cell.visited) classes.push('sg-map-unvisited');

          const eventList = hasEvents ? cell.events.map(e => `• ${formatMapEventText(e)}`).join('\n') : '';
          const tooltip = `${cell.name}${cell.description ? '\n' + cell.description : ''}${eventList ? '\n---\n' + eventList : ''}`;

        let inlineStyle = locationBaseStyle;
        if (isProtagonist) inlineStyle += 'background:rgba(100,200,100,0.25);border-color:rgba(100,200,100,0.5);box-shadow:0 0 8px rgba(100,200,100,0.3);';
        if (hasEvents) inlineStyle += 'border-color:rgba(255,180,80,0.5);';
        if (!cell.visited) inlineStyle += 'background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.1);opacity:0.6;';
          const eventsJson = escapeHtml(JSON.stringify(Array.isArray(cell.events) ? cell.events : []));
          const descAttr = escapeHtml(String(cell.description || ''));
          const nameAttr = escapeHtml(String(cell.name || ''));
          const groupAttr = escapeHtml(String(cell.group || ''));
          const layerAttr = escapeHtml(String(cell.layer || ''));
          html += `<div class="${classes.join(' ')}" style="${inlineStyle}" title="${escapeHtml(tooltip)}" data-name="${nameAttr}" data-desc="${descAttr}" data-events="${eventsJson}" data-group="${groupAttr}" data-layer="${layerAttr}">`;
          if (cell.layer || cell.group) {
            html += `<div class="sg-map-badges">`;
            if (cell.layer) html += `<span class="sg-map-badge sg-map-badge-layer" title="${escapeHtml(String(cell.layer))}">${escapeHtml(String(cell.layer || '').slice(0, 2))}</span>`;
            if (cell.group) html += `<span class="sg-map-badge sg-map-badge-group" title="${escapeHtml(String(cell.group))}">${escapeHtml(String(cell.group || '').slice(0, 2))}</span>`;
            html += `</div>`;
          }
          html += `<span class="sg-map-name">${escapeHtml(cell.name)}</span>`;
        if (isProtagonist) html += '<span class="sg-map-marker">★</span>';
        if (hasEvents) html += '<span class="sg-map-event-marker">⚔</span>';
        html += '</div>';
      } else {
        html += `<div class="sg-map-cell sg-map-empty-cell" style="${emptyCellStyle}"></div>`;
      }
    }
  }

    html += '</div>';
    html += '<div class="sg-map-legend">★ 主角位置 | ⚔ 有事件 | 灰色 = 未探索</div>';
    html += '<div class="sg-map-event-panel">点击地点查看事件列表</div>';
    html += '</div>';

  return html;
}

// 清除静态模块缓存（手动刷新时使用）
async function clearStaticModulesCache() {
  await setStaticModulesCache({});
}

// 清除结构化条目缓存（人物/装备/能力）
async function clearStructuredEntriesCache() {
  const meta = getSummaryMeta();
  meta.characterEntries = {};
  meta.equipmentEntries = {};
  meta.abilityEntries = {};
  meta.nextCharacterIndex = 1;
  meta.nextEquipmentIndex = 1;
  meta.nextAbilityIndex = 1;
  await setSummaryMeta(meta);
}

// -------------------- 自动绑定世界书（每个聊天专属世界书） --------------------
// 生成唯一的世界书文件名
function generateBoundWorldInfoName(type) {
  const ctx = SillyTavern.getContext();
  const charName = String(ctx.characterId || ctx.name2 || ctx.name || 'UnknownChar')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '')
    .slice(0, 20);
  const ts = Date.now().toString(36);
  const prefix = ensureSettings().autoBindWorldInfoPrefix || 'SG';
  return `${prefix}_${charName}_${ts}_${type}`;
}

// 检查并确保当前聊天启用了自动绑定（使用 chatbook 模式）
async function ensureBoundWorldInfo(opts = {}) {
  const s = ensureSettings();
  if (!s.autoBindWorldInfo) return false;

  const alreadyApplied = !!getChatMetaValue(META_KEYS.autoBindCreated);

  // 如果已经应用过，只需重新应用设置
  if (alreadyApplied) {
    await applyBoundWorldInfoToSettings();
    return false;
  }

  // 首次启用：设置标记并应用
  await setChatMetaValue(META_KEYS.autoBindCreated, '1');

  // 显示用户提示
  showToast(`已启用自动写入世界书\n绿灯总结将写入聊天绑定的世界书\n（由 SillyTavern 自动创建和管理）`, {
    kind: 'ok', spinner: false, sticky: false, duration: 3500
  });

  // 应用设置
  await applyBoundWorldInfoToSettings();
  return true;
}

// 创建世界书文件（通过多种方法尝试）
async function createWorldInfoFile(fileName, initialContent = '初始化条目') {
  if (!fileName) throw new Error('文件名为空');

  console.log('[StoryGuide] 尝试创建世界书文件:', fileName);

  // 方法1: 尝试使用 SillyTavern 内部的 world_info 模块
  try {
    const worldInfoModule = await import('/scripts/world-info.js');
    if (worldInfoModule && typeof worldInfoModule.createNewWorldInfo === 'function') {
      await worldInfoModule.createNewWorldInfo(fileName);
      console.log('[StoryGuide] 使用内部模块创建成功:', fileName);
      return true;
    }
  } catch (e) {
    console.log('[StoryGuide] 内部模块方法失败:', e?.message || e);
  }

  // 方法2: 尝试使用导入 API (模拟文件上传)
  try {
    const headers = getStRequestHeadersCompat();
    const worldInfoData = {
      entries: {
        0: {
          uid: 0,
          key: ['__SG_INIT__'],
          keysecondary: [],
          comment: '由 StoryGuide 自动创建',
          content: initialContent,
          constant: false,
          disable: false,
          order: 100,
          position: 0,
        }
      }
    };

    // 创建一个 Blob 作为 JSON 文件
    const blob = new Blob([JSON.stringify(worldInfoData)], { type: 'application/json' });
    const formData = new FormData();
    formData.append('avatar', blob, `${fileName}.json`);

    const res = await fetch('/api/worldinfo/import', {
      method: 'POST',
      headers: { ...headers },
      body: formData,
    });

    if (res.ok) {
      console.log('[StoryGuide] 使用导入 API 创建成功:', fileName);
      return true;
    }
    console.log('[StoryGuide] 导入 API 响应:', res.status);
  } catch (e) {
    console.log('[StoryGuide] 导入 API 方法失败:', e?.message || e);
  }

  // 方法3: 尝试直接 POST 到 /api/worldinfo/edit (编辑/创建)
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...getStRequestHeadersCompat(),
    };

    const res = await fetch('/api/worldinfo/edit', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: fileName,
        data: {
          entries: {
            0: {
              uid: 0,
              key: ['__SG_INIT__'],
              content: initialContent,
              comment: '由 StoryGuide 自动创建',
            }
          }
        }
      }),
    });

    if (res.ok) {
      console.log('[StoryGuide] 使用 edit API 创建成功:', fileName);
      return true;
    }
    console.log('[StoryGuide] edit API 响应:', res.status);
  } catch (e) {
    console.log('[StoryGuide] edit API 方法失败:', e?.message || e);
  }

  // 方法4: 最后尝试 STscript (可能需要文件已存在)
  try {
    const safeFileName = quoteSlashValue(fileName);
    const safeKey = quoteSlashValue('__SG_INIT__');
    const safeContent = quoteSlashValue(initialContent);
    const cmd = `/createentry file=${safeFileName} key=${safeKey} ${safeContent}`;
    await execSlash(cmd);
    console.log('[StoryGuide] STscript 方式可能成功');
    return true;
  } catch (e) {
    console.log('[StoryGuide] STscript 方式失败:', e?.message || e);
  }

  // 所有方法都失败 - 显示警告但不阻断
  console.warn('[StoryGuide] 无法自动创建世界书文件，请手动创建:', fileName);
  return false;
}

// 解析当前聊天绑定的 chatbook 文件名（用于持久绑定）
async function resolveChatbookFileName() {
  const varName = '__sg_chatbook_name';
  try {
    const out = await execSlash(`/getchatbook | /setvar key=${varName} | /getvar ${varName} | /flushvar ${varName}`);
    const raw = slashOutputToText(out).trim();
    if (!raw) return '';
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const name = lines[lines.length - 1] || '';
    return name.replace(/^"+|"+$/g, '');
  } catch (e) {
    console.warn('[StoryGuide] resolveChatbookFileName failed:', e?.message || e);
    return '';
  }
}

// 将绑定的世界书应用到设置
async function applyBoundWorldInfoToSettings() {
  const s = ensureSettings();
  if (!s.autoBindWorldInfo) return;

  console.log('[StoryGuide] 应用自动绑定设置（使用 chatbook 模式）');

  let greenWI = String(getChatMetaValue(META_KEYS.boundGreenWI) || '').trim();
  if (!greenWI) {
    greenWI = await resolveChatbookFileName();
    if (greenWI) await setChatMetaValue(META_KEYS.boundGreenWI, greenWI);
  }

  // 绿灯世界书：优先使用已解析的绑定文件名，避免切换/刷新后产生新文件
  s.summaryToWorldInfo = true;
  if (greenWI) {
    s.summaryWorldInfoTarget = 'file';
    s.summaryWorldInfoFile = greenWI;
    console.log('[StoryGuide] 绿灯设置: file（绑定文件）', greenWI);
  } else {
    s.summaryWorldInfoTarget = 'chatbook';
    s.summaryWorldInfoFile = '';
    console.log('[StoryGuide] 绿灯设置: chatbook（将使用聊天绑定的世界书）');
  }

  // 蓝灯世界书：暂时禁用（因为无法自动创建独立文件）
  // 用户如需蓝灯功能，需要手动创建世界书文件并在设置中指定
  s.summaryToBlueWorldInfo = false;
  console.log('[StoryGuide] 蓝灯设置: 禁用（无法自动创建独立文件）');

  // 更新 UI（如果面板已打开）
  updateAutoBindUI();
  saveSettings();
}

// 更新自动绑定UI显示
function updateAutoBindUI() {
  const s = ensureSettings();
  const $info = $('#sg_autoBindInfo');

  if ($info.length) {
    if (s.autoBindWorldInfo) {
      $info.html(`<span style="color: var(--SmartThemeQuoteColor)">✅ 已启用：总结将写入聊天绑定的世界书</span>`);
      $info.show();
    } else {
      $info.hide();
    }
  }
}

// 聊天切换时的处理（带提示）
async function onChatSwitched() {
  const s = ensureSettings();

  console.log('[StoryGuide] onChatSwitched 被调用, autoBindWorldInfo =', s.autoBindWorldInfo);

  if (!s.autoBindWorldInfo) {
    console.log('[StoryGuide] autoBindWorldInfo 未开启，跳过自动绑定');
    return;
  }

  // 等待 chatMetadata 加载完成（增加重试机制）
  let retries = 0;
  const maxRetries = 5;
  while (retries < maxRetries) {
    await new Promise(r => setTimeout(r, 200));
    const { chatMetadata } = SillyTavern.getContext();
    if (chatMetadata && Object.keys(chatMetadata).length > 0) {
      console.log('[StoryGuide] chatMetadata 已加载，keys:', Object.keys(chatMetadata).length);
      break;
    }
    retries++;
    console.log(`[StoryGuide] 等待 chatMetadata 加载... (${retries}/${maxRetries})`);
  }

  const greenWI = getChatMetaValue(META_KEYS.boundGreenWI);
  const blueWI = getChatMetaValue(META_KEYS.boundBlueWI);
  const autoBindCreated = getChatMetaValue(META_KEYS.autoBindCreated);

  console.log('[StoryGuide] 当前聊天绑定信息:', { greenWI, blueWI, autoBindCreated });

  // 如果已经创建过绑定（即使 greenWI 为空也尝试恢复）
  if (autoBindCreated || greenWI || blueWI) {
    console.log('[StoryGuide] 恢复已有绑定');
    await applyBoundWorldInfoToSettings();
    const greenNow = String(getChatMetaValue(META_KEYS.boundGreenWI) || greenWI || '').trim();
    showToast(`已切换到本聊天专属世界书\n绿灯：${greenNow || '(无)'}\n蓝灯：${blueWI || '(无)'}`, {
      kind: 'info', spinner: false, sticky: false, duration: 2500
    });
  } else {
    console.log('[StoryGuide] 新聊天，需要创建绑定');
    await ensureBoundWorldInfo();
  }
}

function setStatus(text, kind = '') {
  const $s = $('#sg_status');
  $s.removeClass('ok err warn').addClass(kind || '');
  $s.text(text || '');
}


function ensureToast() {
  if ($('#sg_toast').length) return;
  $('body').append(`
    <div id="sg_toast" class="sg-toast info" style="display:none" role="status" aria-live="polite">
      <div class="sg-toast-inner">
        <div class="sg-toast-spinner" aria-hidden="true"></div>
        <div class="sg-toast-text" id="sg_toast_text"></div>
      </div>
    </div>
  `);
}

function hideToast() {
  const $t = $('#sg_toast');
  if (!$t.length) return;
  $t.removeClass('visible spinner');
  // delay hide for transition
  setTimeout(() => { $t.hide(); }, 180);
}

function showToast(text, { kind = 'info', spinner = false, sticky = false, duration = 1700 } = {}) {
  ensureToast();
  const $t = $('#sg_toast');
  const $txt = $('#sg_toast_text');
  $txt.text(text || '');
  $t.removeClass('ok warn err info').addClass(kind || 'info');
  $t.toggleClass('spinner', !!spinner);
  $t.show(0);
  // trigger transition
  requestAnimationFrame(() => { $t.addClass('visible'); });

  if (sgToastTimer) { clearTimeout(sgToastTimer); sgToastTimer = null; }
  if (!sticky) {
    sgToastTimer = setTimeout(() => { hideToast(); }, clampInt(duration, 500, 10000, 1700));
  }
}


function updateButtonsEnabled() {
  const ok = Boolean(lastReport?.markdown);
  $('#sg_copyMd').prop('disabled', !ok);
  $('#sg_copyJson').prop('disabled', !Boolean(lastJsonText));
  $('#sg_injectTips').prop('disabled', !ok);
  $('#sg_copySum').prop('disabled', !Boolean(lastSummaryText));
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
    const isStatic = m.static === true;    // default false: 静态模块只在首次或手动刷新时生成

    const maxItems = (type === 'list' && Number.isFinite(Number(m.maxItems))) ? clampInt(m.maxItems, 1, 50, 8) : undefined;

    normalized.push({ key, title, type, prompt, required, panel, inline, static: isStatic, ...(maxItems ? { maxItems } : {}) });
  }

  if (!normalized.length) return { ok: false, error: '模块配置为空：至少需要 1 个模块。', modules: null };
  return { ok: true, error: '', modules: normalized };
}



// -------------------- presets & worldbook --------------------

function downloadTextFile(filename, text, mime = 'application/json') {
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

  // Some exports embed JSON as a string field (double-encoded)
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* ignore */ }
  }
  // Some ST endpoints wrap the lorebook JSON inside a string field (e.g. { data: "<json>" }).
  // Try to unwrap a few common wrapper fields.
  for (let i = 0; i < 4; i++) {
    if (!data || typeof data !== 'object') break;
    const wrappers = ['data', 'world_info', 'worldInfo', 'lorebook', 'book', 'worldbook', 'worldBook', 'payload', 'result'];
    let changed = false;
    for (const k of wrappers) {
      const v = data?.[k];
      if (typeof v === 'string') {
        const t = v.trim();
        if (t && (t.startsWith('{') || t.startsWith('['))) {
          try { data = JSON.parse(t); changed = true; break; } catch { /* ignore */ }
        }
      } else if (v && typeof v === 'object') {
        // Sometimes the real file is nested under a wrapper object
        if (v.entries || v.world_info || v.worldInfo || v.lorebook || v.items) {
          data = v;
          changed = true;
          break;
        }
        // Or a nested string field again
        if (typeof v.data === 'string') {
          const t2 = String(v.data || '').trim();
          if (t2 && (t2.startsWith('{') || t2.startsWith('['))) {
            try { data = JSON.parse(t2); changed = true; break; } catch { /* ignore */ }
          }
        }
      }
    }
    if (!changed) break;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { break; }
    }
  }


  function toArray(maybe) {
    if (!maybe) return null;
    if (Array.isArray(maybe)) return maybe;
    if (typeof maybe === 'object') {
      // common: entries as map {uid: entry}
      const vals = Object.values(maybe);
      if (vals.length && vals.every(v => typeof v === 'object')) return vals;
    }
    return null;
  }

  // try to locate entries container (array or map)
  const candidates = [
    data?.entries,
    data?.world_info?.entries,
    data?.worldInfo?.entries,
    data?.lorebook?.entries,
    data?.data?.entries,
    data?.items,
    data?.world_info,
    data?.worldInfo,
    data?.lorebook,
    Array.isArray(data) ? data : null,
  ].filter(Boolean);

  let entries = null;
  for (const c of candidates) {
    const arr = toArray(c);
    if (arr && arr.length) { entries = arr; break; }
    // sometimes nested: { entries: {..} }
    if (c && typeof c === 'object') {
      const inner = toArray(c.entries);
      if (inner && inner.length) { entries = inner; break; }
    }
  }
  if (!entries) return [];

  function splitKeys(str) {
    return String(str || '')
      .split(/[\n,，;；\|]+/g)
      .map(s => s.trim())
      .filter(Boolean);
  }

  const norm = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;

    const title = String(e.title ?? e.name ?? e.comment ?? e.uid ?? e.id ?? '').trim();

    // keys can be stored in many variants in ST exports
    const kRaw =
      e.keys ??
      e.key ??
      e.keywords ??
      e.trigger ??
      e.triggers ??
      e.pattern ??
      e.match ??
      e.tags ??
      e.primary_key ??
      e.primaryKey ??
      e.keyprimary ??
      e.keyPrimary ??
      null;

    const k2Raw =
      e.keysecondary ??
      e.keySecondary ??
      e.secondary_keys ??
      e.secondaryKeys ??
      e.keys_secondary ??
      e.keysSecondary ??
      null;

    let keys = [];
    if (Array.isArray(kRaw)) keys = kRaw.map(x => String(x || '').trim()).filter(Boolean);
    else if (typeof kRaw === 'string') keys = splitKeys(kRaw);

    if (Array.isArray(k2Raw)) keys = keys.concat(k2Raw.map(x => String(x || '').trim()).filter(Boolean));
    else if (typeof k2Raw === 'string') keys = keys.concat(splitKeys(k2Raw));

    keys = Array.from(new Set(keys)).filter(Boolean);

    const content = String(
      e.content ?? e.entry ?? e.text ?? e.description ?? e.desc ?? e.body ?? e.value ?? e.prompt ?? ''
    ).trim();

    if (!content) continue;
    norm.push({ title: title || (keys[0] ? `条目：${keys[0]}` : '条目'), keys, content });
  }
  return norm;
}

// -------------------- 实时读取蓝灯世界书（World Info / Lorebook） --------------------

function pickBlueIndexFileName() {
  const s = ensureSettings();
  const explicit = String(s.wiBlueIndexFile || '').trim();
  if (explicit) return explicit;
  const fromBlueWrite = String(s.summaryBlueWorldInfoFile || '').trim();
  if (fromBlueWrite) return fromBlueWrite;
  // 最后兜底：若用户把蓝灯索引建在绿灯同文件里，也能读到（不推荐，但不阻断）
  const fromGreen = String(s.summaryWorldInfoFile || '').trim();
  return fromGreen;
}

async function fetchJsonCompat(url, options) {
  const headers = { ...getStRequestHeadersCompat(), ...(options?.headers || {}) };
  const res = await fetch(url, { ...(options || {}), headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ''}`);
    err.status = res.status;
    throw err;
  }
  // some ST endpoints may return plain text
  const ct = String(res.headers.get('content-type') || '');
  if (ct.includes('application/json')) return await res.json();
  const t = await res.text().catch(() => '');
  try { return JSON.parse(t); } catch { return { text: t }; }
}

// 尝试从 ST 后端读取指定世界书文件（不同版本的参数名/方法可能不同）
async function fetchWorldInfoFileJsonCompat(fileName) {
  const raw = String(fileName || '').trim();
  if (!raw) throw new Error('蓝灯世界书文件名为空');

  // Some ST versions store lorebook names with/without .json extension.
  const names = Array.from(new Set([
    raw,
    raw.endsWith('.json') ? raw.slice(0, -5) : (raw + '.json'),
  ].filter(Boolean)));

  const tryList = [];
  for (const name of names) {
    // POST JSON body
    tryList.push(
      { method: 'POST', url: '/api/worldinfo/get', body: { name } },
      { method: 'POST', url: '/api/worldinfo/get', body: { file: name } },
      { method: 'POST', url: '/api/worldinfo/get', body: { filename: name } },
      { method: 'POST', url: '/api/worldinfo/get', body: { world: name } },
      { method: 'POST', url: '/api/worldinfo/get', body: { lorebook: name } },
      // GET query
      { method: 'GET', url: `/api/worldinfo/get?name=${encodeURIComponent(name)}` },
      { method: 'GET', url: `/api/worldinfo/get?file=${encodeURIComponent(name)}` },
      { method: 'GET', url: `/api/worldinfo/get?filename=${encodeURIComponent(name)}` },

      // Some forks/versions use /read instead of /get
      { method: 'POST', url: '/api/worldinfo/read', body: { name } },
      { method: 'POST', url: '/api/worldinfo/read', body: { file: name } },
      { method: 'GET', url: `/api/worldinfo/read?name=${encodeURIComponent(name)}` },
      { method: 'GET', url: `/api/worldinfo/read?file=${encodeURIComponent(name)}` },

      // Rare: /load
      { method: 'POST', url: '/api/worldinfo/load', body: { name } },
      { method: 'GET', url: `/api/worldinfo/load?name=${encodeURIComponent(name)}` },
    );
  }

  let lastErr = null;
  for (const t of tryList) {
    try {
      if (t.method === 'POST') {
        const data = await fetchJsonCompat(t.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(t.body),
        });
        if (data) return data;
      } else {
        const data = await fetchJsonCompat(t.url, { method: 'GET' });
        if (data) return data;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('读取世界书失败');
}

function buildBlueIndexFromWorldInfoJson(worldInfoJson, prefixFilter = '') {
  // 复用 parseWorldbookJson 的“兼容解析”逻辑
  const parsed = parseWorldbookJson(JSON.stringify(worldInfoJson || {}));
  const prefix = String(prefixFilter || '').trim();

  const base = parsed.filter(e => e && e.content);

  // 优先用“总结前缀”筛选（避免把其他世界书条目全塞进索引）
  // 但如果因不同 ST 结构导致 title/comment 不一致而筛选到 0 条，则自动回退到全部条目，避免“明明有内容却显示 0 条”。
  let picked = base;
  if (prefix) {
    picked = base.filter(e =>
      String(e.title || '').includes(prefix) ||
      String(e.content || '').includes(prefix)
    );
    if (!picked.length) picked = base;
  }

  const items = picked
    .map(e => ({
      title: String(e.title || '').trim() || (e.keys?.[0] ? `条目：${e.keys[0]}` : '条目'),
      summary: String(e.content || '').trim(),
      keywords: Array.isArray(e.keys) ? e.keys.slice(0, 120) : [],
      importedAt: Date.now(),
    }))
    .filter(x => x.summary);

  return items;
}

async function ensureBlueIndexLive(force = false) {
  const s = ensureSettings();
  const mode = String(s.wiBlueIndexMode || 'live');
  if (mode !== 'live') {
    const arr = Array.isArray(s.summaryBlueIndex) ? s.summaryBlueIndex : [];
    return arr;
  }

  const file = pickBlueIndexFileName();
  if (!file) return [];

  const minSec = clampInt(s.wiBlueIndexMinRefreshSec, 5, 600, 20);
  const now = Date.now();
  const ageMs = now - Number(blueIndexLiveCache.loadedAt || 0);
  const need = force || blueIndexLiveCache.file !== file || ageMs > (minSec * 1000);

  if (!need && Array.isArray(blueIndexLiveCache.entries) && blueIndexLiveCache.entries.length) {
    return blueIndexLiveCache.entries;
  }

  try {
    const json = await fetchWorldInfoFileJsonCompat(file);
    const prefix = String(s.summaryBlueWorldInfoCommentPrefix || '').trim();
    const entries = buildBlueIndexFromWorldInfoJson(json, prefix);

    blueIndexLiveCache = { file, loadedAt: now, entries, lastError: '' };

    // 同步到设置里，便于 UI 显示（同时也是“缓存”兜底）
    s.summaryBlueIndex = entries;
    saveSettings();
    updateBlueIndexInfoLabel();

    return entries;
  } catch (e) {
    blueIndexLiveCache.lastError = String(e?.message ?? e);
    // 读取失败就回退到现有缓存
    const fallback = Array.isArray(s.summaryBlueIndex) ? s.summaryBlueIndex : [];
    return fallback;
  }
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

function estimateTokens(text) {
  const s = String(text || '');
  // Try SillyTavern token counter if available
  try {
    const ctx = SillyTavern.getContext?.();
    if (ctx && typeof ctx.getTokenCount === 'function') {
      const n = ctx.getTokenCount(s);
      if (Number.isFinite(n)) return n;
    }
    if (typeof SillyTavern.getTokenCount === 'function') {
      const n = SillyTavern.getTokenCount(s);
      if (Number.isFinite(n)) return n;
    }
  } catch { /* ignore */ }

  // Fallback heuristic:
  // - CJK chars ~ 1 token each
  // - other chars ~ 1 token per 4 chars
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = s.replace(/[\u4e00-\u9fff]/g, '').replace(/\s+/g, '');
  const other = rest.length;
  return cjk + Math.ceil(other / 4);
}

function computeWorldbookInjection() {
  const s = ensureSettings();
  const raw = String(s.worldbookJson || '').trim();
  const enabled = !!s.worldbookEnabled;

  const result = {
    enabled,
    importedEntries: 0,
    selectedEntries: 0,
    injectedEntries: 0,
    injectedChars: 0,
    injectedTokens: 0,
    mode: String(s.worldbookMode || 'active'),
    text: ''
  };

  if (!raw) return result;

  const entries = parseWorldbookJson(raw);
  result.importedEntries = entries.length;
  if (!entries.length) return result;

  // 如果未启用注入：仅返回“导入数量”，不计算注入内容（UI 也能看到导入成功）
  if (!enabled) return result;

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
  const recentText = pickedMsgs.reverse().join('\n');

  let use = entries;
  if (result.mode === 'active') {
    const act = selectActiveWorldbookEntries(entries, recentText);
    use = act.length ? act : [];
  }
  result.selectedEntries = use.length;

  if (!use.length) return result;

  const maxChars = clampInt(s.worldbookMaxChars, 500, 50000, 6000);
  let acc = '';
  let used = 0;

  for (const e of use) {
    const head = `- 【${e.title}】${(e.keys && e.keys.length) ? `（触发：${e.keys.slice(0, 6).join(' / ')}）` : ''}\n`;
    const body = e.content.trim() + '\n';
    const chunk = head + body + '\n';
    if ((acc.length + chunk.length) > maxChars) break;
    acc += chunk;
    used += 1;
  }

  result.injectedEntries = used;
  result.injectedChars = acc.length;
  result.injectedTokens = estimateTokens(acc);
  result.text = acc;

  return result;
}

let lastWorldbookStats = null;

function buildWorldbookBlock() {
  const info = computeWorldbookInjection();
  lastWorldbookStats = info;

  if (!info.enabled) return '';
  if (!info.text) return '';
  return `\n【世界书/World Info（已导入：${info.importedEntries}条，本次注入：${info.injectedEntries}条，约${info.injectedTokens} tokens）】\n${info.text}\n`;
}
function getModules(mode /* panel|append */) {
  const s = ensureSettings();
  const rawText = String(s.modulesJson || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch { parsed = null; }

  const v = validateAndNormalizeModules(parsed);
  const base = v.ok ? v.modules : clone(DEFAULT_MODULES);

  if (mode === 'append') {
    const src = String(s.inlineModulesSource || 'inline');
    if (src === 'all') return base;
    if (src === 'panel') return base.filter(m => m.panel);
    return base.filter(m => m.inline);
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
    characterSelected: ctx.characterId !== undefined && ctx.characterId !== null
  };

  const snapshotText = [
    `【任务】你是“剧情指导”。根据下方“正在经历的世界”（聊天 + 设定）输出结构化报告。`,
    ``,
    charBlock ? charBlock : `【角色卡】（未获取到/可能是群聊）`,
    ``,
    world ? `【世界观/设定补充】\n${world}\n` : `【世界观/设定补充】（未提供）\n`,
    canon ? `【原著后续/大纲】\n${canon}\n` : `【原著后续/大纲】（未提供）\n`,
    buildWorldbookBlock(),
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

async function fallbackAskJsonCustom(apiBaseUrl, apiKey, model, messages, temperature, maxTokens, topP, stream) {
  const retry = clone(messages);
  retry.unshift({ role: 'system', content: `再次强调：只输出 JSON 对象本体，不要任何额外文字，不要代码块。` });
  return await callViaCustom(apiBaseUrl, apiKey, model, retry, temperature, maxTokens, topP, stream);
}

function hasAnyModuleKey(obj, modules) {
  if (!obj || typeof obj !== 'object') return false;
  for (const m of modules || []) {
    const k = m?.key;
    if (k && Object.prototype.hasOwnProperty.call(obj, k)) return true;
  }
  return false;
}



// -------------------- custom provider

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


async function readStreamedChatCompletionToText(res) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // no stream body; fallback to normal
    const txt = await res.text().catch(() => '');
    return txt;
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let out = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // process line by line
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);

      const t = line.trim();
      if (!t) continue;

      // SSE: data: ...
      if (t.startsWith('data:')) {
        const payload = t.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return out;

        try {
          const j = JSON.parse(payload);
          const c0 = j?.choices?.[0];
          const delta = c0?.delta?.content;
          if (typeof delta === 'string') {
            out += delta;
            continue;
          }
          const msg = c0?.message?.content;
          if (typeof msg === 'string') {
            // some servers stream full message chunks as message.content
            out += msg;
            continue;
          }
          const txt = c0?.text;
          if (typeof txt === 'string') {
            out += txt;
            continue;
          }
          const c = j?.content;
          if (typeof c === 'string') {
            out += c;
            continue;
          }
        } catch {
          // ignore
        }
      } else {
        // NDJSON line
        try {
          const j = JSON.parse(t);
          const c0 = j?.choices?.[0];
          const delta = c0?.delta?.content;
          if (typeof delta === 'string') out += delta;
          else if (typeof c0?.message?.content === 'string') out += c0.message.content;
        } catch {
          // ignore
        }
      }
    }
  }

  // flush remaining (rare)
  const rest = buffer.trim();
  if (rest) {
    // try parse if json line
    try {
      const j = JSON.parse(rest);
      const c0 = j?.choices?.[0];
      const delta = c0?.delta?.content;
      if (typeof delta === 'string') out += delta;
      else if (typeof c0?.message?.content === 'string') out += c0.message.content;
    } catch { /* ignore */ }
  }

  return out;
}

async function callViaCustomBackendProxy(apiBaseUrl, apiKey, model, messages, temperature, maxTokens, topP, stream) {
  const url = '/api/backends/chat-completions/generate';

  const requestBody = {
    messages,
    model: String(model || '').replace(/^models\//, '') || 'gpt-4o-mini',
    max_tokens: maxTokens ?? 8192,
    temperature: temperature ?? 0.7,
    top_p: topP ?? 0.95,
    stream: !!stream,
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


  const ct = String(res.headers.get('content-type') || '');
  if (stream && (ct.includes('text/event-stream') || ct.includes('ndjson') || ct.includes('stream'))) {
    const streamed = await readStreamedChatCompletionToText(res);
    if (streamed) return String(streamed);
    // fall through
  }

  const data = await res.json().catch(() => ({}));
  if (data?.choices?.[0]?.message?.content) return String(data.choices[0].message.content);
  if (typeof data?.content === 'string') return data.content;
  return JSON.stringify(data ?? '');
}

async function callViaCustomBrowserDirect(apiBaseUrl, apiKey, model, messages, temperature, maxTokens, topP, stream) {
  const endpoint = deriveChatCompletionsUrl(apiBaseUrl);
  if (!endpoint) throw new Error('custom 模式：API基础URL 为空');

  const body = {
    model,
    messages,
    max_tokens: maxTokens ?? 8192,
    temperature: temperature ?? 0.7,
    top_p: topP ?? 0.95,
    stream: !!stream,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`直连请求失败: HTTP ${res.status} ${res.statusText}\n${text}`);
  }

  const ct = String(res.headers.get('content-type') || '');
  if (stream && (ct.includes('text/event-stream') || ct.includes('ndjson') || ct.includes('stream'))) {
    const streamed = await readStreamedChatCompletionToText(res);
    return String(streamed || '');
  }

  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '');
}

async function callViaCustom(apiBaseUrl, apiKey, model, messages, temperature, maxTokens, topP, stream) {
  const base = normalizeBaseUrl(apiBaseUrl);
  if (!base) throw new Error('custom 模式需要填写 API基础URL');

  try {
    return await callViaCustomBackendProxy(base, apiKey, model, messages, temperature, maxTokens, topP, stream);
  } catch (e) {
    const status = e?.status;
    if (status === 404 || status === 405) {
      console.warn('[StoryGuide] backend proxy unavailable; fallback to browser direct');
      return await callViaCustomBrowserDirect(base, apiKey, model, messages, temperature, maxTokens, topP, stream);
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
      jsonText = await callViaCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, s.customMaxTokens, s.customTopP, s.customStream);
      const parsedTry = safeJsonParse(jsonText);
      if (!parsedTry || !hasAnyModuleKey(parsedTry, modules)) {
        try { jsonText = await fallbackAskJsonCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, s.customMaxTokens, s.customTopP, s.customStream); }
        catch { /* ignore */ }
      }
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

    if (!parsed) {
      // 同步原文到聊天末尾（解析失败时也不至于“聊天里看不到”）
      try { syncPanelOutputToChat(String(jsonText || lastJsonText || ''), true); } catch { /* ignore */ }
      showPane('json');
      throw new Error('模型输出无法解析为 JSON（已切到 JSON 标签，看看原文）');
    }

      const md = renderReportMarkdownFromModules(parsed, modules);
      lastReport = { json: parsed, markdown: md, createdAt: Date.now(), sourceSummary };
      renderMarkdownInto($('#sg_md'), md);

      await updateMapFromSnapshot(snapshotText);

      // 同步面板报告到聊天末尾
      try { syncPanelOutputToChat(md, false); } catch { /* ignore */ }

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

// -------------------- summary (auto + world info) --------------------

function isCountableMessage(m) {
  if (!m) return false;
  if (m.is_system === true) return false;
  if (m.is_hidden === true) return false;
  const txt = String(m.mes ?? '').trim();
  return Boolean(txt);
}

function isCountableAssistantMessage(m) {
  return isCountableMessage(m) && m.is_user !== true;
}

function computeFloorCount(chat, mode) {
  const arr = Array.isArray(chat) ? chat : [];
  let c = 0;
  for (const m of arr) {
    if (mode === 'assistant') {
      if (isCountableAssistantMessage(m)) c++;
    } else {
      if (isCountableMessage(m)) c++;
    }
  }
  return c;
}

function findStartIndexForLastNFloors(chat, mode, n) {
  const arr = Array.isArray(chat) ? chat : [];
  let remaining = Math.max(1, Number(n) || 1);
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    const hit = (mode === 'assistant') ? isCountableAssistantMessage(m) : isCountableMessage(m);
    if (!hit) continue;
    remaining -= 1;
    if (remaining <= 0) return i;
  }
  return 0;
}

function buildSummaryChunkText(chat, startIdx, maxCharsPerMessage, maxTotalChars) {
  const arr = Array.isArray(chat) ? chat : [];
  const start = Math.max(0, Math.min(arr.length, Number(startIdx) || 0));
  const perMsg = clampInt(maxCharsPerMessage, 200, 8000, 4000);
  const totalMax = clampInt(maxTotalChars, 2000, 80000, 24000);

  const parts = [];
  let total = 0;
  for (let i = start; i < arr.length; i++) {
    const m = arr[i];
    if (!isCountableMessage(m)) continue;
    const who = m.is_user === true ? '用户' : (m.name || 'AI');
    let txt = stripHtml(m.mes || '');
    if (!txt) continue;
    if (txt.length > perMsg) txt = txt.slice(0, perMsg) + '…';
    const block = `【${who}】${txt}`;
    if (total + block.length + 2 > totalMax) break;
    parts.push(block);
    total += block.length + 2;
  }
  return parts.join('\n');
}

// 手动楼层范围总结：按 floor 号定位到聊天索引
function findChatIndexByFloor(chat, mode, floorNo) {
  const arr = Array.isArray(chat) ? chat : [];
  const target = Math.max(1, Number(floorNo) || 1);
  let c = 0;
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    const hit = (mode === 'assistant') ? isCountableAssistantMessage(m) : isCountableMessage(m);
    if (!hit) continue;
    c += 1;
    if (c === target) return i;
  }
  return -1;
}

function resolveChatRangeByFloors(chat, mode, fromFloor, toFloor) {
  const floorNow = computeFloorCount(chat, mode);
  if (floorNow <= 0) return null;
  let a = clampInt(fromFloor, 1, floorNow, 1);
  let b = clampInt(toFloor, 1, floorNow, floorNow);
  if (b < a) { const t = a; a = b; b = t; }

  let startIdx = findChatIndexByFloor(chat, mode, a);
  let endIdx = findChatIndexByFloor(chat, mode, b);
  if (startIdx < 0 || endIdx < 0) return null;

  // 在 assistant 模式下，为了更贴近“回合”，把起始 assistant 楼层前一条用户消息也纳入（若存在）。
  if (mode === 'assistant' && startIdx > 0) {
    const prev = chat[startIdx - 1];
    if (prev && prev.is_user === true && isCountableMessage(prev)) startIdx -= 1;
  }

  if (startIdx > endIdx) { const t = startIdx; startIdx = endIdx; endIdx = t; }
  return { fromFloor: a, toFloor: b, startIdx, endIdx, floorNow };
}

function buildSummaryChunkTextRange(chat, startIdx, endIdx, maxCharsPerMessage, maxTotalChars) {
  const arr = Array.isArray(chat) ? chat : [];
  const start = Math.max(0, Math.min(arr.length - 1, Number(startIdx) || 0));
  const end = Math.max(start, Math.min(arr.length - 1, Number(endIdx) || 0));
  const perMsg = clampInt(maxCharsPerMessage, 200, 8000, 4000);
  const totalMax = clampInt(maxTotalChars, 2000, 80000, 24000);

  const parts = [];
  let total = 0;
  for (let i = start; i <= end; i++) {
    const m = arr[i];
    if (!isCountableMessage(m)) continue;
    const who = m.is_user === true ? '用户' : (m.name || 'AI');
    let txt = stripHtml(m.mes || '');
    if (!txt) continue;
    if (txt.length > perMsg) txt = txt.slice(0, perMsg) + '…';
    const block = `【${who}】${txt}`;
    if (total + block.length + 2 > totalMax) break;
    parts.push(block);
    total += block.length + 2;
  }
  return parts.join('\n');
}

function getSummarySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'keywords'],
  };
}

function buildSummaryPromptMessages(chunkText, fromFloor, toFloor, statData = null) {
  const s = ensureSettings();

  // system prompt
  let sys = String(s.summarySystemPrompt || '').trim();
  if (!sys) sys = DEFAULT_SUMMARY_SYSTEM_PROMPT;
  // 强制追加 JSON 结构要求，避免用户自定义提示词导致解析失败
  sys = sys + '\n\n' + SUMMARY_JSON_REQUIREMENT;

  // user template (supports placeholders)
  let tpl = String(s.summaryUserTemplate || '').trim();
  if (!tpl) tpl = DEFAULT_SUMMARY_USER_TEMPLATE;

  // 格式化 statData（如果有）
  const statDataJson = statData ? JSON.stringify(statData, null, 2) : '';

  let user = renderTemplate(tpl, {
    fromFloor: String(fromFloor),
    toFloor: String(toFloor),
    chunk: String(chunkText || ''),
    statData: statDataJson,
  });
  // 如果用户模板里没有包含 chunk，占位补回去，防止误配导致无内容
  if (!/{{\s*chunk\s*}}/i.test(tpl) && !String(user).includes(String(chunkText || '').slice(0, 12))) {
    user = String(user || '').trim() + `\n\n【对话片段】\n${chunkText}`;
  }
  // 如果有 statData 且用户模板里没有包含，追加到末尾
  if (statData && !/{{\s*statData\s*}}/i.test(tpl)) {
    user = String(user || '').trim() + `\n\n【角色状态数据】\n${statDataJson}`;
  }
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

function sanitizeKeywords(kws) {
  const out = [];
  const seen = new Set();
  for (const k of (Array.isArray(kws) ? kws : [])) {
    let t = String(k ?? '').trim();
    if (!t) continue;
    t = t.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
    // split by common delimiters
    const split = t.split(/[,，、;；/|]+/g).map(x => x.trim()).filter(Boolean);
    for (const s of split) {
      if (s.length < 2) continue;
      if (s.length > 24) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= 16) return out;
    }
  }
  return out;
}

function appendToBlueIndexCache(rec) {
  const s = ensureSettings();
  const item = {
    title: String(rec?.title || '').trim(),
    summary: String(rec?.summary || '').trim(),
    keywords: sanitizeKeywords(rec?.keywords),
    createdAt: Number(rec?.createdAt) || Date.now(),
    range: rec?.range ?? undefined,
  };
  if (!item.summary) return;
  if (!item.title) item.title = item.keywords?.[0] ? `条目：${item.keywords[0]}` : '条目';
  const arr = Array.isArray(s.summaryBlueIndex) ? s.summaryBlueIndex : [];
  // de-dup (only check recent items)
  for (let i = arr.length - 1; i >= 0 && i >= arr.length - 10; i--) {
    const prev = arr[i];
    if (!prev) continue;
    if (String(prev.title || '') === item.title && String(prev.summary || '') === item.summary) {
      return;
    }
  }
  arr.push(item);
  // keep bounded
  if (arr.length > 600) arr.splice(0, arr.length - 600);
  s.summaryBlueIndex = arr;
  saveSettings();
  updateBlueIndexInfoLabel();
}

// ===== 结构化世界书条目核心函数 =====

function buildStructuredEntriesPromptMessages(chunkText, fromFloor, toFloor, meta, statData = null) {
  const s = ensureSettings();
  let sys = String(s.structuredEntriesSystemPrompt || '').trim();
  if (!sys) sys = DEFAULT_STRUCTURED_ENTRIES_SYSTEM_PROMPT;
  const charPrompt = String(s.structuredCharacterPrompt || '').trim() || DEFAULT_STRUCTURED_CHARACTER_PROMPT;
  const equipPrompt = String(s.structuredEquipmentPrompt || '').trim() || DEFAULT_STRUCTURED_EQUIPMENT_PROMPT;
  const abilityPrompt = String(s.structuredAbilityPrompt || '').trim() || DEFAULT_STRUCTURED_ABILITY_PROMPT;
  sys = [
    sys,
    `【人物条目要求】\n${charPrompt}`,
    `【装备条目要求】\n${equipPrompt}`,
    `【能力条目要求】\n${abilityPrompt}`,
    STRUCTURED_ENTRIES_JSON_REQUIREMENT,
  ].join('\n\n');

  // 构建已知列表供 LLM 判断是否新增/更新（包含别名以帮助识别不同写法）
  const knownChars = Object.values(meta.characterEntries || {}).map(c => {
    const aliases = Array.isArray(c.aliases) && c.aliases.length > 0 ? `[别名:${c.aliases.join('/')}]` : '';
    return `${c.name}${aliases}`;
  }).join('、') || '无';
  const knownEquips = Object.values(meta.equipmentEntries || {}).map(e => {
    const aliases = Array.isArray(e.aliases) && e.aliases.length > 0 ? `[别名:${e.aliases.join('/')}]` : '';
    return `${e.name}${aliases}`;
  }).join('、') || '无';

  // 格式化 statData
  const statDataJson = statData ? JSON.stringify(statData, null, 2) : '';

  let tpl = String(s.structuredEntriesUserTemplate || '').trim();
  if (!tpl) tpl = DEFAULT_STRUCTURED_ENTRIES_USER_TEMPLATE;
  let user = renderTemplate(tpl, {
    fromFloor: String(fromFloor),
    toFloor: String(toFloor),
    chunk: String(chunkText || ''),
    knownCharacters: knownChars,
    knownEquipments: knownEquips,
    statData: statDataJson,
  });
  // 如果有 statData 且模板里没有包含，追加到末尾
  if (statData && !/\{\{\s*statData\s*\}\}/i.test(tpl)) {
    user = String(user || '').trim() + `\n\n【角色状态数据 statData】\n${statDataJson}`;
  }
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

async function generateStructuredEntries(chunkText, fromFloor, toFloor, meta, settings, statData = null) {
  const messages = buildStructuredEntriesPromptMessages(chunkText, fromFloor, toFloor, meta, statData);
  let jsonText = '';
  if (String(settings.summaryProvider || 'st') === 'custom') {
    jsonText = await callViaCustom(settings.summaryCustomEndpoint, settings.summaryCustomApiKey, settings.summaryCustomModel, messages, settings.summaryTemperature, settings.summaryCustomMaxTokens, 0.95, settings.summaryCustomStream);
  } else {
    jsonText = await callViaSillyTavern(messages, null, settings.summaryTemperature);
    if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
  }
  const parsed = safeJsonParse(jsonText);
  if (!parsed) return null;
  return {
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    equipments: Array.isArray(parsed.equipments) ? parsed.equipments : [],
    abilities: Array.isArray(parsed.abilities) ? parsed.abilities : [],
    deletedCharacters: Array.isArray(parsed.deletedCharacters) ? parsed.deletedCharacters : [],
    deletedEquipments: Array.isArray(parsed.deletedEquipments) ? parsed.deletedEquipments : [],
    deletedAbilities: Array.isArray(parsed.deletedAbilities) ? parsed.deletedAbilities : [],
  };
}

// 构建条目的 key（用于世界书触发词和去重）
function buildStructuredEntryKey(prefix, name, indexId) {
  return `${prefix}｜${name}｜${indexId}`;
}

// 构建条目内容（档案式描述）
function buildCharacterContent(char) {
  const parts = [];
  if (char.name) parts.push(`【人物】${char.name}`);
  if (char.aliases?.length) parts.push(`别名：${char.aliases.join('、')}`);
  if (char.faction) parts.push(`阵营/身份：${char.faction}`);
  if (char.status) parts.push(`状态：${char.status}`);
  if (char.personality) parts.push(`性格：${char.personality}`);

  // 性格铆钉（用特殊格式突出显示）
  if (char.corePersonality) parts.push(`【核心性格锚点】${char.corePersonality}（不会轻易改变）`);
  if (char.motivation) parts.push(`【角色动机】${char.motivation}（独立于主角的目标）`);
  if (char.relationshipStage) parts.push(`【关系阶段】${char.relationshipStage}`);

  if (char.background) parts.push(`背景：${char.background}`);
  if (char.relationToProtagonist) parts.push(`与主角关系：${char.relationToProtagonist}`);
  if (char.keyEvents?.length) parts.push(`关键事件：${char.keyEvents.join('；')}`);
  if (char.statInfo) {
    const infoStr = typeof char.statInfo === 'object' ? JSON.stringify(char.statInfo, null, 2) : String(char.statInfo);
    parts.push(`属性数据：${infoStr}`);
  }
  return parts.join('\n');
}

function buildEquipmentContent(equip) {
  const parts = [];
  if (equip.name) parts.push(`【装备】${equip.name}`);
  if (equip.aliases?.length) parts.push(`别名：${equip.aliases.join('、')}`);
  if (equip.type) parts.push(`类型：${equip.type}`);
  if (equip.rarity) parts.push(`品质：${equip.rarity}`);
  if (equip.effects) parts.push(`效果：${equip.effects}`);
  if (equip.source) parts.push(`来源：${equip.source}`);
  if (equip.currentState) parts.push(`当前状态：${equip.currentState}`);
  if (equip.statInfo) {
    const infoStr = typeof equip.statInfo === 'object' ? JSON.stringify(equip.statInfo, null, 2) : String(equip.statInfo);
    parts.push(`属性数据：${infoStr}`);
  }
  if (equip.boundEvents?.length) parts.push(`相关事件：${equip.boundEvents.join('；')}`);
  return parts.join('\n');
}

function buildAbilityContent(ability) {
  const parts = [];
  if (ability.name) parts.push(`【能力】${ability.name}${ability.isNegative ? '（负面）' : ''}`);
  if (ability.type) parts.push(`类型：${ability.type}`);
  if (ability.effects) parts.push(`效果：${ability.effects}`);
  if (ability.trigger) parts.push(`触发条件：${ability.trigger}`);
  if (ability.cost) parts.push(`代价/冷却：${ability.cost}`);
  if (ability.statInfo) {
    const infoStr = typeof ability.statInfo === 'object' ? JSON.stringify(ability.statInfo, null, 2) : String(ability.statInfo);
    parts.push(`属性数据：${infoStr}`);
  }
  if (ability.boundEvents?.length) parts.push(`相关事件：${ability.boundEvents.join('；')}`);
  return parts.join('\n');
}

// 写入或更新结构化条目（方案C：混合策略）
// targetType: 'green' = 绿灯世界书（触发词触发）, 'blue' = 蓝灯世界书（常开索引）
async function writeOrUpdateStructuredEntry(entryType, entryData, meta, settings, {
  buildContent,
  entriesCache,
  nextIndexKey,
  prefix,
  targetType = 'green', // 'green' | 'blue'
}) {
  // 使用规范化的名称作为唯一标识符（忽略 LLM 提供的 uid，因为不可靠）
  const entryName = String(entryData.name || '').trim();
  if (!entryName) return null;

  // 规范化名称：移除特殊字符，用于缓存 key
  const normalizedName = entryName.replace(/[|｜,，\s]/g, '_').toLowerCase();
  const cacheKey = `${normalizedName}_${targetType}`;

  // 首先按 cacheKey 直接查找
  let cached = entriesCache[cacheKey];

  // 如果直接查找失败，遍历缓存按名称模糊匹配（处理同一人物不同写法）
  if (!cached) {
    for (const [key, value] of Object.entries(entriesCache)) {
      if (!key.endsWith(`_${targetType}`)) continue;
      const cachedNameNorm = String(value.name || '').replace(/[|｜,，\s]/g, '_').toLowerCase();
      const cachedAliases = Array.isArray(value.aliases) ? value.aliases.map(a => String(a).toLowerCase().trim()) : [];
      const newAliases = Array.isArray(entryData.aliases) ? entryData.aliases.map(a => String(a).toLowerCase().trim()) : [];
      const nameMatch = cachedNameNorm === normalizedName || cachedNameNorm.includes(normalizedName) || normalizedName.includes(cachedNameNorm);
      const newNameInCachedAliases = cachedAliases.some(a => a === normalizedName || a.includes(normalizedName) || normalizedName.includes(a));
      const cachedNameInNewAliases = newAliases.some(a => a === cachedNameNorm || a.includes(cachedNameNorm) || cachedNameNorm.includes(a));
      const aliasesOverlap = cachedAliases.some(ca => newAliases.some(na => ca === na || ca.includes(na) || na.includes(ca)));
      if (nameMatch || newNameInCachedAliases || cachedNameInNewAliases || aliasesOverlap) {
        cached = value;
        console.log(`[StoryGuide] Found cached ${entryType} by smart match: "${entryName}" -> "${value.name}"`);
        if (entryName.toLowerCase() !== String(value.name).toLowerCase()) {
          cached.aliases = cached.aliases || [];
          if (!cached.aliases.some(a => String(a).toLowerCase() === entryName.toLowerCase())) {
            cached.aliases.push(entryName);
            console.log(`[StoryGuide] Added "${entryName}" as alias for "${value.name}"`);
          }
        }
        break;
      }
    }
  }

  const content = buildContent(entryData).replace(/\|/g, '｜');

  // 根据 targetType 选择世界书目标
  let target, file, constant;
  if (targetType === 'blue') {
    target = 'file';
    file = String(settings.summaryBlueWorldInfoFile || '');
    constant = 1; // 蓝灯=常开
    if (!file) return null; // 蓝灯必须指定文件名
  } else {
    target = String(settings.summaryWorldInfoTarget || 'chatbook');
    file = String(settings.summaryWorldInfoFile || '');
    constant = 0; // 绿灯=触发词触发
  }
  const fileExprForQuery = (target === 'chatbook') ? '{{getchatbook}}' : file;

  // 去重和更新检查：如果本地缓存已有此条目
  if (cached) {
    // 内容相同 -> 跳过
    if (cached.content === content) {
      console.log(`[StoryGuide] Skip unchanged ${entryType} (${targetType}): ${entryName}`);
      return { skipped: true, name: entryName, targetType, reason: 'unchanged' };
    }

    // 内容不同 -> 尝试使用 /findentry 查找并更新
    console.log(`[StoryGuide] Content changed for ${entryType} (${targetType}): ${entryName}, attempting update via /findentry...`);
    try {
      // 使用 /findentry 通过 comment 字段查找条目 UID
      // comment 格式为: "人物｜角色名｜CHA-001"
      const searchPattern = `${prefix}｜${entryName}`;

      // 构建查找脚本
      let findParts = [];
      const findUidVar = '__sg_find_uid';
      const findFileVar = '__sg_find_file';

      if (target === 'chatbook') {
        findParts.push('/getchatbook');
        findParts.push(`/setvar key=${findFileVar}`);
        findParts.push(`/findentry file={{getvar::${findFileVar}}} field=comment ${quoteSlashValue(searchPattern)}`);
      } else {
        findParts.push(`/findentry file=${quoteSlashValue(file)} field=comment ${quoteSlashValue(searchPattern)}`);
      }
      findParts.push(`/setvar key=${findUidVar}`);
      findParts.push(`/getvar ${findUidVar}`);

      const findResult = await execSlash(findParts.join(' | '));

      // DEBUG: 查看 findentry 返回值
      console.log(`[StoryGuide] DEBUG /findentry result:`, findResult, `type:`, typeof findResult);

      // 解析 UID - 处理多种可能的返回格式
      let foundUid = null;
      if (findResult !== null && findResult !== undefined) {
        // 如果是数字，直接使用
        if (typeof findResult === 'number') {
          foundUid = String(findResult);
        } else if (typeof findResult === 'string') {
          const trimmed = findResult.trim();
          // 直接是数字字符串
          if (trimmed.match(/^\d+$/)) {
            foundUid = trimmed;
          } else {
            // 尝试解析 JSON
            try {
              const parsed = JSON.parse(trimmed);
              if (typeof parsed === 'number') {
                foundUid = String(parsed);
              } else if (parsed?.pipe !== undefined) {
                foundUid = String(parsed.pipe);
              } else if (parsed?.result !== undefined) {
                foundUid = String(parsed.result);
              }
            } catch { /* not JSON */ }
          }
        } else if (typeof findResult === 'object') {
          // 对象形式 {pipe: xxx} 或 {result: xxx}
          if (findResult?.pipe !== undefined) {
            foundUid = String(findResult.pipe);
          } else if (findResult?.result !== undefined) {
            foundUid = String(findResult.result);
          }
        }
      }
      console.log(`[StoryGuide] DEBUG parsed foundUid:`, foundUid);

      // 清理临时变量
      try { await execSlash(`/flushvar ${findUidVar}`); } catch { /* ignore */ }
      if (target === 'chatbook') {
        try { await execSlash(`/flushvar ${findFileVar}`); } catch { /* ignore */ }
      }

      if (foundUid) {
        // 找到条目，更新内容
        let updateParts = [];
        const updateFileVar = '__sg_update_file';

        if (target === 'chatbook') {
          // chatbook 模式需要先获取文件名
          updateParts.push('/getchatbook');
          updateParts.push(`/setvar key=${updateFileVar}`);
          updateParts.push(`/setentryfield file={{getvar::${updateFileVar}}} uid=${foundUid} field=content ${quoteSlashValue(content)}`);
          updateParts.push(`/flushvar ${updateFileVar}`);
        } else {
          updateParts.push(`/setentryfield file=${quoteSlashValue(file)} uid=${foundUid} field=content ${quoteSlashValue(content)}`);
        }

        await execSlash(updateParts.join(' | '));
        cached.content = content;
        cached.lastUpdated = Date.now();
        console.log(`[StoryGuide] Updated ${entryType} (${targetType}): ${entryName} -> UID ${foundUid}`);
        return { updated: true, name: entryName, targetType, uid: foundUid };
      } else {
        console.log(`[StoryGuide] Entry not found via /findentry: ${searchPattern}, skipping update`);
        // 未找到条目（可能被手动删除），只更新缓存
        cached.content = content;
        cached.lastUpdated = Date.now();
        return { skipped: true, name: entryName, targetType, reason: 'entry_not_found' };
      }
    } catch (e) {
      console.warn(`[StoryGuide] Update ${entryType} (${targetType}) via /findentry failed:`, e);
      // 更新失败，只更新缓存
      cached.content = content;
      cached.lastUpdated = Date.now();
      return { skipped: true, name: entryName, targetType, reason: 'update_failed' };
    }
  }

  // 创建新条目
  // 对于蓝灯条目，先检查是否有对应的绿灯条目，复用其 indexId
  let indexId;
  const greenCacheKey = `${normalizedName}_green`;
  const existingGreenEntry = entriesCache[greenCacheKey];

  if (targetType === 'blue' && existingGreenEntry?.indexId) {
    // 蓝灯复用绿灯的 indexId
    indexId = existingGreenEntry.indexId;
    console.log(`[StoryGuide] Reusing green indexId for blue: ${entryName} -> ${indexId}`);
  } else {
    // 绿灯或没有对应绿灯条目时，生成新 indexId
    const indexNum = meta[nextIndexKey] || 1;
    indexId = `${entryType.substring(0, 3).toUpperCase()}-${String(indexNum).padStart(3, '0')}`;
  }

  const keyValue = buildStructuredEntryKey(prefix, entryName, indexId);
  const comment = `${prefix}｜${entryName}｜${indexId}`;

  const uidVar = '__sg_struct_uid';
  const fileVar = '__sg_struct_wbfile';
  const createFileExpr = (target === 'chatbook') ? `{{getvar::${fileVar}}}` : file;

  const parts = [];
  if (target === 'chatbook') {
    parts.push('/getchatbook');
    parts.push(`/setvar key=${fileVar}`);
  }
  parts.push(`/createentry file=${quoteSlashValue(createFileExpr)} key=${quoteSlashValue(keyValue)} ${quoteSlashValue(content)}`);
  parts.push(`/setvar key=${uidVar}`);
  parts.push(`/setentryfield file=${quoteSlashValue(createFileExpr)} uid={{getvar::${uidVar}}} field=comment ${quoteSlashValue(comment)}`);
  parts.push(`/setentryfield file=${quoteSlashValue(createFileExpr)} uid={{getvar::${uidVar}}} field=disable 0`);
  parts.push(`/setentryfield file=${quoteSlashValue(createFileExpr)} uid={{getvar::${uidVar}}} field=constant ${constant}`);
  parts.push(`/flushvar ${uidVar}`);
  if (target === 'chatbook') parts.push(`/flushvar ${fileVar}`);

  try {
    await execSlash(parts.join(' | '));
    // 更新缓存
    entriesCache[cacheKey] = {
      name: entryName,
      aliases: entryData.aliases || [],
      content,
      lastUpdated: Date.now(),
      indexId,
      targetType,
    };
    if (targetType === 'green' && !existingGreenEntry) {
      // 只在绿灯首次创建时递增索引
      meta[nextIndexKey] = (meta[nextIndexKey] || 1) + 1;
    }
    console.log(`[StoryGuide] Created ${entryType} (${targetType}): ${entryName} -> ${indexId}`);
    return { created: true, name: entryName, indexId, targetType };
  } catch (e) {
    console.warn(`[StoryGuide] Create ${entryType} (${targetType}) entry failed:`, e);
    return null;
  }
}


async function writeOrUpdateCharacterEntry(char, meta, settings) {
  if (!char?.name) return null;
  const results = [];
  // 写入绿灯世界书
  if (settings.summaryToWorldInfo) {
    const r = await writeOrUpdateStructuredEntry('character', char, meta, settings, {
      buildContent: buildCharacterContent,
      entriesCache: meta.characterEntries,
      nextIndexKey: 'nextCharacterIndex',
      prefix: settings.characterEntryPrefix || '人物',
      targetType: 'green',
    });
    if (r) results.push(r);
  }
  // 写入蓝灯世界书
  if (settings.summaryToBlueWorldInfo) {
    const r = await writeOrUpdateStructuredEntry('character', char, meta, settings, {
      buildContent: buildCharacterContent,
      entriesCache: meta.characterEntries,
      nextIndexKey: 'nextCharacterIndex',
      prefix: settings.characterEntryPrefix || '人物',
      targetType: 'blue',
    });
    if (r) results.push(r);
  }
  return results.length ? results : null;
}

async function writeOrUpdateEquipmentEntry(equip, meta, settings) {
  if (!equip?.name) return null;
  const results = [];
  // 写入绿灯世界书
  if (settings.summaryToWorldInfo) {
    const r = await writeOrUpdateStructuredEntry('equipment', equip, meta, settings, {
      buildContent: buildEquipmentContent,
      entriesCache: meta.equipmentEntries,
      nextIndexKey: 'nextEquipmentIndex',
      prefix: settings.equipmentEntryPrefix || '装备',
      targetType: 'green',
    });
    if (r) results.push(r);
  }
  // 写入蓝灯世界书
  if (settings.summaryToBlueWorldInfo) {
    const r = await writeOrUpdateStructuredEntry('equipment', equip, meta, settings, {
      buildContent: buildEquipmentContent,
      entriesCache: meta.equipmentEntries,
      nextIndexKey: 'nextEquipmentIndex',
      prefix: settings.equipmentEntryPrefix || '装备',
      targetType: 'blue',
    });
    if (r) results.push(r);
  }
  return results.length ? results : null;
}

async function writeOrUpdateAbilityEntry(ability, meta, settings) {
  if (!ability?.name) return null;
  const results = [];
  // 写入绿灯世界书
  if (settings.summaryToWorldInfo) {
    const r = await writeOrUpdateStructuredEntry('ability', ability, meta, settings, {
      buildContent: buildAbilityContent,
      entriesCache: meta.abilityEntries,
      nextIndexKey: 'nextAbilityIndex',
      prefix: settings.abilityEntryPrefix || '能力',
      targetType: 'green',
    });
    if (r) results.push(r);
  }
  // 写入蓝灯世界书
  if (settings.summaryToBlueWorldInfo) {
    const r = await writeOrUpdateStructuredEntry('ability', ability, meta, settings, {
      buildContent: buildAbilityContent,
      entriesCache: meta.abilityEntries,
      nextIndexKey: 'nextAbilityIndex',
      prefix: settings.abilityEntryPrefix || '能力',
      targetType: 'blue',
    });
    if (r) results.push(r);
  }
  return results.length ? results : null;
}

// 删除结构化条目（从世界书中删除死亡角色、卖掉装备等）
async function deleteStructuredEntry(entryType, entryName, meta, settings, {
  entriesCache,
  prefix,
  targetType = 'green',
}) {
  if (!entryName) return null;
  const normalizedName = String(entryName || '').trim().toLowerCase();

  // 查找缓存中的条目
  const cacheKey = `${normalizedName}_${targetType}`;
  const cached = entriesCache[cacheKey];
  if (!cached) {
    console.log(`[StoryGuide] Delete ${entryType} (${targetType}): ${entryName} not found in cache`);
    return null;
  }

  // 构建 comment 用于查找世界书条目
  const comment = `${prefix}｜${cached.name}｜${cached.indexId}`;

  // 确定目标世界书
  let target = 'chatbook';
  let file = '';
  if (targetType === 'blue') {
    target = 'file';
    file = settings.summaryBlueWorldInfoFile || '';
    if (!file) {
      console.warn(`[StoryGuide] No blue world info file configured for deletion`);
      return null;
    }
  } else {
    const t = String(settings.summaryWorldInfoTarget || 'chatbook');
    if (t === 'file') {
      target = 'file';
      file = settings.summaryWorldInfoFile || '';
    }
  }

  // 使用 /findentry 查找条目 UID
  try {
    let findExpr;
    const findFileVar = 'sgTmpFindFile';
    if (target === 'chatbook') {
      // 使用 setvar/getvar 管道获取 chatbook 文件名
      await execSlash(`/getchatbook | /setvar key=${findFileVar}`);
      findExpr = `/findentry file={{getvar::${findFileVar}}} field=comment ${quoteSlashValue(comment)}`;
    } else {
      findExpr = `/findentry file=${quoteSlashValue(file)} field=comment ${quoteSlashValue(comment)}`;
    }

    const findResult = await execSlash(findExpr);
    const findText = slashOutputToText(findResult);

    // 清理临时变量
    if (target === 'chatbook') {
      await execSlash(`/flushvar ${findFileVar}`);
    }

    // 解析 UID
    let uid = null;
    if (findText && findText !== 'null' && findText !== 'undefined') {
      const parsed = safeJsonParse(findText);
      if (parsed && parsed.uid) {
        uid = parsed.uid;
      } else if (/^\d+$/.test(findText.trim())) {
        uid = findText.trim();
      }
    }

    if (!uid) {
      console.log(`[StoryGuide] Delete ${entryType} (${targetType}): ${entryName} not found in world book`);
      // 仍然从缓存中删除
      delete entriesCache[cacheKey];
      return { deleted: true, name: entryName, source: 'cache_only' };
    }

    // SillyTavern 没有 /delentry 命令，改为禁用条目并标记为已删除
    // 1. 设置 disable=1（禁用条目）
    // 2. 清空内容或标记为已删除

    // 构建文件表达式（chatbook 需要特殊处理）
    let fileExpr;
    const fileVar = 'sgTmpDeleteFile';
    if (target === 'chatbook') {
      // 使用 setvar/getvar 管道获取 chatbook 文件名
      await execSlash(`/getchatbook | /setvar key=${fileVar}`);
      fileExpr = `{{getvar::${fileVar}}}`;
    } else {
      fileExpr = quoteSlashValue(file);
    }

    const disableExpr = `/setentryfield file=${fileExpr} uid=${uid} field=disable 1`;
    await execSlash(disableExpr);

    // 修改 comment 为已删除标记
    const deletedComment = `[已删除] ${comment}`;
    const commentExpr = `/setentryfield file=${fileExpr} uid=${uid} field=comment ${quoteSlashValue(deletedComment)}`;
    await execSlash(commentExpr);

    // 清空触发词（避免被触发）
    const keyExpr = `/setentryfield file=${fileExpr} uid=${uid} field=key ""`;
    await execSlash(keyExpr);

    // 清理临时变量
    if (target === 'chatbook') {
      await execSlash(`/flushvar ${fileVar}`);
    }

    // 从缓存中删除
    delete entriesCache[cacheKey];

    console.log(`[StoryGuide] Disabled ${entryType} (${targetType}): ${entryName} (UID: ${uid})`);
    return { deleted: true, name: entryName, uid, targetType };
  } catch (e) {
    console.warn(`[StoryGuide] Delete ${entryType} (${targetType}) failed:`, e);
    // 仍然从缓存中删除（避免下次再次尝试）
    delete entriesCache[cacheKey];
    return null;
  }
}

// 删除角色条目
async function deleteCharacterEntry(charName, meta, settings) {
  const results = [];
  if (settings.summaryToWorldInfo) {
    const r = await deleteStructuredEntry('character', charName, meta, settings, {
      entriesCache: meta.characterEntries,
      prefix: settings.characterEntryPrefix || '人物',
      targetType: 'green',
    });
    if (r) results.push(r);
  }
  if (settings.summaryToBlueWorldInfo) {
    const r = await deleteStructuredEntry('character', charName, meta, settings, {
      entriesCache: meta.characterEntries,
      prefix: settings.characterEntryPrefix || '人物',
      targetType: 'blue',
    });
    if (r) results.push(r);
  }
  return results.length ? results : null;
}

// 删除装备条目
async function deleteEquipmentEntry(equipName, meta, settings) {
  const results = [];
  if (settings.summaryToWorldInfo) {
    const r = await deleteStructuredEntry('equipment', equipName, meta, settings, {
      entriesCache: meta.equipmentEntries,
      prefix: settings.equipmentEntryPrefix || '装备',
      targetType: 'green',
    });
    if (r) results.push(r);
  }
  if (settings.summaryToBlueWorldInfo) {
    const r = await deleteStructuredEntry('equipment', equipName, meta, settings, {
      entriesCache: meta.equipmentEntries,
      prefix: settings.equipmentEntryPrefix || '装备',
      targetType: 'blue',
    });
    if (r) results.push(r);
  }
  return results.length ? results : null;
}

// 删除能力条目
async function deleteAbilityEntry(abilityName, meta, settings) {
  const results = [];
  if (settings.summaryToWorldInfo) {
    const r = await deleteStructuredEntry('ability', abilityName, meta, settings, {
      entriesCache: meta.abilityEntries,
      prefix: settings.abilityEntryPrefix || '能力',
      targetType: 'green',
    });
    if (r) results.push(r);
  }
  if (settings.summaryToBlueWorldInfo) {
    const r = await deleteStructuredEntry('ability', abilityName, meta, settings, {
      entriesCache: meta.abilityEntries,
      prefix: settings.abilityEntryPrefix || '能力',
      targetType: 'blue',
    });
    if (r) results.push(r);
  }
  return results.length ? results : null;
}

let cachedSlashExecutor = null;

async function getSlashExecutor() {
  if (cachedSlashExecutor) return cachedSlashExecutor;

  const ctx = SillyTavern.getContext?.();
  // SillyTavern has renamed / refactored slash command executors multiple times.
  // We support a broad set of known entry points (newest first), and then best-effort
  // call them with compatible signatures.
  const candidates = [
    // Newer ST versions expose this via getContext()
    ctx?.executeSlashCommandsWithOptions,
    ctx?.executeSlashCommands,
    ctx?.processChatSlashCommands,
    ctx?.executeSlashCommandsOnChatInput,

    // Some builds expose the parser/executor objects
    ctx?.SlashCommandParser?.executeSlashCommandsWithOptions,
    ctx?.SlashCommandParser?.execute,
    globalThis.SlashCommandParser?.executeSlashCommandsWithOptions,
    globalThis.SlashCommandParser?.execute,

    // Global fallbacks
    globalThis.executeSlashCommandsWithOptions,
    globalThis.executeSlashCommands,
    globalThis.processChatSlashCommands,
    globalThis.executeSlashCommandsOnChatInput,
  ].filter(fn => typeof fn === 'function');

  if (candidates.length) {
    cachedSlashExecutor = async (cmd) => {
      // best-effort signature compatibility
      for (const fn of candidates) {
        // common signatures:
        // - fn(text)
        // - fn(text, boolean)
        // - fn(text, { quiet, silent, execute, ... })
        // - fn({ input: text, ... })
        try { return await fn(cmd); } catch { /* try next */ }
        try { return await fn(cmd, true); } catch { /* try next */ }
        try { return await fn(cmd, { quiet: true, silent: true }); } catch { /* try next */ }
        try { return await fn(cmd, { shouldDisplayMessage: false, quiet: true, silent: true }); } catch { /* try next */ }
        try { return await fn({ input: cmd, quiet: true, silent: true }); } catch { /* try next */ }
        try { return await fn({ command: cmd, quiet: true, silent: true }); } catch { /* try next */ }
      }
      throw new Error('Slash command executor found but failed to run.');
    };
    return cachedSlashExecutor;
  }

  try {
    const mod = await import(/* webpackIgnore: true */ '/script.js');
    const modFns = [
      mod?.executeSlashCommandsWithOptions,
      mod?.executeSlashCommands,
      mod?.processChatSlashCommands,
      mod?.executeSlashCommandsOnChatInput,
    ].filter(fn => typeof fn === 'function');
    if (modFns.length) {
      cachedSlashExecutor = async (cmd) => {
        for (const fn of modFns) {
          try { return await fn(cmd); } catch { /* try next */ }
          try { return await fn(cmd, true); } catch { /* try next */ }
          try { return await fn(cmd, { quiet: true, silent: true }); } catch { /* try next */ }
        }
        throw new Error('Slash command executor from /script.js failed to run.');
      };
      return cachedSlashExecutor;
    }
  } catch {
    // ignore
  }

  cachedSlashExecutor = null;
  throw new Error('未找到可用的 STscript/SlashCommand 执行函数（无法自动写入世界书）。');
}

async function execSlash(cmd) {
  const exec = await getSlashExecutor();
  return await exec(String(cmd || '').trim());
}

function safeStringifyShort(v, maxLen = 260) {
  try {
    const s = (typeof v === 'string') ? v : JSON.stringify(v);
    if (!s) return '';
    return s.length > maxLen ? (s.slice(0, maxLen) + '...') : s;
  } catch {
    try {
      const s = String(v);
      if (!s) return '';
      return s.length > maxLen ? (s.slice(0, maxLen) + '...') : s;
    } catch {
      return '';
    }
  }
}

/**
 * 兼容不同版本 SlashCommand 执行器的返回值形态：
 * - string
 * - number/boolean
 * - array
 * - object（常见字段：text/output/message/result/value/data/html...）
 */
function slashOutputToText(out, seen = new Set()) {
  if (out == null) return '';
  const t = typeof out;
  if (t === 'string') return out;
  if (t === 'number' || t === 'boolean') return String(out);

  if (Array.isArray(out)) {
    return out.map(x => slashOutputToText(x, seen)).filter(Boolean).join('\n');
  }

  if (t === 'object') {
    if (seen.has(out)) return '';
    seen.add(out);

    // common fields in different ST builds
    const common = ['text', 'output', 'message', 'content', 'result', 'value', 'data', 'html', 'return', 'payload', 'response'];
    for (const k of common) {
      if (Object.hasOwn(out, k)) {
        const s = slashOutputToText(out[k], seen);
        if (s) return s;
      }
    }

    // any non-empty string field
    for (const v of Object.values(out)) {
      if (typeof v === 'string' && v.trim()) return v;
    }

    return '';
  }

  try { return String(out); } catch { return ''; }
}

/**
 * 从 SlashCommand 输出中提取世界书条目 UID
 * - 支持 text / object / array 多种形态
 * - 支持 uid=123、UID:123、以及返回对象里直接包含 uid 字段
 */
function extractUid(out, seen = new Set()) {
  if (out == null) return null;

  const t = typeof out;

  if (t === 'number') {
    const n = Math.trunc(out);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  if (t === 'string') {
    const s = out;
    const m1 = s.match(/\buid\s*[:=]\s*(\d{1,12})\b/i);
    if (m1) return Number.parseInt(m1[1], 10);
    const m2 = s.match(/\b(\d{1,12})\b/);
    if (m2) return Number.parseInt(m2[1], 10);
    return null;
  }

  if (Array.isArray(out)) {
    for (const it of out) {
      const r = extractUid(it, seen);
      if (r) return r;
    }
    return null;
  }

  if (t === 'object') {
    if (seen.has(out)) return null;
    seen.add(out);

    // direct uid/id fields
    const directKeys = ['uid', 'id', 'entryId', 'entry_id', 'worldInfoUid', 'worldinfoUid'];
    for (const k of directKeys) {
      if (Object.hasOwn(out, k)) {
        const n = Number(out[k]);
        if (Number.isFinite(n) && n > 0) return Math.trunc(n);
      }
    }

    // nested containers
    const nestedKeys = ['result', 'data', 'value', 'output', 'return', 'payload', 'response', 'entry'];
    for (const k of nestedKeys) {
      if (Object.hasOwn(out, k)) {
        const r = extractUid(out[k], seen);
        if (r) return r;
      }
    }

    // scan all values (shallow + recursion)
    for (const v of Object.values(out)) {
      const r = extractUid(v, seen);
      if (r) return r;
    }

    // fallback: parse from textified output
    const s = slashOutputToText(out, seen);
    if (s) return extractUid(s, seen);

    return null;
  }

  // fallback
  return extractUid(String(out), seen);
}

function quoteSlashValue(v) {
  const s = String(v ?? '').replace(/"/g, '\\"');
  return `"${s}"`;
}

async function writeSummaryToWorldInfoEntry(rec, meta, {
  target = 'file',
  file = '',
  commentPrefix = '剧情总结',
  constant = 0,
} = {}) {
  const kws = sanitizeKeywords(rec.keywords);
  const range = rec?.range ? `${rec.range.fromFloor}-${rec.range.toFloor}` : '';
  const prefix = String(commentPrefix || '剧情总结').trim() || '剧情总结';
  const rawTitle = String(rec.title || '').trim();

  const s = ensureSettings();
  const keyMode = String(s.summaryWorldInfoKeyMode || 'keywords');
  const indexId = String(rec?.indexId || '').trim();
  const indexInComment = (keyMode === 'indexId') && !!s.summaryIndexInComment && !!indexId;
  // comment 字段通常就是世界书列表里的"标题"。这里保证 prefix 始终在最前，避免"前缀设置无效"。
  let commentTitle = rawTitle;
  if (prefix) {
    if (!commentTitle) commentTitle = prefix;
    else if (!commentTitle.startsWith(prefix)) commentTitle = `${prefix}｜${commentTitle}`;
  }
  // 若启用“索引编号触发”：把 A-001 写进 comment，便于在世界书列表里一眼定位。
  if (indexInComment) {
    if (!commentTitle.includes(indexId)) {
      if (commentTitle === prefix) commentTitle = `${prefix}｜${indexId}`;
      else if (commentTitle.startsWith(`${prefix}｜`)) commentTitle = commentTitle.replace(`${prefix}｜`, `${prefix}｜${indexId}｜`);
      else commentTitle = `${prefix}｜${indexId}｜${commentTitle}`;
      commentTitle = commentTitle.replace(/｜｜+/g, '｜');
    }
  }
  if (!commentTitle) commentTitle = '剧情总结';
  const comment = `${commentTitle}${range ? `（${range}）` : ''}`;

  // normalize content and make it safe for slash parser (avoid accidental pipe split)
  const content = String(rec.summary || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '｜');

  const t = String(target || 'file');
  const f = String(file || '').trim();
  if (t === 'file' && !f) throw new Error('WorldInfo 目标为 file 时必须填写世界书文件名。');

  // We purposely avoid parsing UID in JS, because some ST builds return only a status object
  // (e.g. {pipe:"0", ...}) even when the command pipes the UID internally.
  // Instead, we build a single STscript pipeline that:
  // 1) resolves chatbook file name (if needed)
  // 2) creates the entry (UID goes into pipe)
  // 3) stores UID into a local var
  // 4) sets fields using the stored UID
  // This works regardless of whether JS can read the piped output.
  const uidVar = '__sg_summary_uid';
  const fileVar = '__sg_summary_wbfile';

  const keyValue = (kws.length ? kws.join(',') : prefix);
  const constantVal = (Number(constant) === 1) ? 1 : 0;

  const fileExpr = (t === 'chatbook') ? `{{getvar::${fileVar}}}` : f;

  const parts = [];
  if (t === 'chatbook') {
    parts.push('/getchatbook');
    parts.push(`/setvar key=${fileVar}`);
  }

  // create entry + capture uid
  parts.push(`/createentry file=${quoteSlashValue(fileExpr)} key=${quoteSlashValue(keyValue)} ${quoteSlashValue(content)}`);
  parts.push(`/setvar key=${uidVar}`);

  // update fields
  parts.push(`/setentryfield file=${quoteSlashValue(fileExpr)} uid={{getvar::${uidVar}}} field=content ${quoteSlashValue(content)}`);
  parts.push(`/setentryfield file=${quoteSlashValue(fileExpr)} uid={{getvar::${uidVar}}} field=key ${quoteSlashValue(keyValue)}`);
  parts.push(`/setentryfield file=${quoteSlashValue(fileExpr)} uid={{getvar::${uidVar}}} field=comment ${quoteSlashValue(comment)}`);
  parts.push(`/setentryfield file=${quoteSlashValue(fileExpr)} uid={{getvar::${uidVar}}} field=disable 0`);
  parts.push(`/setentryfield file=${quoteSlashValue(fileExpr)} uid={{getvar::${uidVar}}} field=constant ${constantVal}`);

  // cleanup temp vars
  parts.push(`/flushvar ${uidVar}`);
  if (t === 'chatbook') parts.push(`/flushvar ${fileVar}`);

  const script = parts.join(' | ');
  const out = await execSlash(script);
  if (out && typeof out === 'object' && (out.isError || out.isAborted || out.isQuietlyAborted)) {
    throw new Error(`写入世界书失败（返回：${safeStringifyShort(out)}）`);
  }

  // store link (UID is intentionally omitted because it may be inaccessible from JS in some ST builds)
  const keyName = (constantVal === 1) ? 'worldInfoBlue' : 'worldInfoGreen';
  rec[keyName] = { file: (t === 'file') ? f : 'chatbook', uid: null };
  if (meta && Array.isArray(meta.history) && meta.history.length) {
    meta.history[meta.history.length - 1] = rec;
    await setSummaryMeta(meta);
  }

  return { file: (t === 'file') ? f : 'chatbook', uid: null };
}

function stopSummary() {
  if (isSummarizing) {
    summaryCancelled = true;
    console.log('[StoryGuide] Summary stop requested');
  }
}

async function runSummary({ reason = 'manual', manualFromFloor = null, manualToFloor = null, manualSplit = null } = {}) {
  const s = ensureSettings();
  const ctx = SillyTavern.getContext();

  if (reason === 'auto' && !s.enabled) return;

  if (isSummarizing) return;
  isSummarizing = true;
  summaryCancelled = false;
  setStatus('总结中…', 'warn');
  showToast('正在总结…', { kind: 'warn', spinner: true, sticky: true });

  try {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const mode = String(s.summaryCountMode || 'assistant');
    const floorNow = computeFloorCount(chat, mode);

    let meta = getSummaryMeta();
    if (!meta || typeof meta !== 'object') meta = getDefaultSummaryMeta();
    // choose range(s)
    const every = clampInt(s.summaryEvery, 1, 200, 20);
    const segments = [];

    if (reason === 'manual_range') {
      const resolved0 = resolveChatRangeByFloors(chat, mode, manualFromFloor, manualToFloor);
      if (!resolved0) {
        setStatus('手动楼层范围无效（请检查起止层号）', 'warn');
        showToast('手动楼层范围无效（请检查起止层号）', { kind: 'warn', spinner: false, sticky: false, duration: 2200 });
        return;
      }

      const splitEnabled = (manualSplit === null || manualSplit === undefined)
        ? !!s.summaryManualSplit
        : !!manualSplit;

      if (splitEnabled && every > 0) {
        const a0 = resolved0.fromFloor;
        const b0 = resolved0.toFloor;
        for (let f = a0; f <= b0; f += every) {
          const g = Math.min(b0, f + every - 1);
          const r = resolveChatRangeByFloors(chat, mode, f, g);
          if (r) segments.push(r);
        }
        if (!segments.length) segments.push(resolved0);
      } else {
        segments.push(resolved0);
      }
    } else if (reason === 'auto' && meta.lastChatLen > 0 && meta.lastChatLen < chat.length) {
      const startIdx = meta.lastChatLen;
      const fromFloor = Math.max(1, Number(meta.lastFloor || 0) + 1);
      const toFloor = floorNow;
      const endIdx = Math.max(0, chat.length - 1);
      segments.push({ startIdx, endIdx, fromFloor, toFloor, floorNow });
    } else {
      const startIdx = findStartIndexForLastNFloors(chat, mode, every);
      const fromFloor = Math.max(1, floorNow - every + 1);
      const toFloor = floorNow;
      const endIdx = Math.max(0, chat.length - 1);
      segments.push({ startIdx, endIdx, fromFloor, toFloor, floorNow });
    }

    const totalSeg = segments.length;
    if (!totalSeg) {
      setStatus('没有可总结的内容（范围为空）', 'warn');
      showToast('没有可总结的内容（范围为空）', { kind: 'warn', spinner: false, sticky: false, duration: 2200 });
      return;
    }

    const affectsProgress = (reason !== 'manual_range');
    const keyMode = String(s.summaryWorldInfoKeyMode || 'keywords');

    let created = 0;
    let wroteGreenOk = 0;
    let wroteBlueOk = 0;
    const writeErrs = [];
    const runErrs = [];

    // 读取 stat_data（如果启用）
    let summaryStatData = null;
    if (s.summaryReadStatData) {
      try {
        const { statData } = await resolveStatDataComprehensive(chat, {
          ...s,
          wiRollStatVarName: s.summaryStatVarName || 'stat_data'
        });
        if (statData) {
          summaryStatData = statData;
          console.log('[StoryGuide] Summary loaded stat_data:', summaryStatData);
        }
      } catch (e) {
        console.warn('[StoryGuide] Failed to load stat_data for summary:', e);
      }
    }

    for (let i = 0; i < segments.length; i++) {
      // 检查是否被取消
      if (summaryCancelled) {
        setStatus('总结已取消', 'warn');
        showToast('总结已取消', { kind: 'warn', spinner: false, sticky: false, duration: 2000 });
        break;
      }

      const seg = segments[i];
      const startIdx = seg.startIdx;
      const endIdx = seg.endIdx;
      const fromFloor = seg.fromFloor;
      const toFloor = seg.toFloor;

      if (totalSeg > 1) setStatus(`手动分段总结中…（${i + 1}/${totalSeg}｜${fromFloor}-${toFloor}）`, 'warn');
      else setStatus('总结中…', 'warn');

      const chunkText = buildSummaryChunkTextRange(chat, startIdx, endIdx, s.summaryMaxCharsPerMessage, s.summaryMaxTotalChars);
      if (!chunkText) {
        runErrs.push(`${fromFloor}-${toFloor}：片段为空`);
        continue;
      }

      const messages = buildSummaryPromptMessages(chunkText, fromFloor, toFloor, summaryStatData);
      const schema = getSummarySchema();

      let jsonText = '';
      if (String(s.summaryProvider || 'st') === 'custom') {
        jsonText = await callViaCustom(s.summaryCustomEndpoint, s.summaryCustomApiKey, s.summaryCustomModel, messages, s.summaryTemperature, s.summaryCustomMaxTokens, 0.95, s.summaryCustomStream);
        const parsedTry = safeJsonParse(jsonText);
        if (!parsedTry || !parsedTry.summary) {
          try { jsonText = await fallbackAskJsonCustom(s.summaryCustomEndpoint, s.summaryCustomApiKey, s.summaryCustomModel, messages, s.summaryTemperature, s.summaryCustomMaxTokens, 0.95, s.summaryCustomStream); }
          catch { /* ignore */ }
        }
      } else {
        jsonText = await callViaSillyTavern(messages, schema, s.summaryTemperature);
        if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
        const parsedTry = safeJsonParse(jsonText);
        if (!parsedTry || !parsedTry.summary) jsonText = await fallbackAskJson(messages, s.summaryTemperature);
      }

      const parsed = safeJsonParse(jsonText);
      if (!parsed || !parsed.summary) {
        runErrs.push(`${fromFloor}-${toFloor}：总结输出无法解析为 JSON`);
        continue;
      }

      const prefix = String(s.summaryWorldInfoCommentPrefix || '剧情总结').trim() || '剧情总结';
      const rawTitle = String(parsed.title || '').trim();
      const summary = String(parsed.summary || '').trim();
      const modelKeywords = sanitizeKeywords(parsed.keywords);
      let indexId = '';
      let keywords = modelKeywords;

      if (keyMode === 'indexId') {
        // init nextIndex
        if (!Number.isFinite(Number(meta.nextIndex))) {
          let maxN = 0;
          const pref = String(s.summaryIndexPrefix || 'A-');
          const re = new RegExp('^' + escapeRegExp(pref) + '(\\d+)$');
          for (const h of (Array.isArray(meta.history) ? meta.history : [])) {
            const id0 = String(h?.indexId || '').trim();
            const m = id0.match(re);
            if (m) maxN = Math.max(maxN, Number.parseInt(m[1], 10) || 0);
          }
          meta.nextIndex = Math.max(clampInt(s.summaryIndexStart, 1, 1000000, 1), maxN + 1);
        }

        const pref = String(s.summaryIndexPrefix || 'A-');
        const pad = clampInt(s.summaryIndexPad, 1, 12, 3);
        const n = clampInt(meta.nextIndex, 1, 100000000, 1);
        indexId = `${pref}${String(n).padStart(pad, '0')}`;
        keywords = [indexId];
      }

      const title = rawTitle || `${prefix}`;

      const rec = {
        title,
        summary,
        keywords,
        indexId: indexId || undefined,
        modelKeywords: (keyMode === 'indexId') ? modelKeywords : undefined,
        createdAt: Date.now(),
        range: { fromFloor, toFloor, fromIdx: startIdx, toIdx: endIdx },
      };

      if (keyMode === 'indexId') {
        meta.nextIndex = clampInt(Number(meta.nextIndex) + 1, 1, 1000000000, Number(meta.nextIndex) + 1);
      }

      meta.history = Array.isArray(meta.history) ? meta.history : [];
      meta.history.push(rec);
      if (meta.history.length > 120) meta.history = meta.history.slice(-120);
      if (affectsProgress) {
        meta.lastFloor = toFloor;
        meta.lastChatLen = chat.length;
      }
      await setSummaryMeta(meta);
      created += 1;

      // 同步进蓝灯索引缓存（用于本地匹配/预筛选）
      try { appendToBlueIndexCache(rec); } catch { /* ignore */ }

      // 生成结构化世界书条目（人物/装备/能力 - 与剧情总结同一事务）
      if (s.structuredEntriesEnabled && (s.summaryToWorldInfo || s.summaryToBlueWorldInfo)) {
        try {
          const structuredResult = await generateStructuredEntries(chunkText, fromFloor, toFloor, meta, s, summaryStatData);
          console.log('[StoryGuide] Structured entries result:', structuredResult);
          if (structuredResult) {
            // 写入/更新人物条目（去重由 writeOrUpdate 内部处理）
            if (s.characterEntriesEnabled && structuredResult.characters?.length) {
              console.log(`[StoryGuide] Processing ${structuredResult.characters.length} character(s)`);
              for (const char of structuredResult.characters) {
                await writeOrUpdateCharacterEntry(char, meta, s);
              }
            }
            // 写入/更新装备条目
            if (s.equipmentEntriesEnabled && structuredResult.equipments?.length) {
              console.log(`[StoryGuide] Processing ${structuredResult.equipments.length} equipment(s)`);
              for (const equip of structuredResult.equipments) {
                await writeOrUpdateEquipmentEntry(equip, meta, s);
              }
            }
            // 写入/更新能力条目
            if (s.abilityEntriesEnabled && structuredResult.abilities?.length) {
              console.log(`[StoryGuide] Processing ${structuredResult.abilities.length} ability(s)`);
              for (const ability of structuredResult.abilities) {
                await writeOrUpdateAbilityEntry(ability, meta, s);
              }
            }

            // 处理删除的条目
            if (structuredResult.deletedCharacters?.length) {
              console.log(`[StoryGuide] Deleting ${structuredResult.deletedCharacters.length} character(s)`);
              for (const charName of structuredResult.deletedCharacters) {
                await deleteCharacterEntry(charName, meta, s);
              }
            }
            if (structuredResult.deletedEquipments?.length) {
              console.log(`[StoryGuide] Deleting ${structuredResult.deletedEquipments.length} equipment(s)`);
              for (const equipName of structuredResult.deletedEquipments) {
                await deleteEquipmentEntry(equipName, meta, s);
              }
            }
            if (structuredResult.deletedAbilities?.length) {
              console.log(`[StoryGuide] Deleting ${structuredResult.deletedAbilities.length} ability(s)`);
              for (const abilityName of structuredResult.deletedAbilities) {
                await deleteAbilityEntry(abilityName, meta, s);
              }
            }

            await setSummaryMeta(meta);
          }
        } catch (e) {
          console.warn('[StoryGuide] Structured entries generation failed:', e);
          // 结构化条目生成失败不阻断主流程
        }
      }

      // world info write
      if (s.summaryToWorldInfo || s.summaryToBlueWorldInfo) {
        if (s.summaryToWorldInfo) {
          try {
            await writeSummaryToWorldInfoEntry(rec, meta, {
              target: String(s.summaryWorldInfoTarget || 'chatbook'),
              file: String(s.summaryWorldInfoFile || ''),
              commentPrefix: String(s.summaryWorldInfoCommentPrefix || '剧情总结'),
              constant: 0,
            });
            wroteGreenOk += 1;
          } catch (e) {
            console.warn('[StoryGuide] write green world info failed:', e);
            writeErrs.push(`${fromFloor}-${toFloor} 绿灯：${e?.message ?? e}`);
          }
        }

        if (s.summaryToBlueWorldInfo) {
          try {
            await writeSummaryToWorldInfoEntry(rec, meta, {
              target: 'file',
              file: String(s.summaryBlueWorldInfoFile || ''),
              commentPrefix: String(s.summaryBlueWorldInfoCommentPrefix || s.summaryWorldInfoCommentPrefix || '剧情总结'),
              constant: 1,
            });
            wroteBlueOk += 1;
          } catch (e) {
            console.warn('[StoryGuide] write blue world info failed:', e);
            writeErrs.push(`${fromFloor}-${toFloor} 蓝灯：${e?.message ?? e}`);
          }
        }
      }
    }

    updateSummaryInfoLabel();
    renderSummaryPaneFromMeta();

    // 若启用实时读取索引：在手动分段写入蓝灯后，尽快刷新一次缓存
    if (s.summaryToBlueWorldInfo && String(ensureSettings().wiBlueIndexMode || 'live') === 'live') {
      ensureBlueIndexLive(true).catch(() => void 0);
    }

    if (created <= 0) {
      setStatus(`总结未生成（${runErrs.length ? runErrs[0] : '未知原因'}）`, 'warn');
      showToast(`总结未生成（${runErrs.length ? runErrs[0] : '未知原因'}）`, { kind: 'warn', spinner: false, sticky: false, duration: 2600 });
      return;
    }

    // final status
    if (totalSeg > 1) {
      const parts = [`生成 ${created} 条`];
      if (s.summaryToWorldInfo || s.summaryToBlueWorldInfo) {
        const wrote = [];
        if (s.summaryToWorldInfo) wrote.push(`绿灯 ${wroteGreenOk}/${created}`);
        if (s.summaryToBlueWorldInfo) wrote.push(`蓝灯 ${wroteBlueOk}/${created}`);
        if (wrote.length) parts.push(`写入：${wrote.join('｜')}`);
      }
      const errCount = writeErrs.length + runErrs.length;
      if (errCount) {
        const sample = (writeErrs.concat(runErrs)).slice(0, 2).join('；');
        setStatus(`手动分段总结完成 ✅（${parts.join('｜')}｜失败：${errCount}｜${sample}${errCount > 2 ? '…' : ''}）`, 'warn');
      } else {
        setStatus(`手动分段总结完成 ✅（${parts.join('｜')}）`, 'ok');
      }
    } else {
      // single
      if (s.summaryToWorldInfo || s.summaryToBlueWorldInfo) {
        const ok = [];
        const err = [];
        if (s.summaryToWorldInfo) {
          if (wroteGreenOk >= 1) ok.push('绿灯世界书');
          else if (writeErrs.find(x => x.includes('绿灯'))) err.push(writeErrs.find(x => x.includes('绿灯')));
        }
        if (s.summaryToBlueWorldInfo) {
          if (wroteBlueOk >= 1) ok.push('蓝灯世界书');
          else if (writeErrs.find(x => x.includes('蓝灯'))) err.push(writeErrs.find(x => x.includes('蓝灯')));
        }
        if (!err.length) setStatus(`总结完成 ✅（已写入：${ok.join(' + ') || '（无）'}）`, 'ok');
        else setStatus(`总结完成 ✅（写入失败：${err.join('；')}）`, 'warn');
      } else {
        setStatus('总结完成 ✅', 'ok');
      }
    }

    // toast notify (non-blocking)
    try {
      const errCount = (writeErrs?.length || 0) + (runErrs?.length || 0);
      const kind = errCount ? 'warn' : 'ok';
      const text = (totalSeg > 1)
        ? (errCount ? '分段总结完成 ⚠️' : '分段总结完成 ✅')
        : (errCount ? '总结完成 ⚠️' : '总结完成 ✅');
      showToast(text, { kind, spinner: false, sticky: false, duration: errCount ? 2600 : 1700 });
    } catch { /* ignore toast errors */ }



  } catch (e) {
    console.error('[StoryGuide] Summary failed:', e);
    const msg = (e && (e.message || String(e))) ? (e.message || String(e)) : '未知错误';
    setStatus(`总结失败 ❌（${msg}）`, 'err');
    showToast(`总结失败 ❌（${msg}）`, { kind: 'err', spinner: false, sticky: false, duration: 3200 });
  } finally {

    isSummarizing = false;
    updateButtonsEnabled();
    // avoid stuck "正在总结" toast on unexpected exits
    try { if ($('#sg_toast').hasClass('spinner')) hideToast(); } catch { /* ignore */ }
  }
}

function scheduleAutoSummary(reason = '') {
  const s = ensureSettings();
  if (!s.enabled) return;
  if (!s.summaryEnabled) return;
  const delay = clampInt(s.debounceMs, 300, 10000, DEFAULT_SETTINGS.debounceMs);
  if (summaryTimer) clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    maybeAutoSummary(reason).catch(() => void 0);
  }, delay);
}

async function maybeAutoSummary(reason = '') {
  const s = ensureSettings();
  if (!s.enabled) return;
  if (!s.summaryEnabled) return;
  if (isSummarizing) return;

  const ctx = SillyTavern.getContext();
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  const mode = String(s.summaryCountMode || 'assistant');
  const every = clampInt(s.summaryEvery, 1, 200, 20);
  const floorNow = computeFloorCount(chat, mode);
  if (floorNow <= 0) return;
  if (floorNow % every !== 0) return;

  const meta = getSummaryMeta();
  const last = Number(meta?.lastFloor || 0);
  if (floorNow <= last) return;

  await runSummary({ reason: 'auto' });
}

// -------------------- 蓝灯索引 → 绿灯触发（发送消息时注入触发词） --------------------

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTriggerInjection(text, tag = 'SG_WI_TRIGGERS') {
  const t = String(text || '');
  const et = escapeRegExp(tag);
  // remove all existing injections of this tag (safe)
  const reComment = new RegExp(`\\n?\\s*<!--\\s*${et}\\b[\\s\\S]*?-->`, 'g');
  const rePlain = new RegExp(`\\n?\\s*\\[${et}\\][^\\n]*\\n?`, 'g');
  return t.replace(reComment, '').replace(rePlain, '').trimEnd();
}

function buildTriggerInjection(keywords, tag = 'SG_WI_TRIGGERS', style = 'hidden') {
  const kws = sanitizeKeywords(Array.isArray(keywords) ? keywords : []);
  if (!kws.length) return '';
  if (String(style || 'hidden') === 'plain') {
    // Visible but most reliable for world-info scan.
    return `\n\n[${tag}] ${kws.join(' ')}\n`;
  }
  // Hidden comment: put each keyword on its own line, so substring match is very likely to hit.
  const body = kws.join('\n');
  return `\n\n<!--${tag}\n${body}\n-->`;
}

// -------------------- ROLL 判定 --------------------
function rollDice(sides = 100) {
  const s = Math.max(2, Number(sides) || 100);
  return Math.floor(Math.random() * s) + 1;
}

function makeNumericProxy(obj) {
  const src = (obj && typeof obj === 'object') ? obj : {};
  return new Proxy(src, {
    get(target, prop) {
      if (prop === Symbol.toStringTag) return 'NumericProxy';
      if (prop in target) {
        const v = target[prop];
        if (v && typeof v === 'object') return makeNumericProxy(v);
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    },
  });
}

function detectRollAction(text, actions) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const list = Array.isArray(actions) ? actions : DEFAULT_ROLL_ACTIONS;
  for (const a of list) {
    const kws = Array.isArray(a?.keywords) ? a.keywords : [];
    for (const kw of kws) {
      const k = String(kw || '').toLowerCase();
      if (k && t.includes(k)) return { key: String(a.key || ''), label: String(a.label || a.key || '') };
    }
  }
  return null;
}

function extractStatusBlock(text, tagName = 'status_current_variable') {
  const t = String(text || '');
  if (!t) return '';
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let m = null;
  let last = '';
  while ((m = re.exec(t))) {
    if (m && m[1]) last = m[1];
  }
  return String(last || '').trim();
}

function parseStatData(text, mode = 'json') {
  const raw = String(text || '').trim();
  if (!raw) return null;

  if (String(mode || 'json') === 'kv') {
    const out = { pc: {}, mods: {}, context: {} };
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^([a-zA-Z0-9_.\[\]-]+)\s*[:=]\s*([+-]?\d+(?:\.\d+)?)\s*$/);
      if (!m) continue;
      const path = m[1];
      const val = Number(m[2]);
      if (!Number.isFinite(val)) continue;
      if (path.startsWith('pc.')) {
        const k = path.slice(3);
        out.pc[k] = val;
      } else if (path.startsWith('mods.')) {
        const k = path.slice(5);
        out.mods[k] = val;
      } else if (path.startsWith('context.')) {
        const k = path.slice(8);
        out.context[k] = val;
      }
    }
    return out;
  }

  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

function normalizeStatData(data) {
  const obj = (data && typeof data === 'object') ? data : {};
  const pc = (obj.pc && typeof obj.pc === 'object') ? obj.pc : {};
  const mods = (obj.mods && typeof obj.mods === 'object') ? obj.mods : {};
  const context = (obj.context && typeof obj.context === 'object') ? obj.context : {};
  return { pc, mods, context };
}

function buildModifierBreakdown(mods, sources) {
  const srcList = Array.isArray(sources) && sources.length
    ? sources
    : DEFAULT_ROLL_MODIFIER_SOURCES;
  const out = [];
  for (const key of srcList) {
    const raw = mods?.[key];
    let v = 0;
    if (Number.isFinite(Number(raw))) {
      v = Number(raw);
    } else if (raw && typeof raw === 'object') {
      for (const val of Object.values(raw)) {
        const n = Number(val);
        if (Number.isFinite(n)) v += n;
      }
    }
    out.push({ source: String(key), value: Number.isFinite(v) ? v : 0 });
  }
  const total = out.reduce((acc, x) => acc + (Number.isFinite(x.value) ? x.value : 0), 0);
  return { list: out, total };
}

function evaluateRollFormula(formula, ctx) {
  const expr = String(formula || '').trim();
  if (!expr) return 0;
  try {
    const fn = new Function('ctx', 'with(ctx){ return (' + expr + '); }');
    const v = fn(ctx);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function computeRollLocal(actionKey, statData, settings) {
  const s = settings || ensureSettings();
  const { pc, mods, context } = normalizeStatData(statData);
  const modBreakdown = buildModifierBreakdown(mods, safeJsonParse(s.wiRollModifierSourcesJson) || null);

  const formulas = safeJsonParse(s.wiRollFormulaJson) || DEFAULT_ROLL_FORMULAS;
  const formula = String(formulas?.[actionKey] || formulas?.default || DEFAULT_ROLL_FORMULAS.default);

  const ctx = {
    PC: makeNumericProxy(pc),
    MOD: {
      total: modBreakdown.total,
      bySource: makeNumericProxy(modBreakdown.list.reduce((acc, x) => { acc[x.source] = x.value; return acc; }, {})),
    },
    CTX: makeNumericProxy(context),
    ACTION: String(actionKey || ''),
    CLAMP: (v, lo, hi) => clampFloat(v, lo, hi, v),
  };

  const base = evaluateRollFormula(formula, ctx);
  const randWeight = clampFloat(s.wiRollRandomWeight, 0, 1, 0.3);
  const roll = rollDice(100);
  const randFactor = (roll - 50) / 50;
  const final = base + base * randWeight * randFactor;
  const threshold = 50;
  const success = final >= threshold;

  return {
    action: String(actionKey || ''),
    formula,
    base,
    mods: modBreakdown.list,
    random: { roll, weight: randWeight },
    final,
    threshold,
    success,
  };
}

function normalizeRollMods(mods, sources) {
  const srcList = Array.isArray(sources) && sources.length ? sources : DEFAULT_ROLL_MODIFIER_SOURCES;
  const map = new Map();
  for (const m of (Array.isArray(mods) ? mods : [])) {
    const key = String(m?.source || '').trim();
    if (!key) continue;
    const v = Number(m?.value);
    map.set(key, Number.isFinite(v) ? v : 0);
  }
  return srcList.map(s => ({ source: String(s), value: map.has(s) ? map.get(s) : 0 }));
}

function getRollAnalysisSummary(res) {
  if (!res || typeof res !== 'object') return '';
  const raw = res.analysisSummary ?? res.analysis_summary ?? res.explanation ?? res.reason ?? '';
  if (raw && typeof raw === 'object') {
    const pick = raw.summary ?? raw.text ?? raw.message;
    if (pick != null) return String(pick).trim();
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  return String(raw || '').trim();
}

function buildRollPromptMessages(actionKey, statData, settings, formula, randomWeight, randomRoll) {
  const s = settings || ensureSettings();
  const sys = String(s.wiRollSystemPrompt || DEFAULT_ROLL_SYSTEM_PROMPT).trim() || DEFAULT_ROLL_SYSTEM_PROMPT;
  const tmpl = String(s.wiRollUserTemplate || DEFAULT_ROLL_USER_TEMPLATE).trim() || DEFAULT_ROLL_USER_TEMPLATE;
  const difficulty = String(s.wiRollDifficulty || 'normal');
  const statDataJson = JSON.stringify(statData || {}, null, 0);
  const modifierSourcesJson = String(s.wiRollModifierSourcesJson || JSON.stringify(DEFAULT_ROLL_MODIFIER_SOURCES));
  const user = tmpl
    .replaceAll('{{action}}', String(actionKey || ''))
    .replaceAll('{{formula}}', String(formula || ''))
    .replaceAll('{{randomWeight}}', String(randomWeight))
    .replaceAll('{{difficulty}}', difficulty)
    .replaceAll('{{randomRoll}}', String(randomRoll))
    .replaceAll('{{modifierSourcesJson}}', modifierSourcesJson)
    .replaceAll('{{statDataJson}}', statDataJson);

  const enforced = user + `\n\n` + ROLL_JSON_REQUIREMENT;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: enforced },
  ];
}

function buildRollDecisionPromptMessages(userText, statData, settings, randomRoll) {
  const s = settings || ensureSettings();
  const rawSys = String(s.wiRollSystemPrompt || '').trim();
  const sys = (rawSys && rawSys !== DEFAULT_ROLL_SYSTEM_PROMPT)
    ? rawSys
    : DEFAULT_ROLL_DECISION_SYSTEM_PROMPT;
  const randomWeight = clampFloat(s.wiRollRandomWeight, 0, 1, 0.3);
  const difficulty = String(s.wiRollDifficulty || 'normal');
  const statDataJson = JSON.stringify(statData || {}, null, 0);

  const user = DEFAULT_ROLL_DECISION_USER_TEMPLATE
    .replaceAll('{{userText}}', String(userText || ''))
    .replaceAll('{{randomWeight}}', String(randomWeight))
    .replaceAll('{{difficulty}}', difficulty)
    .replaceAll('{{randomRoll}}', String(randomRoll))
    .replaceAll('{{statDataJson}}', statDataJson);

  const enforced = user + `\n\n` + ROLL_DECISION_JSON_REQUIREMENT;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: enforced },
  ];
}

async function computeRollViaCustomProvider(actionKey, statData, settings, randomRoll) {
  const s = settings || ensureSettings();
  const formulas = safeJsonParse(s.wiRollFormulaJson) || DEFAULT_ROLL_FORMULAS;
  const formula = String(formulas?.[actionKey] || formulas?.default || DEFAULT_ROLL_FORMULAS.default);
  const randomWeight = clampFloat(s.wiRollRandomWeight, 0, 1, 0.3);
  const messages = buildRollPromptMessages(actionKey, statData, s, formula, randomWeight, randomRoll);

  const jsonText = await callViaCustom(
    s.wiRollCustomEndpoint,
    s.wiRollCustomApiKey,
    s.wiRollCustomModel,
    messages,
    clampFloat(s.wiRollCustomTemperature, 0, 2, 0.2),
    clampInt(s.wiRollCustomMaxTokens, 128, 200000, 512),
    clampFloat(s.wiRollCustomTopP, 0, 1, 0.95),
    !!s.wiRollCustomStream
  );

  const parsed = safeJsonParse(jsonText);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.mods)) return null;

  if (!Array.isArray(parsed.mods)) parsed.mods = [];
  parsed.action = String(parsed.action || actionKey || '');
  parsed.formula = String(parsed.formula || formula || '');
  return parsed;
}

async function computeRollDecisionViaCustom(userText, statData, settings, randomRoll) {
  const s = settings || ensureSettings();
  const messages = buildRollDecisionPromptMessages(userText, statData, s, randomRoll);

  const jsonText = await callViaCustom(
    s.wiRollCustomEndpoint,
    s.wiRollCustomApiKey,
    s.wiRollCustomModel,
    messages,
    clampFloat(s.wiRollCustomTemperature, 0, 2, 0.2),
    clampInt(s.wiRollCustomMaxTokens, 128, 200000, 512),
    clampFloat(s.wiRollCustomTopP, 0, 1, 0.95),
    !!s.wiRollCustomStream
  );

  const parsed = safeJsonParse(jsonText);
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.needRoll === false) return { noRoll: true };

  const res = parsed.result && typeof parsed.result === 'object' ? parsed.result : parsed;
  if (!res || typeof res !== 'object') return null;

  return res;
}

function buildRollInjectionFromResult(res, tag = 'SG_ROLL', style = 'hidden') {
  if (!res) return '';
  const action = String(res.actionLabel || res.action || '').trim();
  const formula = String(res.formula || '').trim();
  const base = Number.isFinite(Number(res.base)) ? Number(res.base) : 0;
  const final = Number.isFinite(Number(res.final)) ? Number(res.final) : 0;
  const threshold = Number.isFinite(Number(res.threshold)) ? Number(res.threshold) : null;
  const success = res.success == null ? null : !!res.success;
  const roll = Number.isFinite(Number(res.random?.roll)) ? Number(res.random?.roll) : 0;
  const weight = Number.isFinite(Number(res.random?.weight)) ? Number(res.random?.weight) : 0;
  const mods = Array.isArray(res.mods) ? res.mods : [];
  const modLine = mods.map(m => `${m.source}:${Number(m.value) >= 0 ? '+' : ''}${Number(m.value) || 0}`).join(' | ');
  const outcome = String(res.outcomeTier || '').trim() || (success == null ? 'N/A' : (success ? '成功' : '失败'));

  if (String(style || 'hidden') === 'plain') {
    return `\n\n[${tag}] 动作=${action} | 结果=${outcome} | 最终=${final.toFixed(2)} | 阈值>=${threshold == null ? 'N/A' : threshold} | 基础=${base.toFixed(2)} | 随机=1d100:${roll}*${weight} | 修正=${modLine} | 公式=${formula}\n`;
  }

  return `\n\n<!--${tag}\n动作=${action}\n结果=${outcome}\n最终=${final.toFixed(2)}\n阈值>=${threshold == null ? 'N/A' : threshold}\n基础=${base.toFixed(2)}\n随机=1d100:${roll}*${weight}\n修正=${modLine}\n公式=${formula}\n-->`;
}

function getLatestAssistantText(chat, strip = true) {
  const arr = Array.isArray(chat) ? chat : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m) continue;
    if (m.is_system === true) continue;
    if (m.is_user === true) continue;
    const raw = String(m.mes ?? m.message ?? '');
    return strip ? stripHtml(raw) : raw;
  }
  return '';
}

function resolveStatDataFromLatestAssistant(chat, settings) {
  const s = settings || ensureSettings();
  const lastText = getLatestAssistantText(chat, false);
  const block = extractStatusBlock(lastText);
  const parsed = parseStatData(block, s.wiRollStatParseMode || 'json');
  return { statData: parsed, rawText: block };
}

function resolveStatDataFromVariableStore(settings) {
  const s = settings || ensureSettings();
  const key = String(s.wiRollStatVarName || 'stat_data').trim();
  if (!key) return { statData: null, rawText: '' };
  const ctx = SillyTavern.getContext?.() ?? {};

  // 扩展所有可能的变量来源，按优先级排序
  const sources = [
    // 优先从 context 获取（最新值）
    ctx?.variables,
    ctx?.chatMetadata?.variables,
    ctx?.chatMetadata,
    // 全局变量存储
    globalThis?.SillyTavern?.chatVariables,
    globalThis?.SillyTavern?.variables,
    globalThis?.variables,
    globalThis?.chatVariables,
    // extension_settings 中可能存储的变量
    ctx?.extensionSettings?.variables,
    // window 对象上的变量
    window?.variables,
    window?.chatVariables,
  ].filter(Boolean);

  let raw = null;
  for (const src of sources) {
    if (src && Object.prototype.hasOwnProperty.call(src, key)) {
      raw = src[key];
      break;
    }
  }

  // 如果上述来源都没找到，尝试从 chat 数组中的最后一条消息的 extra 字段读取
  if (raw == null && Array.isArray(ctx?.chat)) {
    for (let i = ctx.chat.length - 1; i >= Math.max(0, ctx.chat.length - 5); i--) {
      const msg = ctx.chat[i];
      if (msg?.extra?.variables && Object.prototype.hasOwnProperty.call(msg.extra.variables, key)) {
        raw = msg.extra.variables[key];
        break;
      }
      if (msg?.variables && Object.prototype.hasOwnProperty.call(msg.variables, key)) {
        raw = msg.variables[key];
        break;
      }
    }
  }

  if (raw == null) return { statData: null, rawText: '' };
  if (typeof raw === 'string') {
    const parsed = parseStatData(raw, s.wiRollStatParseMode || 'json');
    return { statData: parsed, rawText: raw };
  }
  if (typeof raw === 'object') {
    return { statData: raw, rawText: JSON.stringify(raw) };
  }
  return { statData: null, rawText: '' };
}

async function resolveStatDataFromTemplate(settings) {
  const s = settings || ensureSettings();
  const tpl = `<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>`;
  const ctx = SillyTavern.getContext?.() ?? {};
  const fns = [
    ctx?.renderTemplateAsync,
    ctx?.renderTemplate,
    ctx?.formatMessageVariables,
    ctx?.replaceMacros,
    globalThis?.renderTemplate,
    globalThis?.formatMessageVariables,
    globalThis?.replaceMacros,
  ].filter(Boolean);
  let rendered = '';
  for (const fn of fns) {
    try {
      const out = await fn(tpl);
      if (typeof out === 'string' && out.trim()) {
        rendered = out;
        break;
      }
    } catch { /* ignore */ }
  }
  if (!rendered || rendered.includes('{{format_message_variable::stat_data}}')) {
    return { statData: null, rawText: '' };
  }
  const block = extractStatusBlock(rendered);
  const parsed = parseStatData(block, s.wiRollStatParseMode || 'json');
  return { statData: parsed, rawText: block };
}

/**
 * 最稳定的变量读取方式：通过 /getvar 斜杠命令读取变量
 * 由于 SillyTavern 变量系统可能存在缓存或上下文不同步问题，
 * 使用 slash command 可以确保读取到最新的变量值
 */
async function resolveStatDataViaSlashCommand(settings) {
  const s = settings || ensureSettings();
  const key = String(s.wiRollStatVarName || 'stat_data').trim();
  if (!key) return { statData: null, rawText: '' };

  try {
    // 尝试使用 /getvar 命令读取变量（最稳定的方式）
    const result = await execSlash(`/getvar ${key}`);
    const raw = slashOutputToText(result);

    if (!raw || raw.trim() === '' || raw.trim() === 'undefined' || raw.trim() === 'null') {
      return { statData: null, rawText: '' };
    }

    // 解析变量内容
    if (typeof raw === 'string') {
      // 尝试 JSON 解析
      const parsed = parseStatData(raw, s.wiRollStatParseMode || 'json');
      if (parsed) {
        return { statData: parsed, rawText: raw };
      }
    }

    return { statData: null, rawText: raw };
  } catch (e) {
    // /getvar 命令失败时静默处理，回退到其他方法
    console.debug('[StoryGuide] resolveStatDataViaSlashCommand failed:', e);
    return { statData: null, rawText: '' };
  }
}

/**
 * 扩展的变量读取：尝试从 chat 数组中的最新消息读取变量（直接读取 DOM）
 * 作为变量存储和模板方法的补充回退方案
 */
function resolveStatDataFromChatDOM(settings) {
  const s = settings || ensureSettings();
  const key = String(s.wiRollStatVarName || 'stat_data').trim();
  if (!key) return { statData: null, rawText: '' };

  try {
    // 尝试从 DOM 中查找最近的状态块
    const chatContainer = document.querySelector('#chat, .chat, [id*="chat"]');
    if (!chatContainer) return { statData: null, rawText: '' };

    // 查找所有消息块
    const messages = chatContainer.querySelectorAll('.mes, [class*="message"]');
    if (!messages.length) return { statData: null, rawText: '' };

    // 从后往前查找包含状态数据的消息
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 10); i--) {
      const msg = messages[i];
      if (!msg) continue;

      // 跳过用户消息
      const isUser = msg.classList.contains('user_mes') || msg.dataset.isUser === 'true';
      if (isUser) continue;

      const textEl = msg.querySelector('.mes_text, .message-text, [class*="mes_text"]');
      if (!textEl) continue;

      const text = textEl.innerText || textEl.textContent || '';
      if (!text) continue;

      // 尝试提取状态块
      const block = extractStatusBlock(text);
      if (block) {
        const parsed = parseStatData(block, s.wiRollStatParseMode || 'json');
        if (parsed) {
          return { statData: parsed, rawText: block };
        }
      }
    }

    return { statData: null, rawText: '' };
  } catch (e) {
    console.debug('[StoryGuide] resolveStatDataFromChatDOM failed:', e);
    return { statData: null, rawText: '' };
  }
}

/**
 * 综合查找变量数据：尝试多种来源以确保能读取到最新数据
 * 按优先级依次尝试：
 * 1. /getvar 斜杠命令（最稳定）
 * 2. 变量存储对象
 * 3. 模板渲染
 * 4. 从 DOM 读取
 * 5. 从最新 AI 回复读取
 */
async function resolveStatDataComprehensive(chat, settings) {
  const s = settings || ensureSettings();

  // 方法1：使用 /getvar 斜杠命令（最稳定）
  try {
    const { statData, rawText } = await resolveStatDataViaSlashCommand(s);
    if (statData) {
      console.debug('[StoryGuide] Variable loaded via /getvar slash command');
      return { statData, rawText, source: 'slashCommand' };
    }
  } catch { /* continue */ }

  // 方法2：从变量存储对象读取
  try {
    const { statData, rawText } = resolveStatDataFromVariableStore(s);
    if (statData) {
      console.debug('[StoryGuide] Variable loaded via variable store');
      return { statData, rawText, source: 'variableStore' };
    }
  } catch { /* continue */ }

  // 方法3：通过模板渲染读取
  try {
    const { statData, rawText } = await resolveStatDataFromTemplate(s);
    if (statData) {
      console.debug('[StoryGuide] Variable loaded via template rendering');
      return { statData, rawText, source: 'template' };
    }
  } catch { /* continue */ }

  // 方法4：从 DOM 读取
  try {
    const { statData, rawText } = resolveStatDataFromChatDOM(s);
    if (statData) {
      console.debug('[StoryGuide] Variable loaded via DOM');
      return { statData, rawText, source: 'dom' };
    }
  } catch { /* continue */ }

  // 方法5：从最新 AI 回复读取
  try {
    const { statData, rawText } = resolveStatDataFromLatestAssistant(chat, s);
    if (statData) {
      console.debug('[StoryGuide] Variable loaded via latest assistant message');
      return { statData, rawText, source: 'latestAssistant' };
    }
  } catch { /* continue */ }

  return { statData: null, rawText: '', source: null };
}

async function maybeInjectRollResult(reason = 'msg_sent') {
  const s = ensureSettings();
  if (!s.wiRollEnabled) return;

  const ctx = SillyTavern.getContext();
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  if (!chat.length) return;

  const modalOpen = $('#sg_modal_backdrop').is(':visible');
  const shouldLog = modalOpen || s.wiRollDebugLog;
  const logStatus = (msg, kind = 'info') => {
    if (!shouldLog) return;
    if (modalOpen) setStatus(msg, kind);
    else showToast(msg, { kind, spinner: false, sticky: false, duration: 2200 });
  };

  const last = chat[chat.length - 1];
  if (!last || last.is_user !== true) return; // only on user send
  let lastText = String(last.mes ?? last.message ?? '').trim();
  if (!lastText || lastText.startsWith('/')) return;
  const rollTag = String(s.wiRollTag || 'SG_ROLL').trim() || 'SG_ROLL';
  if (lastText.includes(rollTag)) return;
  lastText = stripTriggerInjection(lastText, rollTag);

  const source = String(s.wiRollStatSource || 'variable');
  let statData = null;
  let varSource = '';
  if (source === 'latest') {
    ({ statData } = resolveStatDataFromLatestAssistant(chat, s));
    varSource = 'latest';
  } else if (source === 'template') {
    ({ statData } = await resolveStatDataFromTemplate(s));
    varSource = 'template';
    if (!statData) {
      ({ statData } = await resolveStatDataViaSlashCommand(s));
      varSource = 'slashCommand';
    }
    if (!statData) {
      ({ statData } = resolveStatDataFromVariableStore(s));
      varSource = 'variableStore';
    }
    if (!statData) {
      ({ statData } = resolveStatDataFromLatestAssistant(chat, s));
      varSource = 'latestAssistant';
    }
  } else {
    // 默认使用综合方法（最稳定）
    const result = await resolveStatDataComprehensive(chat, s);
    statData = result.statData;
    varSource = result.source || '';
  }
  if (!statData) {
    const name = String(s.wiRollStatVarName || 'stat_data').trim() || 'stat_data';
    logStatus(`ROLL 未触发：未读取到变量（${name}）`, 'warn');
    return;
  }
  if (s.wiRollDebugLog && varSource) {
    console.debug(`[StoryGuide] ROLL 变量读取来源: ${varSource}`);
  }

  const randomRoll = rollDice(100);
  let res = null;
  const canUseCustom = String(s.wiRollProvider || 'custom') === 'custom' && String(s.wiRollCustomEndpoint || '').trim();
  if (canUseCustom) {
    try {
      res = await computeRollDecisionViaCustom(lastText, statData, s, randomRoll);
      if (res?.noRoll) {
        logStatus('ROLL 未触发：AI 判定无需判定', 'info');
        return;
      }
    } catch (e) {
      console.warn('[StoryGuide] roll custom provider failed; fallback to local', e);
    }
  }
  if (!res) {
    logStatus('ROLL 未触发：AI 判定失败或无结果', 'warn');
    return;
  }

  if (res) {
    if (!Array.isArray(res.mods)) res.mods = [];
    res.actionLabel = res.actionLabel || res.action || '';
    res.formula = res.formula || '';
    if (!res.random) res.random = { roll: randomRoll, weight: clampFloat(s.wiRollRandomWeight, 0, 1, 0.3) };
    if (res.final == null && Number.isFinite(Number(res.base))) {
      const randWeight = Number(res.random?.weight) || clampFloat(s.wiRollRandomWeight, 0, 1, 0.3);
      const randRoll = Number(res.random?.roll) || randomRoll;
      res.final = Number(res.base) + Number(res.base) * randWeight * ((randRoll - 50) / 50);
    }
    if (res.success == null && Number.isFinite(Number(res.final)) && Number.isFinite(Number(res.threshold))) {
      res.success = Number(res.final) >= Number(res.threshold);
    }
    const summary = getRollAnalysisSummary(res);
    if (summary) {
      appendRollLog({
        ts: Date.now(),
        action: res.actionLabel || res.action,
        outcomeTier: res.outcomeTier,
        summary,
        final: res.final,
        success: res.success,
        userText: lastText,
      });
    }
    const style = String(s.wiRollInjectStyle || 'hidden').trim() || 'hidden';
    const rollText = buildRollInjectionFromResult(res, rollTag, style);
    if (rollText) {
      const cleaned = stripTriggerInjection(last.mes ?? last.message ?? '', rollTag);
      last.mes = cleaned + rollText;
      logStatus('ROLL 已注入：判定完成', 'ok');
    }
  }

  // try save
  try {
    if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
    else if (typeof ctx.saveChat === 'function') ctx.saveChat();
  } catch { /* ignore */ }
}

async function buildRollInjectionForText(userText, chat, settings, logStatus) {
  const s = settings || ensureSettings();
  const rollTag = String(s.wiRollTag || 'SG_ROLL').trim() || 'SG_ROLL';
  if (String(userText || '').includes(rollTag)) return null;
  const source = String(s.wiRollStatSource || 'variable');
  let statData = null;
  let varSource = '';
  if (source === 'latest') {
    ({ statData } = resolveStatDataFromLatestAssistant(chat, s));
    varSource = 'latest';
  } else if (source === 'template') {
    ({ statData } = await resolveStatDataFromTemplate(s));
    varSource = 'template';
    if (!statData) {
      ({ statData } = await resolveStatDataViaSlashCommand(s));
      varSource = 'slashCommand';
    }
    if (!statData) {
      ({ statData } = resolveStatDataFromVariableStore(s));
      varSource = 'variableStore';
    }
    if (!statData) {
      ({ statData } = resolveStatDataFromLatestAssistant(chat, s));
      varSource = 'latestAssistant';
    }
  } else {
    // 默认使用综合方法（最稳定）
    const result = await resolveStatDataComprehensive(chat, s);
    statData = result.statData;
    varSource = result.source || '';
  }
  if (!statData) {
    const name = String(s.wiRollStatVarName || 'stat_data').trim() || 'stat_data';
    logStatus?.(`ROLL 未触发：未读取到变量（${name}）`, 'warn');
    return null;
  }
  if (s.wiRollDebugLog && varSource) {
    console.debug(`[StoryGuide] buildRollInjectionForText 变量读取来源: ${varSource}`);
  }

  const randomRoll = rollDice(100);
  let res = null;
  const canUseCustom = String(s.wiRollProvider || 'custom') === 'custom' && String(s.wiRollCustomEndpoint || '').trim();
  if (canUseCustom) {
    try {
      res = await computeRollDecisionViaCustom(userText, statData, s, randomRoll);
      if (res?.noRoll) {
        logStatus?.('ROLL 未触发：AI 判定无需判定', 'info');
        return null;
      }
    } catch (e) {
      console.warn('[StoryGuide] roll custom provider failed; fallback to local', e);
    }
  }
  if (!res) {
    logStatus?.('ROLL 未触发：AI 判定失败或无结果', 'warn');
    return null;
  }
  if (!res) return null;

  if (!Array.isArray(res.mods)) res.mods = [];
  res.actionLabel = res.actionLabel || res.action || '';
  res.formula = res.formula || '';
  if (!res.random) res.random = { roll: randomRoll, weight: clampFloat(s.wiRollRandomWeight, 0, 1, 0.3) };
  if (res.final == null && Number.isFinite(Number(res.base))) {
    const randWeight = Number(res.random?.weight) || clampFloat(s.wiRollRandomWeight, 0, 1, 0.3);
    const randRoll = Number(res.random?.roll) || randomRoll;
    res.final = Number(res.base) + Number(res.base) * randWeight * ((randRoll - 50) / 50);
  }
  if (res.success == null && Number.isFinite(Number(res.final)) && Number.isFinite(Number(res.threshold))) {
    res.success = Number(res.final) >= Number(res.threshold);
  }
  const summary = getRollAnalysisSummary(res);
  if (summary) {
    appendRollLog({
      ts: Date.now(),
      action: res.actionLabel || res.action,
      outcomeTier: res.outcomeTier,
      summary,
      final: res.final,
      success: res.success,
      userText: String(userText || ''),
    });
  }
  if (!res.random) res.random = { roll: randomRoll, weight: clampFloat(s.wiRollRandomWeight, 0, 1, 0.3) };
  const style = String(s.wiRollInjectStyle || 'hidden').trim() || 'hidden';
  const rollText = buildRollInjectionFromResult(res, rollTag, style);
  if (rollText) logStatus?.('ROLL 已注入：判定完成', 'ok');
  return rollText || null;
}

async function buildTriggerInjectionForText(userText, chat, settings, logStatus) {
  const s = settings || ensureSettings();
  if (!s.wiTriggerEnabled) return null;

  const startAfter = clampInt(s.wiTriggerStartAfterAssistantMessages, 0, 200000, 0);
  if (startAfter > 0) {
    const assistantFloors = computeFloorCount(chat, 'assistant');
    if (assistantFloors < startAfter) {
      logStatus?.(`索引未触发：AI 楼层不足 ${assistantFloors}/${startAfter}`, 'info');
      return null;
    }
  }

  const lookback = clampInt(s.wiTriggerLookbackMessages, 5, 120, 20);
  const tagForStrip = String(s.wiTriggerTag || 'SG_WI_TRIGGERS').trim() || 'SG_WI_TRIGGERS';
  const rollTag = String(s.wiRollTag || 'SG_ROLL').trim() || 'SG_ROLL';
  const recentText = buildRecentChatText(chat, lookback, true, [tagForStrip, rollTag]);
  if (!recentText) return null;

  const candidates = collectBlueIndexCandidates();
  if (!candidates.length) return null;

  const maxEntries = clampInt(s.wiTriggerMaxEntries, 1, 20, 4);
  const minScore = clampFloat(s.wiTriggerMinScore, 0, 1, 0.08);
  const includeUser = !!s.wiTriggerIncludeUserMessage;
  const userWeight = clampFloat(s.wiTriggerUserMessageWeight, 0, 10, 1.6);
  const matchMode = String(s.wiTriggerMatchMode || 'local');

  let picked = [];
  if (matchMode === 'llm') {
    try {
      picked = await pickRelevantIndexEntriesLLM(recentText, userText, candidates, maxEntries, includeUser, userWeight);
    } catch (e) {
      console.warn('[StoryGuide] index LLM failed; fallback to local similarity', e);
      picked = pickRelevantIndexEntries(recentText, userText, candidates, maxEntries, minScore, includeUser, userWeight);
    }
  } else {
    picked = pickRelevantIndexEntries(recentText, userText, candidates, maxEntries, minScore, includeUser, userWeight);
  }
  if (!picked.length) return null;

  const maxKeywords = clampInt(s.wiTriggerMaxKeywords, 1, 200, 24);
  const kwSet = new Set();
  const pickedNames = [];
  for (const { e } of picked) {
    const name = String(e.title || '').trim() || '条目';
    pickedNames.push(name);
    for (const k of (Array.isArray(e.keywords) ? e.keywords : [])) {
      const kk = String(k || '').trim();
      if (!kk) continue;
      kwSet.add(kk);
      if (kwSet.size >= maxKeywords) break;
    }
    if (kwSet.size >= maxKeywords) break;
  }
  const keywords = Array.from(kwSet);
  if (!keywords.length) return null;

  const style = String(s.wiTriggerInjectStyle || 'hidden').trim() || 'hidden';
  const injected = buildTriggerInjection(keywords, tagForStrip, style);
  if (injected) logStatus?.(`索引已注入：${pickedNames.slice(0, 4).join('、')}${pickedNames.length > 4 ? '…' : ''}`, 'ok');
  return injected || null;
}

function installRollPreSendHook() {
  if (window.__storyguide_roll_presend_installed) return;
  window.__storyguide_roll_presend_installed = true;
  let guard = false;
  let preSendPromise = null;

  function findTextarea() {
    return document.querySelector('#send_textarea, textarea#send_textarea, .send_textarea, textarea.send_textarea');
  }

  function findForm(textarea) {
    if (textarea && textarea.closest) {
      const f = textarea.closest('form');
      if (f) return f;
    }
    return document.getElementById('chat_input_form') || null;
  }

  function findSendButton(form) {
    if (form) {
      const btn = form.querySelector('button[type="submit"]');
      if (btn) return btn;
    }
    return document.querySelector('#send_button, #send_but, button.send_button, .send_button');
  }

  function buildPreSendLogger(s) {
    const modalOpen = $('#sg_modal_backdrop').is(':visible');
    const shouldLog = modalOpen || s.wiRollDebugLog || s.wiTriggerDebugLog;
    if (!shouldLog) return null;
    return (msg, kind = 'info') => {
      if (modalOpen) setStatus(msg, kind);
      else showToast(msg, { kind, spinner: false, sticky: false, duration: 2200 });
    };
  }

  async function applyPreSendInjectionsToText(raw, chat, s, logStatus) {
    const text = String(raw ?? '').trim();
    if (!text || text.startsWith('/')) return null;

    const rollText = s.wiRollEnabled ? await buildRollInjectionForText(text, chat, s, logStatus) : null;
    const triggerText = s.wiTriggerEnabled ? await buildTriggerInjectionForText(text, chat, s, logStatus) : null;
    if (!rollText && !triggerText) return null;

    let cleaned = stripTriggerInjection(text, String(s.wiRollTag || 'SG_ROLL').trim() || 'SG_ROLL');
    cleaned = stripTriggerInjection(cleaned, String(s.wiTriggerTag || 'SG_WI_TRIGGERS').trim() || 'SG_WI_TRIGGERS');
    return cleaned + (rollText || '') + (triggerText || '');
  }

  function findMessageArg(args) {
    if (!Array.isArray(args) || !args.length) return null;
    if (typeof args[0] === 'string') return { type: 'string', index: 0 };
    if (args[0] && typeof args[0] === 'object') {
      if (typeof args[0].mes === 'string') return { type: 'object', index: 0, key: 'mes' };
      if (typeof args[0].message === 'string') return { type: 'object', index: 0, key: 'message' };
    }
    if (typeof args[1] === 'string') return { type: 'string', index: 1 };
    return null;
  }

  async function applyPreSendInjectionsToArgs(args, chat, s, logStatus) {
    const msgArg = findMessageArg(args);
    if (!msgArg) return false;
    const raw = msgArg.type === 'string' ? args[msgArg.index] : args[msgArg.index]?.[msgArg.key];
    const injected = await applyPreSendInjectionsToText(raw, chat, s, logStatus);
    if (!injected) return false;
    if (msgArg.type === 'string') args[msgArg.index] = injected;
    else args[msgArg.index][msgArg.key] = injected;
    return true;
  }

  async function runPreSendInjections(textarea) {
    const s = ensureSettings();
    if (!s.wiRollEnabled && !s.wiTriggerEnabled) return false;
    const raw = String(textarea?.value ?? '');
    const logStatus = buildPreSendLogger(s);
    const ctx = SillyTavern.getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const injected = await applyPreSendInjectionsToText(raw, chat, s, logStatus);
    if (injected && textarea) {
      textarea.value = injected;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  async function ensurePreSend(textarea) {
    if (preSendPromise) return preSendPromise;
    preSendPromise = (async () => {
      await runPreSendInjections(textarea);
    })();
    try {
      await preSendPromise;
    } finally {
      preSendPromise = null;
    }
  }

  function triggerSend(form) {
    const btn = findSendButton(form);
    if (btn && typeof btn.click === 'function') {
      btn.click();
      return;
    }
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return;
    }
    if (form && typeof form.dispatchEvent === 'function') {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    const textarea = findTextarea();
    if (!form || !textarea || !form.contains(textarea)) return;
    if (guard) return;
    const s = ensureSettings();
    if (!s.wiRollEnabled && !s.wiTriggerEnabled) return;

    e.preventDefault();
    e.stopPropagation();
    guard = true;

    try {
      await ensurePreSend(textarea);
    } finally {
      guard = false;
      window.__storyguide_presend_guard = true;
      try {
        triggerSend(form);
      } finally {
        window.__storyguide_presend_guard = false;
      }
    }
  }, true);

  document.addEventListener('keydown', async (e) => {
    const textarea = findTextarea();
    if (!textarea || e.target !== textarea) return;
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const s = ensureSettings();
    if (!s.wiRollEnabled && !s.wiTriggerEnabled) return;
    if (guard) return;

    e.preventDefault();
    e.stopPropagation();
    guard = true;

    try {
      await ensurePreSend(textarea);
    } finally {
      guard = false;
      const form = findForm(textarea);
      window.__storyguide_presend_guard = true;
      try {
        triggerSend(form);
      } finally {
        window.__storyguide_presend_guard = false;
      }
    }
  }, true);

  async function handleSendButtonEvent(e) {
    const btn = e.target && e.target.closest
      ? e.target.closest('#send_but, #send_button, button.send_button, .send_button')
      : null;
    if (!btn) return;
    if (guard || window.__storyguide_presend_guard) return;
    const s = ensureSettings();
    if (!s.wiRollEnabled && !s.wiTriggerEnabled) return;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    guard = true;

    try {
      const textarea = findTextarea();
      if (textarea) await ensurePreSend(textarea);
    } finally {
      guard = false;
      window.__storyguide_presend_guard = true;
      try {
        if (typeof btn.click === 'function') btn.click();
      } finally {
        window.__storyguide_presend_guard = false;
      }
    }
  }

  document.addEventListener('click', handleSendButtonEvent, true);

  function wrapSendFunction(obj, key) {
    if (!obj || typeof obj[key] !== 'function' || obj[key].__sg_wrapped) return;
    const original = obj[key];
    obj[key] = async function (...args) {
      if (window.__storyguide_presend_guard) return original.apply(this, args);
      const s = ensureSettings();
      if (!s.wiRollEnabled && !s.wiTriggerEnabled) return original.apply(this, args);
      const textarea = findTextarea();
      if (textarea) {
        await ensurePreSend(textarea);
      } else {
        const logStatus = buildPreSendLogger(s);
        const ctx = SillyTavern.getContext?.() ?? {};
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        await applyPreSendInjectionsToArgs(args, chat, s, logStatus);
      }
      window.__storyguide_presend_guard = true;
      try {
        return await original.apply(this, args);
      } finally {
        window.__storyguide_presend_guard = false;
      }
    };
    obj[key].__sg_wrapped = true;
  }

  function installSendWrappers() {
    const ctx = SillyTavern.getContext?.() ?? {};
    const candidates = ['sendMessage', 'sendUserMessage', 'sendUserMessageInChat', 'submitUserMessage'];
    for (const k of candidates) wrapSendFunction(ctx, k);
    for (const k of candidates) wrapSendFunction(SillyTavern, k);
    for (const k of candidates) wrapSendFunction(globalThis, k);
  }

  installSendWrappers();
  setInterval(installSendWrappers, 2000);
}

function tokenizeForSimilarity(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Map();

  function add(tok, w = 1) {
    if (!tok) return;
    const k = String(tok).trim();
    if (!k) return;
    tokens.set(k, (tokens.get(k) || 0) + w);
  }

  // latin words
  const latin = s.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of latin) add(w, 1);

  // CJK sequences -> bigrams (better than single-char)
  const cjkSeqs = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seq of cjkSeqs) {
    // include short full seq for exact hits
    if (seq.length <= 6) add(seq, 2);
    for (let i = 0; i < seq.length - 1; i++) {
      add(seq.slice(i, i + 2), 1);
    }
  }

  return tokens;
}

function cosineSimilarity(mapA, mapB) {
  if (!mapA?.size || !mapB?.size) return 0;
  // iterate smaller
  const small = mapA.size <= mapB.size ? mapA : mapB;
  const large = mapA.size <= mapB.size ? mapB : mapA;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of mapA.values()) normA += v * v;
  for (const v of mapB.values()) normB += v * v;
  if (!normA || !normB) return 0;
  for (const [k, va] of small.entries()) {
    const vb = large.get(k);
    if (vb) dot += va * vb;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildRecentChatText(chat, lookback, excludeLast = true, stripTags = '') {
  const tags = Array.isArray(stripTags) ? stripTags : (stripTags ? [stripTags] : []);
  const msgs = [];
  const arr = Array.isArray(chat) ? chat : [];
  let i = arr.length - 1;
  if (excludeLast) i -= 1;
  for (; i >= 0 && msgs.length < lookback; i--) {
    const m = arr[i];
    if (!m) continue;
    if (m.is_system === true) continue;
    let t = stripHtml(m.mes ?? m.message ?? '');
    if (tags.length) {
      for (const tag of tags) {
        if (tag) t = stripTriggerInjection(t, tag);
      }
    }
    if (t) msgs.push(t);
  }
  return msgs.reverse().join('\n');
}

function getBlueIndexEntriesFast() {
  const s = ensureSettings();
  const mode = String(s.wiBlueIndexMode || 'live');
  if (mode !== 'live') return (Array.isArray(s.summaryBlueIndex) ? s.summaryBlueIndex : []);

  const file = pickBlueIndexFileName();
  if (!file) return (Array.isArray(s.summaryBlueIndex) ? s.summaryBlueIndex : []);

  const minSec = clampInt(s.wiBlueIndexMinRefreshSec, 5, 600, 20);
  const now = Date.now();
  const ageMs = now - Number(blueIndexLiveCache.loadedAt || 0);
  const need = (blueIndexLiveCache.file !== file) || ageMs > (minSec * 1000);

  // 注意：为了尽量不阻塞 MESSAGE_SENT（确保触发词注入在生成前完成），这里不 await。
  // 如果需要刷新，就后台拉取一次，下次消息即可使用最新索引。
  if (need) {
    ensureBlueIndexLive(false).catch(() => void 0);
  }

  const live = Array.isArray(blueIndexLiveCache.entries) ? blueIndexLiveCache.entries : [];
  if (live.length) return live;
  return (Array.isArray(s.summaryBlueIndex) ? s.summaryBlueIndex : []);
}

function collectBlueIndexCandidates() {
  const s = ensureSettings();
  const meta = getSummaryMeta();
  const out = [];
  const seen = new Set();

  const fromMeta = Array.isArray(meta?.history) ? meta.history : [];
  for (const r of fromMeta) {
    const title = String(r?.title || '').trim();
    const summary = String(r?.summary || '').trim();
    const keywords = sanitizeKeywords(r?.keywords);
    if (!summary) continue;
    const key = `${title}__${summary.slice(0, 24)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title || (keywords[0] ? `条目：${keywords[0]}` : '条目'), summary, keywords });
  }

  const fromImported = getBlueIndexEntriesFast();
  for (const r of fromImported) {
    const title = String(r?.title || '').trim();
    const summary = String(r?.summary || '').trim();
    const keywords = sanitizeKeywords(r?.keywords);
    if (!summary) continue;
    const key = `${title}__${summary.slice(0, 24)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title || (keywords[0] ? `条目：${keywords[0]}` : '条目'), summary, keywords });
  }

  return out;
}

function pickRelevantIndexEntries(recentText, userText, candidates, maxEntries, minScore, includeUser = true, userWeight = 1.0) {
  const recentVec = tokenizeForSimilarity(recentText);
  if (includeUser && userText) {
    const uvec = tokenizeForSimilarity(userText);
    const w = Number(userWeight);
    const mul = Number.isFinite(w) ? Math.max(0, Math.min(10, w)) : 1;
    for (const [k, v] of uvec.entries()) {
      recentVec.set(k, (recentVec.get(k) || 0) + v * mul);
    }
  }
  const scored = [];
  for (const e of candidates) {
    const txt = `${e.title || ''}\n${e.summary || ''}\n${(Array.isArray(e.keywords) ? e.keywords.join(' ') : '')}`;
    const vec = tokenizeForSimilarity(txt);
    const score = cosineSimilarity(recentVec, vec);
    if (score >= minScore) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxEntries);
}

function buildIndexPromptMessages(recentText, userText, candidatesForModel, maxPick) {
  const s = ensureSettings();
  const sys = String(s.wiIndexSystemPrompt || DEFAULT_INDEX_SYSTEM_PROMPT).trim() || DEFAULT_INDEX_SYSTEM_PROMPT;
  const tmpl = String(s.wiIndexUserTemplate || DEFAULT_INDEX_USER_TEMPLATE).trim() || DEFAULT_INDEX_USER_TEMPLATE;

  const candidatesJson = JSON.stringify(candidatesForModel, null, 0);

  const user = tmpl
    .replaceAll('{{userMessage}}', String(userText || ''))
    .replaceAll('{{recentText}}', String(recentText || ''))
    .replaceAll('{{candidates}}', candidatesJson)
    .replaceAll('{{maxPick}}', String(maxPick));

  const enforced = user + `

` + INDEX_JSON_REQUIREMENT.replaceAll('maxPick', String(maxPick));

  return [
    { role: 'system', content: sys },
    { role: 'user', content: enforced },
  ];
}

async function pickRelevantIndexEntriesLLM(recentText, userText, candidates, maxEntries, includeUser, userWeight) {
  const s = ensureSettings();

  const topK = clampInt(s.wiIndexPrefilterTopK, 5, 80, 24);
  const candMaxChars = clampInt(s.wiIndexCandidateMaxChars, 120, 2000, 420);

  const pre = pickRelevantIndexEntries(
    recentText,
    userText,
    candidates,
    Math.max(topK, maxEntries),
    0,
    includeUser,
    userWeight
  );

  const shortlist = (pre.length ? pre : candidates.map(e => ({ e, score: 0 }))).slice(0, topK);

  const candidatesForModel = shortlist.map((x, i) => {
    const e = x.e || x;
    const title = String(e.title || '').trim();
    const summary0 = String(e.summary || '').trim();
    const summary = summary0.length > candMaxChars ? (summary0.slice(0, candMaxChars) + '…') : summary0;
    const kws = Array.isArray(e.keywords) ? e.keywords.slice(0, 24) : [];
    return { id: i, title: title || '条目', summary, keywords: kws };
  });

  const messages = buildIndexPromptMessages(recentText, userText, candidatesForModel, maxEntries);

  let jsonText = '';
  if (String(s.wiIndexProvider || 'st') === 'custom') {
    jsonText = await callViaCustom(
      s.wiIndexCustomEndpoint,
      s.wiIndexCustomApiKey,
      s.wiIndexCustomModel,
      messages,
      clampFloat(s.wiIndexTemperature, 0, 2, 0.2),
      clampInt(s.wiIndexCustomMaxTokens, 128, 200000, 1024),
      clampFloat(s.wiIndexTopP, 0, 1, 0.95),
      !!s.wiIndexCustomStream
    );
    const parsedTry = safeJsonParse(jsonText);
    if (!parsedTry || !Array.isArray(parsedTry?.pickedIds)) {
      try {
        jsonText = await fallbackAskJsonCustom(
          s.wiIndexCustomEndpoint,
          s.wiIndexCustomApiKey,
          s.wiIndexCustomModel,
          messages,
          clampFloat(s.wiIndexTemperature, 0, 2, 0.2),
          clampInt(s.wiIndexCustomMaxTokens, 128, 200000, 1024),
          clampFloat(s.wiIndexTopP, 0, 1, 0.95),
          !!s.wiIndexCustomStream
        );
      } catch { /* ignore */ }
    }
  } else {
    const schema = {
      type: 'object',
      properties: { pickedIds: { type: 'array', items: { type: 'integer' } } },
      required: ['pickedIds'],
    };
    jsonText = await callViaSillyTavern(messages, schema, clampFloat(s.wiIndexTemperature, 0, 2, 0.2));
    if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
    const parsedTry = safeJsonParse(jsonText);
    if (!parsedTry || !Array.isArray(parsedTry?.pickedIds)) {
      jsonText = await fallbackAskJson(messages, clampFloat(s.wiIndexTemperature, 0, 2, 0.2));
    }
  }

  const parsed = safeJsonParse(jsonText);
  const pickedIds = Array.isArray(parsed?.pickedIds) ? parsed.pickedIds : [];
  const uniq = Array.from(new Set(pickedIds.map(x => Number(x)).filter(n => Number.isFinite(n))));

  const picked = [];
  for (const id of uniq) {
    const origin = shortlist[id]?.e || null;
    if (origin) picked.push({ e: origin, score: Number(shortlist[id]?.score || 0) });
    if (picked.length >= maxEntries) break;
  }
  return picked;
}


async function maybeInjectWorldInfoTriggers(reason = 'msg_sent') {
  const s = ensureSettings();
  if (!s.wiTriggerEnabled) return;

  const ctx = SillyTavern.getContext();
  const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
  if (!chat.length) return;

  const last = chat[chat.length - 1];
  if (!last || last.is_user !== true) return; // only on user send
  const lastText = String(last.mes ?? last.message ?? '').trim();
  if (!lastText || lastText.startsWith('/')) return;
  if (lastText.includes(String(s.wiTriggerTag || 'SG_WI_TRIGGERS'))) return;

  // 仅在达到指定 AI 楼层后才开始索引触发（避免前期噪声/浪费）
  const startAfter = clampInt(s.wiTriggerStartAfterAssistantMessages, 0, 200000, 0);
  if (startAfter > 0) {
    const assistantFloors = computeFloorCount(chat, 'assistant');
    if (assistantFloors < startAfter) {
      // log (optional)
      appendWiTriggerLog({
        ts: Date.now(),
        reason: String(reason || 'msg_sent'),
        userText: lastText,
        skipped: true,
        skippedReason: 'minAssistantFloors',
        assistantFloors,
        startAfter,
      });
      const modalOpen = $('#sg_modal_backdrop').is(':visible');
      if (modalOpen || s.wiTriggerDebugLog) {
        setStatus(`索引未启动：AI 回复楼层 ${assistantFloors}/${startAfter}`, 'info');
      }
      return;
    }
  }

  const lookback = clampInt(s.wiTriggerLookbackMessages, 5, 120, 20);
  // 最近正文（不含本次用户输入）；为避免“触发词注入”污染相似度，先剔除同 tag 的注入片段。
  const tagForStrip = String(s.wiTriggerTag || 'SG_WI_TRIGGERS').trim() || 'SG_WI_TRIGGERS';
  lastText = stripTriggerInjection(lastText, tagForStrip);
  const recentText = buildRecentChatText(chat, lookback, true, [tagForStrip, rollTag]);
  if (!recentText) return;

  const candidates = collectBlueIndexCandidates();
  if (!candidates.length) return;

  const maxEntries = clampInt(s.wiTriggerMaxEntries, 1, 20, 4);
  const minScore = clampFloat(s.wiTriggerMinScore, 0, 1, 0.08);
  const includeUser = !!s.wiTriggerIncludeUserMessage;
  const userWeight = clampFloat(s.wiTriggerUserMessageWeight, 0, 10, 1.6);
  const matchMode = String(s.wiTriggerMatchMode || 'local');
  let picked = [];
  if (matchMode === 'llm') {
    try {
      picked = await pickRelevantIndexEntriesLLM(recentText, lastText, candidates, maxEntries, includeUser, userWeight);
    } catch (e) {
      console.warn('[StoryGuide] index LLM failed; fallback to local similarity', e);
      picked = pickRelevantIndexEntries(recentText, lastText, candidates, maxEntries, minScore, includeUser, userWeight);
    }
  } else {
    picked = pickRelevantIndexEntries(recentText, lastText, candidates, maxEntries, minScore, includeUser, userWeight);
  }
  if (!picked.length) return;

  const maxKeywords = clampInt(s.wiTriggerMaxKeywords, 1, 200, 24);
  const kwSet = new Set();
  const pickedTitles = []; // debug display with score
  const pickedNames = [];  // entry names (等价于将触发的绿灯条目名称)
  const pickedForLog = [];
  for (const { e, score } of picked) {
    const name = String(e.title || '').trim() || '条目';
    pickedNames.push(name);
    pickedTitles.push(`${name}（${score.toFixed(2)}）`);
    pickedForLog.push({
      title: name,
      score: Number(score),
      keywordsPreview: (Array.isArray(e.keywords) ? e.keywords.slice(0, 24) : []),
    });
    for (const k of (Array.isArray(e.keywords) ? e.keywords : [])) {
      const kk = String(k || '').trim();
      if (!kk) continue;
      kwSet.add(kk);
      if (kwSet.size >= maxKeywords) break;
    }
    if (kwSet.size >= maxKeywords) break;
  }
  const keywords = Array.from(kwSet);
  if (!keywords.length) return;

  const tag = tagForStrip;
  const style = String(s.wiTriggerInjectStyle || 'hidden').trim() || 'hidden';
  const cleaned = stripTriggerInjection(last.mes ?? last.message ?? '', tag);
  const injected = cleaned + buildTriggerInjection(keywords, tag, style);
  last.mes = injected;

  // append log (fire-and-forget)
  appendWiTriggerLog({
    ts: Date.now(),
    reason: String(reason || 'msg_sent'),
    userText: lastText,
    lookback,
    style,
    tag,
    picked: pickedForLog,
    injectedKeywords: keywords,
  });

  // try save
  try {
    if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
    else if (typeof ctx.saveChat === 'function') ctx.saveChat();
  } catch { /* ignore */ }

  // debug status (only when pane open or explicitly enabled)
  const modalOpen = $('#sg_modal_backdrop').is(':visible');
  if (modalOpen || s.wiTriggerDebugLog) {
    setStatus(`已注入触发词：${keywords.slice(0, 12).join('、')}${keywords.length > 12 ? '…' : ''}${s.wiTriggerDebugLog ? `｜命中：${pickedTitles.join('；')}` : `｜将触发：${pickedNames.slice(0, 4).join('；')}${pickedNames.length > 4 ? '…' : ''}`}`, 'ok');
  }
}

// -------------------- inline append (dynamic modules) --------------------

function indentForListItem(md) {
  const s = String(md || '');
  const pad = '    '; // 4 spaces to ensure nested blocks stay inside the module card
  if (!s) return pad + '（空）';
  return s.split('\n').map(line => pad + line).join('\n');
}

function normalizeNumberedHints(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const t = String(arr[i] ?? '').trim();
    if (!t) continue;
    // If the item already starts with 【n】, keep it; else prefix with 【i+1】
    if (/^【\d+】/.test(t)) out.push(t);
    else out.push(`【${i + 1}】 ${t}`);
  }
  return out;
}

function buildInlineMarkdownFromModules(parsedJson, modules, mode, showEmpty) {
  // mode: compact|standard
  const lines = [];
  lines.push(`**剧情指导**`);

  for (const m of modules) {
    // quick_actions 模块不在 Markdown 中渲染，而是单独渲染为可点击按钮
    if (m.key === 'quick_actions') continue;

    const hasKey = parsedJson && Object.hasOwn(parsedJson, m.key);
    const val = hasKey ? parsedJson[m.key] : undefined;
    const title = m.title || m.key;

    if (m.type === 'list') {
      const arr = Array.isArray(val) ? val : [];
      if (!arr.length) {
        if (showEmpty) lines.push(`- **${title}**\n${indentForListItem('（空）')}`);
        continue;
      }

      if (mode === 'compact') {
        const limit = Math.min(arr.length, 3);
        const picked = arr.slice(0, limit).map(x => String(x ?? '').trim()).filter(Boolean);
        lines.push(`- **${title}**
${indentForListItem(picked.join(' / '))}`);
      } else {
        // 标准模式：把整个列表合并到同一个模块卡片内（以【1】等为分隔提示）
        const normalized = normalizeNumberedHints(arr);
        const joined = normalized.join('\n\n');
        lines.push(`- **${title}**\n${indentForListItem(joined)}`);
      }
    } else {
      const text = (val !== undefined && val !== null) ? String(val).trim() : '';
      if (!text) {
        if (showEmpty) lines.push(`- **${title}**\n${indentForListItem('（空）')}`);
        continue;
      }

      if (mode === 'compact') {
        const short = (text.length > 140 ? text.slice(0, 140) + '…' : text);
        lines.push(`- **${title}**
${indentForListItem(short)}`);
      } else {
        // 标准模式：把内容缩进到 list item 内，避免内部列表/编号变成“同级卡片”
        lines.push(`- **${title}**\n${indentForListItem(text)}`);
      }
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

  const bind = (el, isFooter = false) => {
    if (!el) return;
    const flag = isFooter ? 'sgBoundFoot' : 'sgBound';
    if (el.dataset[flag] === '1') return;
    el.dataset[flag] = '1';

    el.addEventListener('click', (e) => {
      if (e.target && (e.target.closest('a'))) return;

      const cur = boxEl.classList.contains('collapsed');
      const next = !cur;
      setCollapsed(boxEl, next);

      const cached = inlineCache.get(String(mesKey));
      if (cached) {
        cached.collapsed = next;
        inlineCache.set(String(mesKey), cached);
      }

      // Footer button: collapse then scroll back to the message正文
      if (isFooter && next) {
        const mesEl = boxEl.closest('.mes');
        (mesEl || boxEl).scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  };

  bind(boxEl.querySelector('.sg-inline-head'), false);
  bind(boxEl.querySelector('.sg-inline-foot'), true);
}


function createInlineBoxElement(mesKey, htmlInner, collapsed, quickActions) {
  const box = document.createElement('div');
  box.className = 'sg-inline-box';
  box.dataset.sgMesKey = String(mesKey);

  // 只渲染AI生成的动态选项（不再使用静态配置的选项）
  let quickOptionsHtml = '';
  if (Array.isArray(quickActions) && quickActions.length) {
    quickOptionsHtml = renderDynamicQuickActionsHtml(quickActions, 'inline');
  }

  box.innerHTML = `
    <div class="sg-inline-head" title="点击折叠/展开（不会自动生成）">
      <span class="sg-inline-badge">📘</span>
      <span class="sg-inline-title">剧情指导</span>
      <span class="sg-inline-sub">（剧情分析）</span>
      <span class="sg-inline-chevron">▾</span>
    </div>
    <div class="sg-inline-body">${htmlInner}</div>
    ${quickOptionsHtml}
    <div class="sg-inline-foot" title="点击折叠并回到正文">
      <span class="sg-inline-foot-icon">▴</span>
      <span class="sg-inline-foot-text">收起并回到正文</span>
      <span class="sg-inline-foot-icon">▴</span>
    </div>`.trim();

  setCollapsed(box, !!collapsed);
  attachToggleHandler(box, mesKey);
  return box;
}



function attachPanelToggleHandler(boxEl, mesKey) {
  if (!boxEl) return;

  const bind = (el, isFooter = false) => {
    if (!el) return;
    const flag = isFooter ? 'sgBoundFoot' : 'sgBound';
    if (el.dataset[flag] === '1') return;
    el.dataset[flag] = '1';

    el.addEventListener('click', (e) => {
      if (e.target && (e.target.closest('a'))) return;

      const cur = boxEl.classList.contains('collapsed');
      const next = !cur;
      setCollapsed(boxEl, next);

      const cached = panelCache.get(String(mesKey));
      if (cached) {
        cached.collapsed = next;
        panelCache.set(String(mesKey), cached);
      }

      if (isFooter && next) {
        const mesEl = boxEl.closest('.mes');
        (mesEl || boxEl).scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  };

  bind(boxEl.querySelector('.sg-panel-head'), false);
  bind(boxEl.querySelector('.sg-panel-foot'), true);
}


function createPanelBoxElement(mesKey, htmlInner, collapsed) {
  const box = document.createElement('div');
  box.className = 'sg-panel-box';
  box.dataset.sgMesKey = String(mesKey);

  // panel 模式暂不显示快捷选项（只在 inline 模式显示）
  const quickOptionsHtml = '';

  box.innerHTML = `
    <div class="sg-panel-head" title="点击折叠/展开（面板分析结果）">
      <span class="sg-inline-badge">🧭</span>
      <span class="sg-inline-title">剧情指导</span>
      <span class="sg-inline-sub">（面板报告）</span>
      <span class="sg-inline-chevron">▾</span>
    </div>
    <div class="sg-panel-body">${htmlInner}</div>
    ${quickOptionsHtml}
    <div class="sg-panel-foot" title="点击折叠并回到正文">
      <span class="sg-inline-foot-icon">▴</span>
      <span class="sg-inline-foot-text">收起并回到正文</span>
      <span class="sg-inline-foot-icon">▴</span>
    </div>`.trim();

  setCollapsed(box, !!collapsed);
  attachPanelToggleHandler(box, mesKey);
  return box;
}

function ensurePanelBoxPresent(mesKey) {
  const cached = panelCache.get(String(mesKey));
  if (!cached) return false;

  const mesEl = findMesElementByKey(mesKey);
  if (!mesEl) return false;

  const textEl = mesEl.querySelector('.mes_text');
  if (!textEl) return false;

  const existing = textEl.querySelector('.sg-panel-box');
  if (existing) {
    setCollapsed(existing, !!cached.collapsed);
    attachPanelToggleHandler(existing, mesKey);
    const body = existing.querySelector('.sg-panel-body');
    if (body && cached.htmlInner && body.innerHTML !== cached.htmlInner) body.innerHTML = cached.htmlInner;
    return true;
  }

  const box = createPanelBoxElement(mesKey, cached.htmlInner, cached.collapsed);
  textEl.appendChild(box);
  return true;
}


function syncPanelOutputToChat(markdownOrText, asCodeBlock = false) {
  const ref = getLastAssistantMessageRef();
  if (!ref) return false;

  const mesKey = ref.mesKey;

  let md = String(markdownOrText || '').trim();
  if (!md) return false;

  if (asCodeBlock) {
    // show raw output safely
    md = '```text\n' + md + '\n```';
  }

  const htmlInner = renderMarkdownToHtml(md);
  panelCache.set(String(mesKey), { htmlInner, collapsed: false, createdAt: Date.now() });

  requestAnimationFrame(() => { ensurePanelBoxPresent(mesKey); });

  // anti-overwrite reapply (same idea as inline)
  setTimeout(() => ensurePanelBoxPresent(mesKey), 800);
  setTimeout(() => ensurePanelBoxPresent(mesKey), 1800);
  setTimeout(() => ensurePanelBoxPresent(mesKey), 3500);
  setTimeout(() => ensurePanelBoxPresent(mesKey), 6500);

  return true;
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
    // 更新动态选项（如果有变化）
    const optionsContainer = existing.querySelector('.sg-dynamic-options');
    if (!optionsContainer && Array.isArray(cached.quickActions) && cached.quickActions.length) {
      const newOptionsHtml = renderDynamicQuickActionsHtml(cached.quickActions, 'inline');
      existing.querySelector('.sg-inline-body')?.insertAdjacentHTML('afterend', newOptionsHtml);
    }
    return true;
  }

  const box = createInlineBoxElement(mesKey, cached.htmlInner, cached.collapsed, cached.quickActions);
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
  if (!s.enabled) return;
  for (const [mesKey] of inlineCache.entries()) {
    ensureInlineBoxPresent(mesKey);
  }
  for (const [mesKey] of panelCache.entries()) {
    ensurePanelBoxPresent(mesKey);
  }
}

// -------------------- inline append generate & cache --------------------

async function runInlineAppendForLastMessage(opts = {}) {
  const s = ensureSettings();
  const force = !!opts.force;
  const allow = !!opts.allowWhenDisabled;
  if (!s.enabled) return;
  // 手动按钮允许在关闭“自动追加”时也生成
  if (!s.autoAppendBox && !allow) return;

  const ref = getLastAssistantMessageRef();
  if (!ref) return;

  const { mesKey } = ref;

  if (force) {
    inlineCache.delete(String(mesKey));
  }

  // 如果已经缓存过：非强制则只补贴一次；强制则重新请求
  if (inlineCache.has(String(mesKey)) && !force) {
    ensureInlineBoxPresent(mesKey);
    return;
  }

    try {
      const { snapshotText } = buildSnapshot();

      const modules = getModules('append');
      // append 里 schema 按 inline 模块生成；如果用户把 inline 全关了，就不生成
      if (!modules.length) return;

      await updateMapFromSnapshot(snapshotText);

      // 对 “compact/standard” 给一点暗示（不强制），避免用户模块 prompt 很长时没起作用
      const modeHint = (s.appendMode === 'standard')
        ? `\n【附加要求】inline 输出可比面板更短，但不要丢掉关键信息。\n`
        : `\n【附加要求】inline 输出尽量短：每个字段尽量 1~2 句/2 条以内。\n`;

    const schema = buildSchemaFromModules(modules);
    const messages = buildPromptMessages(snapshotText + modeHint, s.spoilerLevel, modules, 'append');

    let jsonText = '';
    if (s.provider === 'custom') {
      jsonText = await callViaCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, s.customMaxTokens, s.customTopP, s.customStream);
      const parsedTry = safeJsonParse(jsonText);
      if (!parsedTry || !hasAnyModuleKey(parsedTry, modules)) {
        try { jsonText = await fallbackAskJsonCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, s.customMaxTokens, s.customTopP, s.customStream); }
        catch { /* ignore */ }
      }
    } else {
      jsonText = await callViaSillyTavern(messages, schema, s.temperature);
      if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
      const parsedTry = safeJsonParse(jsonText);
      if (!parsedTry || Object.keys(parsedTry).length === 0) jsonText = await fallbackAskJson(messages, s.temperature);
    }

    const parsed = safeJsonParse(jsonText);
    if (!parsed) {
      // 解析失败：也把原文追加到聊天末尾，避免“有输出但看不到”
      const raw = String(jsonText || '').trim();
      const rawMd = raw ? ('```text\n' + raw + '\n```') : '（空）';
      const mdFail = `**剧情指导（解析失败）**\n\n${rawMd}`;
      const htmlInnerFail = renderMarkdownToHtml(mdFail);

      inlineCache.set(String(mesKey), { htmlInner: htmlInnerFail, collapsed: false, createdAt: Date.now() });
      requestAnimationFrame(() => { ensureInlineBoxPresent(mesKey); });
      setTimeout(() => ensureInlineBoxPresent(mesKey), 800);
      setTimeout(() => ensureInlineBoxPresent(mesKey), 1800);
      setTimeout(() => ensureInlineBoxPresent(mesKey), 3500);
      setTimeout(() => ensureInlineBoxPresent(mesKey), 6500);
      return;
    }

    // 合并静态模块缓存（使用之前缓存的静态模块值）
    const mergedParsed = mergeStaticModulesIntoResult(parsed, modules);

    // 更新静态模块缓存（首次生成的静态模块会被缓存）
    updateStaticModulesCache(mergedParsed, modules).catch(() => void 0);

    const md = buildInlineMarkdownFromModules(mergedParsed, modules, s.appendMode, !!s.inlineShowEmpty);
    const htmlInner = renderMarkdownToHtml(md);

    // 提取 quick_actions 用于动态渲染可点击按钮
    const quickActions = Array.isArray(mergedParsed.quick_actions) ? mergedParsed.quick_actions : [];

    inlineCache.set(String(mesKey), { htmlInner, collapsed: false, createdAt: Date.now(), quickActions });

    requestAnimationFrame(() => { ensureInlineBoxPresent(mesKey); });

    // 额外补贴：对付“变量更新晚到”的二次覆盖
    setTimeout(() => ensureInlineBoxPresent(mesKey), 800);
    setTimeout(() => ensureInlineBoxPresent(mesKey), 1800);
    setTimeout(() => ensureInlineBoxPresent(mesKey), 3500);
    setTimeout(() => ensureInlineBoxPresent(mesKey), 6500);
  } catch (e) {
    console.warn('[StoryGuide] inline append failed:', e);
  }
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


function fillSummaryModelSelect(modelIds, selected) {
  const $sel = $('#sg_summaryModelSelect');
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


function fillIndexModelSelect(modelIds, selected) {
  const $sel = $('#sg_wiIndexModelSelect');
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


async function refreshSummaryModels() {
  const s = ensureSettings();
  const raw = String($('#sg_summaryCustomEndpoint').val() || s.summaryCustomEndpoint || '').trim();
  const apiBase = normalizeBaseUrl(raw);
  if (!apiBase) { setStatus('请先填写“总结独立API基础URL”再刷新模型', 'warn'); return; }

  setStatus('正在刷新“总结独立API”模型列表…', 'warn');

  const apiKey = String($('#sg_summaryCustomApiKey').val() || s.summaryCustomApiKey || '');
  const statusUrl = '/api/backends/chat-completions/status';

  const body = {
    reverse_proxy: apiBase,
    chat_completion_source: 'custom',
    custom_url: apiBase,
    custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : ''
  };

  // prefer backend status (兼容 ST 后端代理)
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

    ids = Array.from(new Set(ids)).sort((a, b) => String(a).localeCompare(String(b)));

    if (!ids.length) {
      setStatus('刷新成功，但未解析到模型列表（返回格式不兼容）', 'warn');
      return;
    }

    s.summaryCustomModelsCache = ids;
    saveSettings();
    fillSummaryModelSelect(ids, s.summaryCustomModel);
    setStatus(`已刷新总结模型：${ids.length} 个（后端代理）`, 'ok');
    return;
  } catch (e) {
    const status = e?.status;
    if (!(status === 404 || status === 405)) console.warn('[StoryGuide] summary status check failed; fallback to direct /models', e);
  }

  // fallback direct /models
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

    ids = Array.from(new Set(ids)).sort((a, b) => String(a).localeCompare(String(b)));

    if (!ids.length) { setStatus('直连刷新失败：未解析到模型列表', 'warn'); return; }

    s.summaryCustomModelsCache = ids;
    saveSettings();
    fillSummaryModelSelect(ids, s.summaryCustomModel);
    setStatus(`已刷新总结模型：${ids.length} 个（直连 fallback）`, 'ok');
  } catch (e) {
    setStatus(`刷新总结模型失败：${e?.message ?? e}`, 'err');
  }
}


async function refreshIndexModels() {
  const s = ensureSettings();
  const raw = String($('#sg_wiIndexCustomEndpoint').val() || s.wiIndexCustomEndpoint || '').trim();
  const apiBase = normalizeBaseUrl(raw);
  if (!apiBase) { setStatus('请先填写“索引独立API基础URL”再刷新模型', 'warn'); return; }

  setStatus('正在刷新“索引独立API”模型列表…', 'warn');

  const apiKey = String($('#sg_wiIndexCustomApiKey').val() || s.wiIndexCustomApiKey || '');
  const statusUrl = '/api/backends/chat-completions/status';

  const body = {
    reverse_proxy: apiBase,
    chat_completion_source: 'custom',
    custom_url: apiBase,
    custom_include_headers: apiKey ? `Authorization: Bearer ${apiKey}` : ''
  };

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

    ids = Array.from(new Set(ids)).sort((a, b) => String(a).localeCompare(String(b)));

    if (!ids.length) {
      setStatus('刷新成功，但未解析到模型列表（返回格式不兼容）', 'warn');
      return;
    }

    s.wiIndexCustomModelsCache = ids;
    saveSettings();
    fillIndexModelSelect(ids, s.wiIndexCustomModel);
    setStatus(`已刷新索引模型：${ids.length} 个（后端代理）`, 'ok');
    return;
  } catch (e) {
    const status = e?.status;
    if (!(status === 404 || status === 405)) console.warn('[StoryGuide] index status check failed; fallback to direct /models', e);
  }

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

    ids = Array.from(new Set(ids)).sort((a, b) => String(a).localeCompare(String(b)));

    if (!ids.length) { setStatus('直连刷新失败：未解析到模型列表', 'warn'); return; }

    s.wiIndexCustomModelsCache = ids;
    saveSettings();
    fillIndexModelSelect(ids, s.wiIndexCustomModel);
    setStatus(`已刷新索引模型：${ids.length} 个（直连 fallback）`, 'ok');
  } catch (e) {
    setStatus(`刷新索引模型失败：${e?.message ?? e}`, 'err');
  }
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

    ids = Array.from(new Set(ids)).sort((a, b) => String(a).localeCompare(String(b)));

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

    ids = Array.from(new Set(ids)).sort((a, b) => String(a).localeCompare(String(b)));

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


function findChatInputAnchor() {
  // Prefer send button as anchor
  const sendBtn =
    document.querySelector('#send_but') ||
    document.querySelector('#send_button') ||
    document.querySelector('button#send') ||
    document.querySelector('button[title*="Send"]') ||
    document.querySelector('button[aria-label*="Send"]') ||
    document.querySelector('button.menu_button#send_but') ||
    document.querySelector('.send_button') ||
    document.querySelector('button[type="submit"]');

  if (sendBtn) return sendBtn;

  // Fallback: textarea container
  const ta =
    document.querySelector('#send_textarea') ||
    document.querySelector('textarea[name="message"]') ||
    document.querySelector('textarea');

  return ta;
}

const SG_CHAT_POS_KEY = 'storyguide_chat_controls_pos_v1';
let sgChatPinnedLoaded = false;
let sgChatPinnedPos = null; // {left, top, pinned}
let sgChatPinned = false;

function loadPinnedChatPos() {
  if (sgChatPinnedLoaded) return;
  sgChatPinnedLoaded = true;
  try {
    const raw = localStorage.getItem(SG_CHAT_POS_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (j && typeof j.left === 'number' && typeof j.top === 'number') {
      sgChatPinnedPos = { left: j.left, top: j.top, pinned: j.pinned !== false };
      sgChatPinned = sgChatPinnedPos.pinned;
    }
  } catch { /* ignore */ }
}

function savePinnedChatPos(left, top) {
  try {
    sgChatPinnedPos = { left: Number(left) || 0, top: Number(top) || 0, pinned: true };
    sgChatPinned = true;
    localStorage.setItem(SG_CHAT_POS_KEY, JSON.stringify(sgChatPinnedPos));
  } catch { /* ignore */ }
}

function clearPinnedChatPos() {
  try {
    sgChatPinnedPos = null;
    sgChatPinned = false;
    localStorage.removeItem(SG_CHAT_POS_KEY);
  } catch { /* ignore */ }
}

const SG_FLOATING_POS_KEY = 'storyguide_floating_panel_pos_v1';
let sgFloatingPinnedLoaded = false;
let sgFloatingPinnedPos = null;

function loadFloatingPanelPos() {
  if (sgFloatingPinnedLoaded) return;
  sgFloatingPinnedLoaded = true;
  try {
    const raw = localStorage.getItem(SG_FLOATING_POS_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (j && typeof j.left === 'number' && typeof j.top === 'number') {
      sgFloatingPinnedPos = { left: j.left, top: j.top };
    }
  } catch { /* ignore */ }
}

function saveFloatingPanelPos(left, top) {
  try {
    sgFloatingPinnedPos = { left: Number(left) || 0, top: Number(top) || 0 };
    localStorage.setItem(SG_FLOATING_POS_KEY, JSON.stringify(sgFloatingPinnedPos));
  } catch { /* ignore */ }
}

function clearFloatingPanelPos() {
  try {
    sgFloatingPinnedPos = null;
    localStorage.removeItem(SG_FLOATING_POS_KEY);
  } catch { /* ignore */ }
}

function clampToViewport(left, top, w, h) {
  // 放宽边界限制：允许窗口越界 50%（即至少保留 50% 或标题栏 40px 可见）
  const minVisibleRatio = 0.5; // 至少 50% 可见（允许另外 50% 在屏幕外）
  const minVisiblePx = 40;     // 或至少 40px（保证标题栏可拖回）

  // 计算水平方向需要保持可见的最小宽度
  const minVisibleW = Math.max(minVisiblePx, w * minVisibleRatio);
  // 计算垂直方向需要保持可见的最小高度
  const minVisibleH = Math.max(minVisiblePx, h * minVisibleRatio);

  // 左边界：允许负值，但确保右侧至少 minVisibleW 在屏幕内
  // 即 left + w >= minVisibleW → left >= minVisibleW - w
  const minLeft = minVisibleW - w;
  // 右边界：确保左侧至少 minVisibleW 在屏幕内
  // 即 left + minVisibleW <= window.innerWidth → left <= window.innerWidth - minVisibleW
  const maxLeft = window.innerWidth - minVisibleW;

  // 上边界：严格限制 >= 0，保证标题栏不被遮挡
  const minTop = 0;
  // 下边界：确保顶部至少 minVisibleH 在屏幕内
  const maxTop = window.innerHeight - minVisibleH;

  const L = Math.max(minLeft, Math.min(left, maxLeft));
  const T = Math.max(minTop, Math.min(top, maxTop));
  return { left: L, top: T };
}

function measureWrap(wrap) {
  const prevVis = wrap.style.visibility;
  wrap.style.visibility = 'hidden';
  wrap.style.left = '0px';
  wrap.style.top = '0px';
  const w = wrap.offsetWidth || 220;
  const h = wrap.offsetHeight || 38;
  wrap.style.visibility = prevVis || 'visible';
  return { w, h };
}

function positionChatActionButtons() {
  const wrap = document.getElementById('sg_chat_controls');
  if (!wrap) return;

  loadPinnedChatPos();

  const { w, h } = measureWrap(wrap);

  // If user dragged & pinned position, keep it.
  if (sgChatPinned && sgChatPinnedPos) {
    const clamped = clampToViewport(sgChatPinnedPos.left, sgChatPinnedPos.top, w, h);
    wrap.style.left = `${Math.round(clamped.left)}px`;
    wrap.style.top = `${Math.round(clamped.top)}px`;
    return;
  }

  const sendBtn =
    document.querySelector('#send_but') ||
    document.querySelector('#send_button') ||
    document.querySelector('button#send') ||
    document.querySelector('button[title*="Send"]') ||
    document.querySelector('button[aria-label*="Send"]') ||
    document.querySelector('.send_button') ||
    document.querySelector('button[type="submit"]');

  if (!sendBtn) return;

  const rect = sendBtn.getBoundingClientRect();

  // place to the left of send button, vertically centered
  let left = rect.left - w - 10;
  let top = rect.top + (rect.height - h) / 2;

  const clamped = clampToViewport(left, top, w, h);
  wrap.style.left = `${Math.round(clamped.left)}px`;
  wrap.style.top = `${Math.round(clamped.top)}px`;
}

let sgChatPosTimer = null;
function schedulePositionChatButtons() {
  if (sgChatPosTimer) return;
  sgChatPosTimer = setTimeout(() => {
    sgChatPosTimer = null;
    try { positionChatActionButtons(); } catch { }
  }, 60);
}

// Removed: ensureChatActionButtons feature (Generate/Reroll buttons near input)
function ensureChatActionButtons() {
  // Feature disabled/removed as per user request.
  const el = document.getElementById('sg_chat_controls');
  if (el) el.remove();
}


// -------------------- card toggle (shrink/expand per module card) --------------------
function clearLegacyZoomArtifacts() {
  try {
    document.body.classList.remove('sg-zoom-lock');
    document.querySelectorAll('.sg-zoomed').forEach(el => el.classList.remove('sg-zoomed'));
    const ov = document.getElementById('sg_zoom_overlay');
    if (ov) ov.remove();
  } catch { /* ignore */ }
}

function installCardZoomDelegation() {
  if (window.__storyguide_card_toggle_installed) return;
  window.__storyguide_card_toggle_installed = true;

  clearLegacyZoomArtifacts();

  document.addEventListener('click', (e) => {
    const target = e.target;
    // don't hijack interactive elements
    if (target.closest('a, button, input, textarea, select, label')) return;

    // Handle Title Click -> Collapse Section
    // Target headers h1-h6 inside floating or inline body
    // We strictly look for headers that are direct children or wrapped in simple divs of the body
    const header = target.closest('.sg-floating-body h1, .sg-floating-body h2, .sg-floating-body h3, .sg-floating-body h4, .sg-floating-body h5, .sg-floating-body h6, .sg-inline-body h1, .sg-inline-body h2, .sg-inline-body h3, .sg-inline-body h4, .sg-inline-body h5, .sg-inline-body h6');

    if (header) {
      e.preventDefault();
      e.stopPropagation();

      // Find the next sibling that is usually the content (ul, p, or div)
      let next = header.nextElementSibling;
      let handled = false;

      // Toggle class on header for styling (arrow)
      header.classList.toggle('sg-section-collapsed');

      while (next) {
        // Stop if we hit another header of same or higher level, or if end of container
        const tag = next.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;

        // Toggle visibility
        if (next.style.display === 'none') {
          next.style.display = '';
        } else {
          next.style.display = 'none';
        }

        next = next.nextElementSibling;
        handled = true;
      }
      return;
    }

    // Fallback: If inline cards still need collapsing (optional, keeping for compatibility if user wants inline msg boxes to toggle)
    const card = target.closest('.sg-inline-body > ul > li');
    if (card) {
      // Check selection
      try {
        const sel = window.getSelection();
        if (sel && String(sel).trim().length > 0) return;
      } catch { /* ignore */ }

      e.preventDefault();
      e.stopPropagation();
      card.classList.toggle('sg-collapsed');
    }
  }, true);
}



function buildModalHtml() {
  return `
  <div id="sg_modal_backdrop" class="sg-backdrop" style="display:none;">
    <div id="sg_modal" class="sg-modal" role="dialog" aria-modal="true">
      <div class="sg-modal-head">
        <div class="sg-modal-title">
          <span class="sg-badge">📘</span>
          剧情指导 <span class="sg-sub">StoryGuide v${SG_VERSION}</span>
        </div>
        <div class="sg-modal-actions">
          <button class="menu_button sg-btn" id="sg_close">关闭</button>
        </div>
      </div>

      <div class="sg-modal-body">
        <div class="sg-left">
          <div class="sg-pagetabs">
            <button class="sg-pgtab active" id="sg_pgtab_guide">剧情指导</button>
            <button class="sg-pgtab" id="sg_pgtab_summary">总结设置</button>
            <button class="sg-pgtab" id="sg_pgtab_index">索引设置</button>
            <button class="sg-pgtab" id="sg_pgtab_roll">ROLL 设置</button>
          </div>

          <div class="sg-page active" id="sg_page_guide">
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
              <label class="sg-check"><input type="checkbox" id="sg_autoAppendBox">启用分析框（手动生成/重Roll）</label>
              <select id="sg_appendMode">
                <option value="compact">简洁</option>
                <option value="standard">标准</option>
              </select>
              <select id="sg_inlineModulesSource" title="选择追加框展示的模块来源">
                <option value="inline">仅 inline=true 的模块</option>
                <option value="panel">跟随面板（panel=true）</option>
                <option value="all">显示全部模块</option>
              </select>
              <label class="sg-check" title="即使模型没输出该字段，也显示（空）占位">
                <input type="checkbox" id="sg_inlineShowEmpty">显示空字段
              </label>
              <span class="sg-hint">（点击框标题可折叠）</span>
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

              <div class="sg-row">
                <div class="sg-field sg-field-full">
                  <label>最大回复token数</label>
                  <input id="sg_customMaxTokens" type="number" min="256" max="200000" step="1" placeholder="例如：60000">
                
                  <label class="sg-check" style="margin-top:8px;">
                    <input type="checkbox" id="sg_customStream"> 使用流式返回（stream=true）
                  </label>
</div>
              </div>
            </div>

            <div class="sg-actions-row">
              <button class="menu_button sg-btn-primary" id="sg_saveSettings">保存设置</button>
              <button class="menu_button sg-btn-primary" id="sg_analyze">分析当前剧情</button>
            </div>
            <div class="sg-actions-row" style="margin-top: 8px;">
              <button class="menu_button sg-btn" id="sg_exportPreset">📤 导出全局预设</button>
              <button class="menu_button sg-btn" id="sg_importPreset">📥 导入全局预设</button>
              <input type="file" id="sg_importPresetFile" accept=".json" style="display: none;">
            </div>
          </div>

          <div class="sg-card">
            <div class="sg-card-title">快捷选项</div>
            <div class="sg-hint">点击选项可自动将提示词输入到聊天框。可自定义选项内容。</div>

            <div class="sg-row sg-inline">
              <label class="sg-check"><input type="checkbox" id="sg_quickOptionsEnabled">启用快捷选项</label>
              <select id="sg_quickOptionsShowIn">
                <option value="inline">仅分析框</option>
                <option value="panel">仅面板</option>
                <option value="both">两者都显示</option>
              </select>
            </div>

            <div class="sg-field" style="margin-top:10px;">
              <label>选项配置（JSON，格式：[{label, prompt}, ...]）</label>
              <textarea id="sg_quickOptionsJson" rows="6" spellcheck="false" placeholder='[{"label": "继续", "prompt": "继续当前剧情发展"}]'></textarea>
              <div class="sg-actions-row">
                <button class="menu_button sg-btn" id="sg_resetQuickOptions">恢复默认选项</button>
                <button class="menu_button sg-btn" id="sg_applyQuickOptions">应用选项</button>
              </div>
            </div>
          </div>

          <div class="sg-card">
            <div class="sg-card-title">输出模块（JSON，可自定义字段/提示词）</div>
            <div class="sg-hint">你可以增删模块、改 key/title/type/prompt、控制 panel/inline。保存前可点“校验”。</div>

            <div class="sg-field">
              <textarea id="sg_modulesJson" rows="12" spellcheck="false"></textarea>
              <div class="sg-hint" style="margin-top:4px;">💡 模块可添加 <code>static: true</code> 表示静态模块（只在首次生成或手动刷新时更新）</div>
              <div class="sg-actions-row">
                <button class="menu_button sg-btn" id="sg_validateModules">校验</button>
                <button class="menu_button sg-btn" id="sg_resetModules">恢复默认</button>
                <button class="menu_button sg-btn" id="sg_applyModules">应用到设置</button>
                <button class="menu_button sg-btn" id="sg_clearStaticCache">刷新静态模块</button>
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
              <button class="menu_button sg-btn" id="sg_saveWorldbookSettings">保存世界书设置</button>
            </div>

            <div class="sg-hint" id="sg_worldbookInfo">（未导入世界书）</div>
          </div>

          <div class="sg-card">
            <div class="sg-card-title">🗺️ 网格地图</div>
            <div class="sg-hint">从剧情中自动提取地点信息，生成可视化世界地图。显示主角位置和各地事件。</div>
            
              <div class="sg-row sg-inline" style="margin-top: 10px;">
                <label class="sg-check"><input type="checkbox" id="sg_mapEnabled">启用地图功能</label>
              </div>

              <div class="sg-field" style="margin-top: 10px;">
                <label>地图提示词</label>
                <textarea id="sg_mapSystemPrompt" rows="6" placeholder="可自定义地图提取规则（仍需输出 JSON）"></textarea>
                <div class="sg-actions-row">
                  <button class="menu_button sg-btn" id="sg_mapResetPrompt">恢复默认提示词</button>
                </div>
              </div>
              
              <div class="sg-field" style="margin-top: 10px;">
                <label>地图当前状态</label>
                <div id="sg_mapPreview" class="sg-map-container">
                <div class="sg-map-empty">暂无地图数据。启用后进行剧情分析将自动生成地图。</div>
              </div>
            </div>
            
            <div class="sg-actions-row">
              <button class="menu_button sg-btn" id="sg_resetMap">🗑 重置地图</button>
              <button class="menu_button sg-btn" id="sg_refreshMapPreview">🔄 刷新预览</button>
            </div>
          </div>

          </div> <!-- sg_page_guide -->

          <div class="sg-page" id="sg_page_summary">

          <div class="sg-card">
            <div class="sg-card-title">自动总结（写入世界书）</div>

            <div class="sg-row sg-inline">
              <label class="sg-check"><input type="checkbox" id="sg_summaryEnabled">启用自动总结</label>
              <span>每</span>
              <input id="sg_summaryEvery" type="number" min="1" max="200" style="width:90px">
              <span>层</span>
              <select id="sg_summaryCountMode">
                <option value="assistant">按 AI 回复计数</option>
                <option value="all">按全部消息计数</option>
              </select>
            </div>

            <div class="sg-grid2">
              <div class="sg-field">
                <label>总结 Provider</label>
                <select id="sg_summaryProvider">
                  <option value="st">使用酒馆当前连接的模型</option>
                  <option value="custom">使用独立 OpenAI 兼容 API</option>
                </select>
              </div>
              <div class="sg-field">
                <label>总结 Temperature</label>
                <input id="sg_summaryTemperature" type="number" min="0" max="2" step="0.1">
              </div>
            </div>

            <div class="sg-card sg-subcard">
              <div class="sg-field">
                <label>自定义总结提示词（System，可选）</label>
                <textarea id="sg_summarySystemPrompt" rows="6" placeholder="例如：更强调线索/关系变化/回合制记录，或要求英文输出…（仍需输出 JSON）"></textarea>
              </div>
              <div class="sg-field">
                <label>对话片段模板（User，可选）</label>
                <textarea id="sg_summaryUserTemplate" rows="4" placeholder="支持占位符：{{fromFloor}} {{toFloor}} {{chunk}}"></textarea>
              </div>
              <div class="sg-row sg-inline">
                <button class="menu_button sg-btn" id="sg_summaryResetPrompt">恢复默认提示词</button>
                <div class="sg-hint" style="margin-left:auto">占位符：{{fromFloor}} {{toFloor}} {{chunk}} {{statData}}。插件会强制要求输出 JSON：{title, summary, keywords[]}。</div>
              </div>
              <div class="sg-row sg-inline" style="margin-top:8px">
                <label class="sg-check"><input type="checkbox" id="sg_summaryReadStatData">读取角色状态变量</label>
                <div class="sg-field" style="flex:1;margin-left:8px">
                  <input id="sg_summaryStatVarName" type="text" placeholder="stat_data" style="width:120px">
                </div>
                <div class="sg-hint" style="margin-left:8px">AI 可看到变量中的角色属性数据（类似 ROLL 点模块）</div>
              </div>
            </div>

            <div class="sg-card sg-subcard">
              <div class="sg-card-title">结构化条目（人物/装备/能力）</div>
              <div class="sg-row sg-inline">
                <label class="sg-check"><input type="checkbox" id="sg_structuredEntriesEnabled">启用结构化条目</label>
                <label class="sg-check"><input type="checkbox" id="sg_characterEntriesEnabled">人物</label>
                <label class="sg-check"><input type="checkbox" id="sg_equipmentEntriesEnabled">装备</label>
                <label class="sg-check"><input type="checkbox" id="sg_abilityEntriesEnabled">能力</label>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>人物条目前缀</label>
                  <input id="sg_characterEntryPrefix" type="text" placeholder="人物">
                </div>
                <div class="sg-field">
                  <label>装备条目前缀</label>
                  <input id="sg_equipmentEntryPrefix" type="text" placeholder="装备">
                </div>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>能力条目前缀</label>
                  <input id="sg_abilityEntryPrefix" type="text" placeholder="能力">
                </div>
              </div>
              <div class="sg-field">
                <label>结构化提取提示词（System，可选）</label>
                <textarea id="sg_structuredEntriesSystemPrompt" rows="5" placeholder="例如：强调客观档案式描述、避免杜撰…"></textarea>
              </div>
              <div class="sg-field">
                <label>结构化提取模板（User，可选）</label>
                <textarea id="sg_structuredEntriesUserTemplate" rows="4" placeholder="支持占位符：{{fromFloor}} {{toFloor}} {{chunk}} {{knownCharacters}} {{knownEquipments}}"></textarea>
              </div>
              <div class="sg-field">
                <label>人物条目提示词（可选）</label>
                <textarea id="sg_structuredCharacterPrompt" rows="3" placeholder="例如：优先记录阵营/关系/关键事件…"></textarea>
              </div>
              <div class="sg-field">
                <label>装备条目提示词（可选）</label>
                <textarea id="sg_structuredEquipmentPrompt" rows="3" placeholder="例如：强调来源/稀有度/当前状态…"></textarea>
              </div>
              <div class="sg-field">
                <label>能力条目提示词（可选）</label>
                <textarea id="sg_structuredAbilityPrompt" rows="3" placeholder="例如：强调触发条件/代价/负面效果…"></textarea>
              </div>
              <div class="sg-row sg-inline">
                <button class="menu_button sg-btn" id="sg_structuredResetPrompt">恢复默认结构化提示词</button>
                <button class="menu_button sg-btn" id="sg_clearStructuredCache">清除结构化条目缓存</button>
                <div class="sg-hint" style="margin-left:auto">占位符：{{fromFloor}} {{toFloor}} {{chunk}} {{knownCharacters}} {{knownEquipments}}。</div>
              </div>
            </div>

            <div class="sg-card sg-subcard" id="sg_summary_custom_block" style="display:none">
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>独立API基础URL</label>
                  <input id="sg_summaryCustomEndpoint" type="text" placeholder="https://api.openai.com/v1">
                </div>
                <div class="sg-field">
                  <label>API Key</label>
                  <input id="sg_summaryCustomApiKey" type="password" placeholder="sk-...">
                </div>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>模型ID（可手填）</label>
                  <input id="sg_summaryCustomModel" type="text" placeholder="gpt-4o-mini">
                  <div class="sg-row sg-inline" style="margin-top:6px;">
                    <button class="menu_button sg-btn" id="sg_refreshSummaryModels">刷新模型</button>
                    <select id="sg_summaryModelSelect" class="sg-model-select">
                      <option value="">（选择模型）</option>
                    </select>
                  </div>
                </div>
                <div class="sg-field">
                  <label>Max Tokens</label>
                  <input id="sg_summaryCustomMaxTokens" type="number" min="128" max="200000">
                </div>
              </div>
              <label class="sg-check"><input type="checkbox" id="sg_summaryCustomStream">stream（若支持）</label>
            </div>

            <div class="sg-row sg-inline">
              <label class="sg-check"><input type="checkbox" id="sg_summaryToWorldInfo">写入世界书（绿灯启用）</label>
              <select id="sg_summaryWorldInfoTarget">
                <option value="chatbook">写入当前聊天绑定世界书</option>
                <option value="file">写入指定世界书文件名</option>
              </select>
              <input id="sg_summaryWorldInfoFile" type="text" placeholder="Target=file 时填写世界书文件名" style="flex:1; min-width: 220px;">
            </div>

            <div class="sg-row sg-inline">
              <label class="sg-check"><input type="checkbox" id="sg_summaryToBlueWorldInfo">同时写入蓝灯世界书（常开索引）</label>
              <input id="sg_summaryBlueWorldInfoFile" type="text" placeholder="蓝灯世界书文件名（建议单独建一个）" style="flex:1; min-width: 260px;">
            </div>

            <div class="sg-card sg-subcard" style="background: var(--SmartThemeBlurTintColor); margin-top: 8px; display: none;">
              <div class="sg-row sg-inline" style="align-items: center;">
                <label class="sg-check"><input type="checkbox" id="sg_autoBindWorldInfo">📒 自动绑定世界书（每个聊天生成专属世界书）</label>
                <input id="sg_autoBindWorldInfoPrefix" type="text" placeholder="前缀" style="width: 80px;" title="世界书文件名前缀，默认 SG">
              </div>
              <div class="sg-hint" style="margin-top: 4px;">开启后，每个聊天会自动创建专属的绿灯/蓝灯世界书，切换聊天时自动加载。</div>
              <div id="sg_autoBindInfo" class="sg-hint" style="margin-top: 6px; display: none; font-size: 12px;"></div>
            </div>

            <div class="sg-hint" style="margin-top: 8px; color: var(--SmartThemeQuoteColor);">
              💡 请手动创建世界书文件，然后在上方填写文件名。绿灯选择「写入指定世界书文件名」模式。
            </div>

            <div class="sg-grid2">
              <div class="sg-field">
                <label>条目标题前缀（写入 comment，始终在最前）</label>
                <input id="sg_summaryWorldInfoCommentPrefix" type="text" placeholder="剧情总结">
              </div>
              <div class="sg-field">
                <label>限制：每条消息最多字符 / 总字符</label>
                <div class="sg-row" style="margin-top:0">
                  <input id="sg_summaryMaxChars" type="number" min="200" max="8000" style="width:110px">
                  <input id="sg_summaryMaxTotalChars" type="number" min="2000" max="80000" style="width:120px">
                </div>
              </div>
            </div>

            <div class="sg-grid2">
              <div class="sg-field">
                <label>世界书触发词写入 key</label>
                <select id="sg_summaryWorldInfoKeyMode">
                  <option value="keywords">使用模型输出的关键词（6~14 个）</option>
                  <option value="indexId">使用索引编号（只写 1 个，如 A-001）</option>
                </select>
                <div class="sg-hint">想让“主要关键词”只显示 A-001，就选“索引编号”。</div>
              </div>
              <div class="sg-field" id="sg_summaryIndexFormat" style="display:none;">
                <label>索引编号格式（keyMode=indexId）</label>
                <div class="sg-row" style="margin-top:0; gap:8px; align-items:center;">
                  <input id="sg_summaryIndexPrefix" type="text" placeholder="A-" style="width:90px">
                  <span class="sg-hint">位数</span>
                  <input id="sg_summaryIndexPad" type="number" min="1" max="12" style="width:80px">
                  <span class="sg-hint">起始</span>
                  <input id="sg_summaryIndexStart" type="number" min="1" max="1000000" style="width:100px">
                </div>
                <label class="sg-check" style="margin-top:6px;"><input type="checkbox" id="sg_summaryIndexInComment">条目标题（comment）包含编号</label>
              </div>
            </div>

            <div class="sg-card sg-subcard">
              <div class="sg-row sg-inline">
                <label class="sg-check"><input type="checkbox" id="sg_wiTriggerEnabled">启用“蓝灯索引 → 绿灯触发”（发送消息前自动注入触发词）</label>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>读取前 N 条消息正文</label>
                  <input id="sg_wiTriggerLookbackMessages" type="number" min="5" max="120" placeholder="20">
                </div>
                <div class="sg-field">
                  <label>最多触发条目数</label>
                  <input id="sg_wiTriggerMaxEntries" type="number" min="1" max="20" placeholder="4">
                </div>

              <div class="sg-grid2" style="margin-top: 8px;">
                <div class="sg-field">
                  <label>最多索引人物数</label>
                  <input id="sg_wiTriggerMaxCharacters" type="number" min="0" max="10" placeholder="2">
                </div>
                <div class="sg-field">
                  <label>最多索引装备数</label>
                  <input id="sg_wiTriggerMaxEquipments" type="number" min="0" max="10" placeholder="2">
                </div>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>最多索引剧情数（优先久远）</label>
                  <input id="sg_wiTriggerMaxPlot" type="number" min="0" max="10" placeholder="3">
                </div>
              </div>

<div class="sg-grid2">
  <div class="sg-field">
    <label>匹配方式</label>
    <select id="sg_wiTriggerMatchMode">
      <option value="local">本地相似度（快）</option>
      <option value="llm">LLM 综合判断（可自定义提示词）</option>
    </select>
  </div>
  <div class="sg-field">
    <label>预筛选 TopK（仅 LLM 模式）</label>
    <input id="sg_wiIndexPrefilterTopK" type="number" min="5" max="80" placeholder="24">
    <div class="sg-hint">先用相似度挑 TopK，再交给模型选出最相关的几条（省 tokens）。</div>
  </div>
</div>

<div class="sg-card sg-subcard" id="sg_index_llm_block" style="display:none; margin-top:10px;">
  <div class="sg-grid2">
    <div class="sg-field">
      <label>索引 Provider</label>
      <select id="sg_wiIndexProvider">
        <option value="st">使用酒馆当前连接的模型</option>
        <option value="custom">使用独立 OpenAI 兼容 API</option>
      </select>
    </div>
    <div class="sg-field">
      <label>索引 Temperature</label>
      <input id="sg_wiIndexTemperature" type="number" min="0" max="2" step="0.1">
    </div>
  </div>

  <div class="sg-field">
    <label>自定义索引提示词（System，可选）</label>
    <textarea id="sg_wiIndexSystemPrompt" rows="6" placeholder="例如：更强调人物关系/线索回收/当前目标；或要求更严格的筛选…"></textarea>
  </div>
  <div class="sg-field">
    <label>索引模板（User，可选）</label>
    <textarea id="sg_wiIndexUserTemplate" rows="6" placeholder="支持占位符：{{userMessage}} {{recentText}} {{candidates}} {{maxPick}}"></textarea>
  </div>
  <div class="sg-row sg-inline">
    <button class="menu_button sg-btn" id="sg_wiIndexResetPrompt">恢复默认索引提示词</button>
    <div class="sg-hint" style="margin-left:auto">占位符：{{userMessage}} {{recentText}} {{candidates}} {{maxPick}}。插件会强制要求输出 JSON：{pickedIds:number[]}。</div>
  </div>

  <div class="sg-card sg-subcard" id="sg_index_custom_block" style="display:none">
    <div class="sg-grid2">
      <div class="sg-field">
        <label>索引独立API基础URL</label>
        <input id="sg_wiIndexCustomEndpoint" type="text" placeholder="https://api.openai.com/v1">
      </div>
      <div class="sg-field">
        <label>API Key</label>
        <input id="sg_wiIndexCustomApiKey" type="password" placeholder="sk-...">
      </div>
    </div>
    <div class="sg-grid2">
      <div class="sg-field">
        <label>模型ID（可手填）</label>
        <input id="sg_wiIndexCustomModel" type="text" placeholder="gpt-4o-mini">
        <div class="sg-row sg-inline" style="margin-top:6px;">
          <button class="menu_button sg-btn" id="sg_refreshIndexModels">刷新模型</button>
          <select id="sg_wiIndexModelSelect" class="sg-model-select">
            <option value="">（选择模型）</option>
          </select>
        </div>
      </div>
      <div class="sg-field">
        <label>Max Tokens</label>
        <input id="sg_wiIndexCustomMaxTokens" type="number" min="128" max="200000">
        <div class="sg-row sg-inline" style="margin-top:6px;">
          <span class="sg-hint">TopP</span>
          <input id="sg_wiIndexTopP" type="number" min="0" max="1" step="0.01" style="width:110px">
        </div>
      </div>
    </div>
    <label class="sg-check"><input type="checkbox" id="sg_wiIndexCustomStream">stream（若支持）</label>
  </div>
</div>

              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label class="sg-check"><input type="checkbox" id="sg_wiTriggerIncludeUserMessage">结合本次用户输入（综合判断）</label>
                  <div class="sg-hint">开启后会综合“最近 N 条正文 + 你这句话”来决定与当前剧情最相关的条目。</div>
                </div>
                <div class="sg-field">
                  <label>用户输入权重（0~10）</label>
                  <input id="sg_wiTriggerUserMessageWeight" type="number" min="0" max="10" step="0.1" placeholder="1.6">
                  <div class="sg-hint">越大越看重你这句话；1=与最近正文同权重。</div>
                </div>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>相关度阈值（0~1）</label>
                  <input id="sg_wiTriggerMinScore" type="number" min="0" max="1" step="0.01" placeholder="0.08">
                </div>
                <div class="sg-field">
                  <label>最多注入触发词</label>
                  <input id="sg_wiTriggerMaxKeywords" type="number" min="1" max="200" placeholder="24">
                </div>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>至少已有 N 条 AI 回复才开始索引（0=立即）</label>
                  <input id="sg_wiTriggerStartAfterAssistantMessages" type="number" min="0" max="200000" placeholder="0">
                </div>
                <div class="sg-field">
                  <label>说明</label>
                  <div class="sg-hint" style="padding-top:8px;">（只统计 AI 回复楼层；例如填 100 表示第 100 层之后才注入）</div>
                </div>
              </div>
              <div class="sg-row sg-inline">
                <label>注入方式</label>
                <select id="sg_wiTriggerInjectStyle" style="min-width:200px">
                  <option value="hidden">隐藏注释（推荐）</option>
                  <option value="plain">普通文本（更稳）</option>
                </select>
              </div>
              <div class="sg-row sg-inline">
                <label>蓝灯索引</label>
                <select id="sg_wiBlueIndexMode" style="min-width:180px">
                  <option value="live">实时读取蓝灯世界书</option>
                  <option value="cache">使用导入/缓存</option>
                </select>
                <input id="sg_wiBlueIndexFile" type="text" placeholder="蓝灯世界书文件名（留空=使用上方蓝灯写入文件名）" style="flex:1; min-width: 260px;">
                <button class="menu_button sg-btn" id="sg_refreshBlueIndexLive">刷新</button>
              </div>
              <div class="sg-row sg-inline">
                <label class="sg-check"><input type="checkbox" id="sg_wiTriggerDebugLog">调试：状态栏显示命中条目/触发词</label>
                <button class="menu_button sg-btn" id="sg_importBlueIndex">导入蓝灯世界书JSON（备用）</button>
                <button class="menu_button sg-btn" id="sg_clearBlueIndex">清空蓝灯索引</button>
                <div class="sg-hint" id="sg_blueIndexInfo" style="margin-left:auto">（蓝灯索引：0 条）</div>
              </div>
              <div class="sg-hint">
                说明：本功能会用“蓝灯索引”里的每条总结（title/summary/keywords）与 <b>最近 N 条正文</b>（可选再加上 <b>本次用户输入</b>）做相似度匹配，选出最相关的几条，把它们的 <b>keywords</b> 追加到你刚发送的消息末尾（可选隐藏注释/普通文本），从而触发“绿灯世界书”的对应条目。
              </div>

              <div class="sg-card sg-subcard" style="margin-top:10px;">
                <div class="sg-row sg-inline" style="margin-top:0;">
                  <div class="sg-hint">ROLL 设置已移至独立的「ROLL 设置」标签页。</div>
                  <div class="sg-spacer"></div>
                  <button class="menu_button sg-btn" id="sg_gotoRollPage">打开 ROLL 设置</button>
                </div>
              </div>

              <div class="sg-card sg-subcard" style="margin-top:10px;">
                <div class="sg-row sg-inline" style="margin-top:0;">
                  <div class="sg-card-title" style="margin:0;">索引日志</div>
                  <div class="sg-spacer"></div>
                  <button class="menu_button sg-btn" id="sg_clearWiLogs">清空</button>
                </div>
                <div class="sg-loglist" id="sg_wiLogs" style="margin-top:8px;">(暂无)</div>
                <div class="sg-hint" style="margin-top:8px;">提示：日志记录“这次发送消息时命中了哪些索引条目（等价于将触发的绿灯条目）”以及注入了哪些关键词。</div>
              </div>
            </div>

            <div class="sg-card sg-subcard" id="sg_indexMovedHint" style="margin-top:10px;">
              <div class="sg-row sg-inline" style="margin-top:0;">
                <div class="sg-hint">索引相关设置已移至上方“索引设置”页。</div>
                <div class="sg-spacer"></div>
                <button class="menu_button sg-btn" id="sg_gotoIndexPage">打开索引设置</button>
              </div>
            </div>

            <div class="sg-row sg-inline">
              <label>手动楼层范围</label>
              <input id="sg_summaryManualFrom" type="number" min="1" style="width:110px" placeholder="起始层">
              <span> - </span>
              <input id="sg_summaryManualTo" type="number" min="1" style="width:110px" placeholder="结束层">
              <button class="menu_button sg-btn" id="sg_summarizeRange">立即总结该范围</button>
              <div class="sg-hint" id="sg_summaryManualHint" style="margin-left:auto">（可选范围：1-0）</div>
            </div>

            <div class="sg-row sg-inline" style="margin-top:6px;">
              <label class="sg-check" style="margin:0;"><input type="checkbox" id="sg_summaryManualSplit">手动范围按每 N 层拆分生成多条（N=上方“每 N 层总结一次”）</label>
              <div class="sg-hint" style="margin-left:auto">例如 1-80 且 N=40 → 2 条</div>
            </div>

            <div class="sg-row sg-inline">
              <button class="menu_button sg-btn" id="sg_summarizeNow">立即总结</button>
              <button class="menu_button sg-btn" id="sg_stopSummary" style="background: var(--SmartThemeBodyColor); color: var(--SmartThemeQuoteColor);">停止总结</button>
              <button class="menu_button sg-btn" id="sg_resetSummaryState">重置本聊天总结进度</button>
              <div class="sg-hint" id="sg_summaryInfo" style="margin-left:auto">（未生成）</div>
            </div>

            <div class="sg-hint">
              自动总结会按“每 N 层”触发；每次输出会生成 <b>摘要</b> + <b>关键词</b>，并可自动创建世界书条目（disable=0 绿灯启用，关键词写入 key 作为触发词）。
            </div>
          </div>
          </div> <!-- sg_page_summary -->

          <div class="sg-page" id="sg_page_index">
            <div class="sg-card">
              <div class="sg-card-title">索引设置（蓝灯索引 → 绿灯触发）</div>
              <div class="sg-hint" style="margin-bottom:10px;">索引会从“蓝灯世界书”里挑选与当前剧情最相关的总结条目，并把对应触发词注入到你发送的消息末尾，以触发绿灯世界书条目。</div>
              <div id="sg_index_mount"></div>
            </div>
          </div> <!-- sg_page_index -->

          <div class="sg-page" id="sg_page_roll">
            <div class="sg-card">
              <div class="sg-card-title">ROLL 设置（判定）</div>
              <div class="sg-hint" style="margin-bottom:10px;">用于行动判定的 ROLL 注入与计算规则。ROLL 模块独立运行，不依赖总结或索引功能。</div>
              
              <label class="sg-check"><input type="checkbox" id="sg_wiRollEnabled">启用 ROLL 点（战斗/劝说/学习等判定；与用户输入一起注入）</label>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>随机权重（0~1）</label>
                  <input id="sg_wiRollRandomWeight" type="number" min="0" max="1" step="0.01" placeholder="0.3">
                </div>
                <div class="sg-field">
                  <label>难度模式</label>
                  <select id="sg_wiRollDifficulty">
                    <option value="simple">简单</option>
                    <option value="normal">普通</option>
                    <option value="hard">困难</option>
                    <option value="hell">地狱</option>
                  </select>
                </div>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>变量来源</label>
                  <select id="sg_wiRollStatSource">
                    <option value="variable">综合多来源（最稳定，推荐）</option>
                    <option value="template">模板渲染（stat_data）</option>
                    <option value="latest">最新正文末尾</option>
                  </select>
                  <div class="sg-hint">综合模式按优先级尝试：/getvar命令 → 变量存储 → 模板渲染 → DOM读取 → 最新AI回复</div>
                </div>
                <div class="sg-field">
                  <label>变量解析模式</label>
                  <select id="sg_wiRollStatParseMode">
                    <option value="json">JSON</option>
                    <option value="kv">键值行（pc.atk=10）</option>
                  </select>
                </div>
              </div>
              <div class="sg-field">
                <label>变量名（用于"变量存储"来源）</label>
                <input id="sg_wiRollStatVarName" type="text" placeholder="stat_data">
              </div>
              <div class="sg-row sg-inline">
                <label>注入方式</label>
                <select id="sg_wiRollInjectStyle">
                  <option value="hidden">隐藏注释</option>
                  <option value="plain">普通文本</option>
                </select>
              </div>
              <div class="sg-row sg-inline">
                <label class="sg-check" style="margin:0;"><input type="checkbox" id="sg_wiRollDebugLog">调试：状态栏显示判定细节/未触发原因</label>
              </div>
              <div class="sg-grid2">
                <div class="sg-field">
                  <label>ROLL Provider</label>
                  <select id="sg_wiRollProvider">
                    <option value="custom">独立 API</option>
                    <option value="local">本地计算</option>
                  </select>
                </div>
              </div>
              <div class="sg-card sg-subcard" id="sg_roll_custom_block" style="display:none; margin-top:8px;">
                <div class="sg-grid2">
                  <div class="sg-field">
                    <label>ROLL 独立 API 基础URL</label>
                    <input id="sg_wiRollCustomEndpoint" type="text" placeholder="https://api.openai.com/v1">
                  </div>
                  <div class="sg-field">
                    <label>API Key</label>
                    <input id="sg_wiRollCustomApiKey" type="password" placeholder="sk-...">
                  </div>
                </div>
                <div class="sg-grid2">
                  <div class="sg-field">
                    <label>模型ID</label>
                    <input id="sg_wiRollCustomModel" type="text" placeholder="gpt-4o-mini">
                  </div>
                  <div class="sg-field">
                    <label>Max Tokens</label>
                    <input id="sg_wiRollCustomMaxTokens" type="number" min="128" max="200000">
                  </div>
                </div>
                <div class="sg-grid2">
                  <div class="sg-field">
                    <label>Temperature</label>
                    <input id="sg_wiRollCustomTemperature" type="number" min="0" max="2" step="0.1">
                  </div>
                  <div class="sg-field">
                    <label>TopP</label>
                    <input id="sg_wiRollCustomTopP" type="number" min="0" max="1" step="0.01">
                  </div>
                </div>
                <label class="sg-check"><input type="checkbox" id="sg_wiRollCustomStream">stream（若支持）</label>
                <div class="sg-field" style="margin-top:8px;">
                  <label>ROLL 系统提示词</label>
                  <textarea id="sg_wiRollSystemPrompt" rows="5"></textarea>
                </div>
              </div>
              <div class="sg-hint">AI 会先判断是否需要判定，再计算并注入结果。"综合多来源"模式会尝试多种方式读取变量，确保最大兼容性。</div>
            </div>
            <div class="sg-card sg-subcard" style="margin-top:10px;">
              <div class="sg-row sg-inline" style="margin-top:0;">
                <div class="sg-card-title" style="margin:0;">ROLL 日志</div>
                <div class="sg-spacer"></div>
                <button class="menu_button sg-btn" id="sg_clearRollLogs">清空</button>
              </div>
              <div class="sg-loglist" id="sg_rollLogs" style="margin-top:8px;">(暂无)</div>
              <div class="sg-hint" style="margin-top:8px;">提示：仅记录由 ROLL API 返回的简要计算摘要。</div>
            </div>
          </div> <!-- sg_page_roll -->

          <div class="sg-status" id="sg_status"></div>
        </div>

        <div class="sg-right">
          <div class="sg-card">
            <div class="sg-card-title">输出</div>

            <div class="sg-tabs">
              <button class="sg-tab active" id="sg_tab_md">报告</button>
              <button class="sg-tab" id="sg_tab_json">JSON</button>
              <button class="sg-tab" id="sg_tab_src">来源</button>
              <button class="sg-tab" id="sg_tab_sum">总结</button>
              <div class="sg-spacer"></div>
              <button class="menu_button sg-btn" id="sg_copyMd" disabled>复制MD</button>
              <button class="menu_button sg-btn" id="sg_copyJson" disabled>复制JSON</button>
              <button class="menu_button sg-btn" id="sg_copySum" disabled>复制总结</button>
              <button class="menu_button sg-btn" id="sg_injectTips" disabled>注入提示</button>
            </div>

            <div class="sg-pane active" id="sg_pane_md"><div class="sg-md" id="sg_md">(尚未生成)</div></div>
            <div class="sg-pane" id="sg_pane_json"><pre class="sg-pre" id="sg_json"></pre></div>
            <div class="sg-pane" id="sg_pane_src"><pre class="sg-pre" id="sg_src"></pre></div>
            <div class="sg-pane" id="sg_pane_sum"><div class="sg-md" id="sg_sum">(尚未生成)</div></div>
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

  // --- settings pages (剧情指导 / 总结设置 / 索引设置 / ROLL 设置) ---
  setupSettingsPages();

  $('#sg_modal_backdrop').on('click', (e) => { if (e.target && e.target.id === 'sg_modal_backdrop') closeModal(); });
  $('#sg_close').on('click', closeModal);

  $('#sg_tab_md').on('click', () => showPane('md'));
  $('#sg_tab_json').on('click', () => showPane('json'));
  $('#sg_tab_src').on('click', () => showPane('src'));
  $('#sg_tab_sum').on('click', () => showPane('sum'));

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

  $('#sg_copySum').on('click', async () => {
    try { await navigator.clipboard.writeText(lastSummaryText || ''); setStatus('已复制：总结', 'ok'); }
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

  // summary provider toggle
  $('#sg_summaryProvider').on('change', () => {
    const p = String($('#sg_summaryProvider').val() || 'st');
    $('#sg_summary_custom_block').toggle(p === 'custom');
    pullUiToSettings(); saveSettings();
  });

  // roll provider toggle
  $('#sg_wiRollProvider').on('change', () => {
    const p = String($('#sg_wiRollProvider').val() || 'custom');
    $('#sg_roll_custom_block').toggle(p === 'custom');
    pullUiToSettings(); saveSettings();
  });


  // wiTrigger match mode toggle
  $('#sg_wiTriggerMatchMode').on('change', () => {
    const m = String($('#sg_wiTriggerMatchMode').val() || 'local');
    $('#sg_index_llm_block').toggle(m === 'llm');
    const p = String($('#sg_wiIndexProvider').val() || 'st');
    $('#sg_index_custom_block').toggle(m === 'llm' && p === 'custom');
    pullUiToSettings(); saveSettings();
  });

  // index provider toggle (only meaningful under LLM mode)
  $('#sg_wiIndexProvider').on('change', () => {
    const m = String($('#sg_wiTriggerMatchMode').val() || 'local');
    const p = String($('#sg_wiIndexProvider').val() || 'st');
    $('#sg_index_custom_block').toggle(m === 'llm' && p === 'custom');
    pullUiToSettings(); saveSettings();
  });

  // index prompt reset
  $('#sg_wiIndexResetPrompt').on('click', () => {
    $('#sg_wiIndexSystemPrompt').val(DEFAULT_INDEX_SYSTEM_PROMPT);
    $('#sg_wiIndexUserTemplate').val(DEFAULT_INDEX_USER_TEMPLATE);
    pullUiToSettings();
    saveSettings();
    setStatus('已恢复默认索引提示词 ✅', 'ok');
  });

  $('#sg_summaryWorldInfoTarget').on('change', () => {
    const t = String($('#sg_summaryWorldInfoTarget').val() || 'chatbook');
    $('#sg_summaryWorldInfoFile').toggle(t === 'file');
    pullUiToSettings(); saveSettings();
  });

  $('#sg_summaryToBlueWorldInfo').on('change', () => {
    const checked = $('#sg_summaryToBlueWorldInfo').is(':checked');
    $('#sg_summaryBlueWorldInfoFile').toggle(!!checked);
    pullUiToSettings(); saveSettings();
    updateBlueIndexInfoLabel();
  });

  // summary key mode toggle (keywords vs indexId)
  $('#sg_summaryWorldInfoKeyMode').on('change', () => {
    const m = String($('#sg_summaryWorldInfoKeyMode').val() || 'keywords');
    $('#sg_summaryIndexFormat').toggle(m === 'indexId');
    pullUiToSettings();
    saveSettings();
  });

  // summary prompt reset
  $('#sg_summaryResetPrompt').on('click', () => {
    $('#sg_summarySystemPrompt').val(DEFAULT_SUMMARY_SYSTEM_PROMPT);
    $('#sg_summaryUserTemplate').val(DEFAULT_SUMMARY_USER_TEMPLATE);
    pullUiToSettings();
    saveSettings();
    setStatus('已恢复默认总结提示词 ✅', 'ok');
  });

  // structured entries prompt reset + cache clear
  $('#sg_structuredResetPrompt').on('click', () => {
    $('#sg_structuredEntriesSystemPrompt').val(DEFAULT_STRUCTURED_ENTRIES_SYSTEM_PROMPT);
    $('#sg_structuredEntriesUserTemplate').val(DEFAULT_STRUCTURED_ENTRIES_USER_TEMPLATE);
    $('#sg_structuredCharacterPrompt').val(DEFAULT_STRUCTURED_CHARACTER_PROMPT);
    $('#sg_structuredEquipmentPrompt').val(DEFAULT_STRUCTURED_EQUIPMENT_PROMPT);
    $('#sg_structuredAbilityPrompt').val(DEFAULT_STRUCTURED_ABILITY_PROMPT);
    pullUiToSettings();
    saveSettings();
    setStatus('已恢复默认结构化提示词 ✅', 'ok');
  });

  $('#sg_clearStructuredCache').on('click', async () => {
    try {
      await clearStructuredEntriesCache();
      setStatus('已清除结构化条目缓存 ✅', 'ok');
    } catch (e) {
      setStatus(`清除结构化条目缓存失败：${e?.message ?? e}`, 'err');
    }
  });

  // manual range split toggle & hint refresh
  $('#sg_summaryManualSplit').on('change', () => {
    pullUiToSettings();
    saveSettings();
    updateSummaryManualRangeHint(false);
  });
  $('#sg_summaryManualFrom, #sg_summaryManualTo, #sg_summaryEvery, #sg_summaryCountMode').on('input change', () => {
    // count mode / every affects the computed floor range and split pieces
    updateSummaryManualRangeHint(false);
  });

  // summary actions
  $('#sg_summarizeNow').on('click', async () => {
    try {
      pullUiToSettings();
      saveSettings();
      await runSummary({ reason: 'manual' });
    } catch (e) {
      setStatus(`总结失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_stopSummary').on('click', () => {
    stopSummary();
    setStatus('正在停止总结…', 'warn');
  });

  $('#sg_summarizeRange').on('click', async () => {
    try {
      pullUiToSettings();
      saveSettings();
      const from = clampInt($('#sg_summaryManualFrom').val(), 1, 200000, 1);
      const to = clampInt($('#sg_summaryManualTo').val(), 1, 200000, 1);
      await runSummary({ reason: 'manual_range', manualFromFloor: from, manualToFloor: to });
    } catch (e) {
      setStatus(`手动范围总结失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_resetSummaryState').on('click', async () => {
    try {
      const meta = getDefaultSummaryMeta();
      await setSummaryMeta(meta);
      updateSummaryInfoLabel();
      renderSummaryPaneFromMeta();
      setStatus('已重置本聊天总结进度 ✅', 'ok');
    } catch (e) {
      setStatus(`重置失败：${e?.message ?? e}`, 'err');
    }
  });

  // auto-save summary settings
  $('#sg_summaryEnabled, #sg_summaryEvery, #sg_summaryCountMode, #sg_summaryTemperature, #sg_summarySystemPrompt, #sg_summaryUserTemplate, #sg_summaryReadStatData, #sg_summaryStatVarName, #sg_structuredEntriesEnabled, #sg_characterEntriesEnabled, #sg_equipmentEntriesEnabled, #sg_abilityEntriesEnabled, #sg_characterEntryPrefix, #sg_equipmentEntryPrefix, #sg_abilityEntryPrefix, #sg_structuredEntriesSystemPrompt, #sg_structuredEntriesUserTemplate, #sg_structuredCharacterPrompt, #sg_structuredEquipmentPrompt, #sg_structuredAbilityPrompt, #sg_summaryCustomEndpoint, #sg_summaryCustomApiKey, #sg_summaryCustomModel, #sg_summaryCustomMaxTokens, #sg_summaryCustomStream, #sg_summaryToWorldInfo, #sg_summaryWorldInfoFile, #sg_summaryWorldInfoCommentPrefix, #sg_summaryWorldInfoKeyMode, #sg_summaryIndexPrefix, #sg_summaryIndexPad, #sg_summaryIndexStart, #sg_summaryIndexInComment, #sg_summaryToBlueWorldInfo, #sg_summaryBlueWorldInfoFile, #sg_wiTriggerEnabled, #sg_wiTriggerLookbackMessages, #sg_wiTriggerIncludeUserMessage, #sg_wiTriggerUserMessageWeight, #sg_wiTriggerStartAfterAssistantMessages, #sg_wiTriggerMaxEntries, #sg_wiTriggerMaxCharacters, #sg_wiTriggerMaxEquipments, #sg_wiTriggerMaxPlot, #sg_wiTriggerMinScore, #sg_wiTriggerMaxKeywords, #sg_wiTriggerInjectStyle, #sg_wiTriggerDebugLog, #sg_wiBlueIndexMode, #sg_wiBlueIndexFile, #sg_summaryMaxChars, #sg_summaryMaxTotalChars, #sg_wiTriggerMatchMode, #sg_wiIndexPrefilterTopK, #sg_wiIndexProvider, #sg_wiIndexTemperature, #sg_wiIndexSystemPrompt, #sg_wiIndexUserTemplate, #sg_wiIndexCustomEndpoint, #sg_wiIndexCustomApiKey, #sg_wiIndexCustomModel, #sg_wiIndexCustomMaxTokens, #sg_wiIndexTopP, #sg_wiIndexCustomStream, #sg_wiRollEnabled, #sg_wiRollStatSource, #sg_wiRollStatVarName, #sg_wiRollRandomWeight, #sg_wiRollDifficulty, #sg_wiRollInjectStyle, #sg_wiRollDebugLog, #sg_wiRollStatParseMode, #sg_wiRollProvider, #sg_wiRollCustomEndpoint, #sg_wiRollCustomApiKey, #sg_wiRollCustomModel, #sg_wiRollCustomMaxTokens, #sg_wiRollCustomTopP, #sg_wiRollCustomTemperature, #sg_wiRollCustomStream, #sg_wiRollSystemPrompt').on('change input', () => {
    pullUiToSettings();
    saveSettings();
    updateSummaryInfoLabel();
    updateBlueIndexInfoLabel();
    updateSummaryManualRangeHint(false);
  });

  $('#sg_refreshModels').on('click', async () => {
    pullUiToSettings(); saveSettings();
    await refreshModels();
  });

  // 导出/导入全局预设
  $('#sg_exportPreset').on('click', () => {
    try {
      exportPreset();
    } catch (e) {
      showToast(`导出失败: ${e.message}`, { kind: 'err' });
    }
  });

  $('#sg_importPreset').on('click', () => {
    $('#sg_importPresetFile').trigger('click');
  });

  $('#sg_importPresetFile').on('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      await importPreset(file);
      // 清空 input 以便再次选择同一文件
      e.target.value = '';
    }
  });

  $('#sg_refreshSummaryModels').on('click', async () => {
    pullUiToSettings(); saveSettings();
    await refreshSummaryModels();
  });


  $('#sg_refreshIndexModels').on('click', async () => {
    pullUiToSettings(); saveSettings();
    await refreshIndexModels();
  });

  $('#sg_modelSelect').on('change', () => {
    const id = String($('#sg_modelSelect').val() || '').trim();
    if (id) $('#sg_customModel').val(id);
  });

  $('#sg_summaryModelSelect').on('change', () => {
    const id = String($('#sg_summaryModelSelect').val() || '').trim();
    if (id) $('#sg_summaryCustomModel').val(id);
  });


  $('#sg_wiIndexModelSelect').on('change', () => {
    const id = String($('#sg_wiIndexModelSelect').val() || '').trim();
    if (id) $('#sg_wiIndexCustomModel').val(id);
  });

  // 蓝灯索引导入/清空
  $('#sg_refreshBlueIndexLive').on('click', async () => {
    try {
      pullUiToSettings();
      saveSettings();
      const s = ensureSettings();
      const mode = String(s.wiBlueIndexMode || 'live');
      if (mode !== 'live') {
        setStatus('当前为“缓存”模式：不会实时读取（可切换为“实时读取蓝灯世界书”）', 'warn');
        return;
      }
      const file = pickBlueIndexFileName();
      if (!file) {
        setStatus('蓝灯世界书文件名为空：请在“蓝灯索引”里填写文件名，或在“同时写入蓝灯世界书”里填写文件名', 'err');
        return;
      }
      const entries = await ensureBlueIndexLive(true);
      setStatus(`已实时读取蓝灯世界书 ✅（${entries.length} 条）`, entries.length ? 'ok' : 'warn');
    } catch (e) {
      setStatus(`实时读取蓝灯世界书失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_importBlueIndex').on('click', async () => {
    try {
      const file = await pickFile('.json,application/json');
      if (!file) return;
      const txt = await readFileText(file);
      const entries = parseWorldbookJson(txt);
      const s = ensureSettings();
      // 仅保留必要字段
      s.summaryBlueIndex = entries.map(e => ({
        title: String(e.title || '').trim() || (e.keys?.[0] ? `条目：${e.keys[0]}` : '条目'),
        summary: String(e.content || '').trim(),
        keywords: Array.isArray(e.keys) ? e.keys.slice(0, 80) : [],
        importedAt: Date.now(),
      })).filter(x => x.summary);
      saveSettings();
      updateBlueIndexInfoLabel();
      setStatus(`蓝灯索引已导入 ✅（${s.summaryBlueIndex.length} 条）`, s.summaryBlueIndex.length ? 'ok' : 'warn');
    } catch (e) {
      setStatus(`导入蓝灯索引失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_clearBlueIndex').on('click', () => {
    const s = ensureSettings();
    s.summaryBlueIndex = [];
    saveSettings();
    updateBlueIndexInfoLabel();
    setStatus('已清空蓝灯索引', 'ok');
  });

  $('#sg_clearWiLogs').on('click', async () => {
    try {
      const meta = getSummaryMeta();
      meta.wiTriggerLogs = [];
      await setSummaryMeta(meta);
      renderWiTriggerLogs(meta);
      setStatus('已清空索引日志', 'ok');
    } catch (e) {
      setStatus(`清空索引日志失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_clearRollLogs').on('click', async () => {
    try {
      const meta = getSummaryMeta();
      meta.rollLogs = [];
      await setSummaryMeta(meta);
      renderRollLogs(meta);
      setStatus('已清空 ROLL 日志', 'ok');
    } catch (e) {
      setStatus(`清空 ROLL 日志失败：${e?.message ?? e}`, 'err');
    }
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
      setStatus('已导入预设并应用 ✅（建议刷新一次页面）', 'ok');

      scheduleReapplyAll('import_preset');
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

      updateWorldbookInfoLabel();
      setStatus('世界书已导入 ✅', entries.length ? 'ok' : 'warn');
    } catch (e) {
      setStatus(`导入世界书失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_clearWorldbook').on('click', () => {
    const s = ensureSettings();
    s.worldbookJson = '';
    saveSettings();
    updateWorldbookInfoLabel();
    setStatus('已清空世界书', 'ok');
  });

  $('#sg_saveWorldbookSettings').on('click', () => {
    try {
      pullUiToSettings();
      saveSettings();
      updateWorldbookInfoLabel();
      setStatus('世界书设置已保存 ✅', 'ok');
    } catch (e) {
      setStatus(`保存世界书设置失败：${e?.message ?? e}`, 'err');
    }
  });

  // 自动保存：世界书相关设置变更时立刻写入
  $('#sg_worldbookEnabled, #sg_worldbookMode').on('change', () => {
    pullUiToSettings();
    saveSettings();
    updateWorldbookInfoLabel();
  });

    // 地图功能事件处理
    $('#sg_mapEnabled').on('change', () => {
      pullUiToSettings();
      saveSettings();
    });

    $('#sg_mapSystemPrompt').on('change input', () => {
      pullUiToSettings();
      saveSettings();
    });

    $('#sg_mapResetPrompt').on('click', () => {
      $('#sg_mapSystemPrompt').val(String(DEFAULT_SETTINGS.mapSystemPrompt || ''));
      pullUiToSettings();
      saveSettings();
      setStatus('已恢复默认地图提示词 ✅', 'ok');
    });

    bindMapEventPanelHandler();

    $(document).on('click', (e) => {
      const $t = $(e.target);
      if ($t.closest('.sg-map-popover, .sg-map-location').length) return;
      if (sgMapPopoverEl) sgMapPopoverEl.style.display = 'none';
    });

    $('#sg_resetMap').on('click', async () => {
      try {
        await setMapData(getDefaultMapData());
      updateMapPreview();
      setStatus('地图已重置 ✅', 'ok');
    } catch (e) {
      setStatus(`重置地图失败：${e?.message ?? e}`, 'err');
    }
  });

  $('#sg_refreshMapPreview').on('click', () => {
    updateMapPreview();
    setStatus('地图预览已刷新', 'ok');
  });
  $('#sg_worldbookMaxChars, #sg_worldbookWindowMessages').on('input', () => {
    pullUiToSettings();
    saveSettings();
    updateWorldbookInfoLabel();
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
    setStatus('模块已应用并保存 ✅（注意：追加框展示的模块由“追加框展示模块”控制）', 'ok');
  });

  // 刷新静态模块缓存
  $('#sg_clearStaticCache').on('click', async () => {
    try {
      await clearStaticModulesCache();
      setStatus('已清除静态模块缓存 ✅ 下次分析会重新生成静态模块（如"世界简介"）', 'ok');
    } catch (e) {
      setStatus(`清除静态模块缓存失败：${e?.message ?? e}`, 'err');
    }
  });

  // 自动绑定世界书事件
  $('#sg_autoBindWorldInfo').on('change', async () => {
    pullUiToSettings();
    saveSettings();
    const s = ensureSettings();
    if (s.autoBindWorldInfo) {
      await ensureBoundWorldInfo();
    }
    updateAutoBindUI();
  });

  $('#sg_autoBindWorldInfoPrefix').on('input', () => {
    pullUiToSettings();
    saveSettings();
  });

  // 快捷选项按钮事件
  $('#sg_resetQuickOptions').on('click', () => {
    const defaultOptions = JSON.stringify([
      { label: '继续', prompt: '继续当前剧情发展' },
      { label: '详述', prompt: '请更详细地描述当前场景' },
      { label: '对话', prompt: '让角色之间展开更多对话' },
      { label: '行动', prompt: '描述接下来的具体行动' },
    ], null, 2);
    $('#sg_quickOptionsJson').val(defaultOptions);
    const s = ensureSettings();
    s.quickOptionsJson = defaultOptions;
    saveSettings();
    setStatus('已恢复默认快捷选项 ✅', 'ok');
  });

  $('#sg_applyQuickOptions').on('click', () => {
    const txt = String($('#sg_quickOptionsJson').val() || '').trim();
    try {
      const arr = JSON.parse(txt || '[]');
      if (!Array.isArray(arr)) {
        setStatus('快捷选项格式错误：必须是 JSON 数组', 'err');
        return;
      }
      const s = ensureSettings();
      s.quickOptionsJson = JSON.stringify(arr, null, 2);
      saveSettings();
      $('#sg_quickOptionsJson').val(s.quickOptionsJson);
      setStatus('快捷选项已应用并保存 ✅', 'ok');
    } catch (e) {
      setStatus(`快捷选项 JSON 解析失败：${e?.message ?? e}`, 'err');
    }
  });
}

function showSettingsPage(page) {
  const p = String(page || 'guide');
  $('#sg_pgtab_guide, #sg_pgtab_summary, #sg_pgtab_index, #sg_pgtab_roll').removeClass('active');
  $('#sg_page_guide, #sg_page_summary, #sg_page_index, #sg_page_roll').removeClass('active');

  if (p === 'summary') {
    $('#sg_pgtab_summary').addClass('active');
    $('#sg_page_summary').addClass('active');
  } else if (p === 'index') {
    $('#sg_pgtab_index').addClass('active');
    $('#sg_page_index').addClass('active');
  } else if (p === 'roll') {
    $('#sg_pgtab_roll').addClass('active');
    $('#sg_page_roll').addClass('active');
  } else {
    $('#sg_pgtab_guide').addClass('active');
    $('#sg_page_guide').addClass('active');
  }

  // 切页后回到顶部，避免“看不到设置项”
  try { $('.sg-left').scrollTop(0); } catch { }
}

function setupSettingsPages() {
  // 把“索引设置块”从总结页移到索引页（保留内部所有控件 id，不影响事件绑定）
  try {
    const $mount = $('#sg_index_mount');
    const $idxWrapper = $('#sg_wiTriggerEnabled').closest('.sg-card.sg-subcard');
    if ($mount.length && $idxWrapper.length) {
      $mount.append($idxWrapper.children());
      $idxWrapper.remove();
    }
  } catch { /* ignore */ }

  // ROLL 设置已直接内嵌在 sg_page_roll 中，无需移动

  // tabs
  $('#sg_pgtab_guide').on('click', () => showSettingsPage('guide'));
  $('#sg_pgtab_summary').on('click', () => showSettingsPage('summary'));
  $('#sg_pgtab_index').on('click', () => showSettingsPage('index'));
  $('#sg_pgtab_roll').on('click', () => showSettingsPage('roll'));

  // quick jump
  $('#sg_gotoIndexPage').on('click', () => showSettingsPage('index'));
  $('#sg_gotoRollPage').on('click', () => showSettingsPage('roll'));
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

  $('#sg_inlineModulesSource').val(String(s.inlineModulesSource || 'inline'));
  $('#sg_inlineShowEmpty').prop('checked', !!s.inlineShowEmpty);

  $('#sg_customEndpoint').val(s.customEndpoint);
  $('#sg_customApiKey').val(s.customApiKey);
  $('#sg_customModel').val(s.customModel);

  fillModelSelect(Array.isArray(s.customModelsCache) ? s.customModelsCache : [], s.customModel);

  $('#sg_worldText').val(getChatMetaValue(META_KEYS.world));
  $('#sg_canonText').val(getChatMetaValue(META_KEYS.canon));

  $('#sg_modulesJson').val(String(s.modulesJson || JSON.stringify(DEFAULT_MODULES, null, 2)));
  $('#sg_customSystemPreamble').val(String(s.customSystemPreamble || ''));
  $('#sg_customConstraints').val(String(s.customConstraints || ''));

  // 快捷选项
  $('#sg_quickOptionsEnabled').prop('checked', !!s.quickOptionsEnabled);
  $('#sg_quickOptionsShowIn').val(String(s.quickOptionsShowIn || 'inline'));
  $('#sg_quickOptionsJson').val(String(s.quickOptionsJson || '[]'));

  $('#sg_presetIncludeApiKey').prop('checked', !!s.presetIncludeApiKey);

  $('#sg_worldbookEnabled').prop('checked', !!s.worldbookEnabled);
  $('#sg_worldbookMode').val(String(s.worldbookMode || 'active'));
  $('#sg_worldbookMaxChars').val(s.worldbookMaxChars);
  $('#sg_worldbookWindowMessages').val(s.worldbookWindowMessages);

  updateWorldbookInfoLabel();

  try {
    const count = parseWorldbookJson(String(s.worldbookJson || '')).length;
    $('#sg_worldbookInfo').text(count ? `已导入世界书：${count} 条` : '（未导入世界书）');
  } catch {
    $('#sg_worldbookInfo').text('（未导入世界书）');
  }

  $('#sg_custom_block').toggle(s.provider === 'custom');

  // summary
  $('#sg_summaryEnabled').prop('checked', !!s.summaryEnabled);
  $('#sg_summaryEvery').val(s.summaryEvery);
  $('#sg_summaryManualSplit').prop('checked', !!s.summaryManualSplit);
  $('#sg_summaryCountMode').val(String(s.summaryCountMode || 'assistant'));
  $('#sg_summaryProvider').val(String(s.summaryProvider || 'st'));
  $('#sg_summaryTemperature').val(s.summaryTemperature);
  $('#sg_summarySystemPrompt').val(String(s.summarySystemPrompt || DEFAULT_SUMMARY_SYSTEM_PROMPT));
  $('#sg_summaryUserTemplate').val(String(s.summaryUserTemplate || DEFAULT_SUMMARY_USER_TEMPLATE));
  $('#sg_summaryReadStatData').prop('checked', !!s.summaryReadStatData);
  $('#sg_summaryStatVarName').val(String(s.summaryStatVarName || 'stat_data'));
  $('#sg_structuredEntriesEnabled').prop('checked', !!s.structuredEntriesEnabled);
  $('#sg_characterEntriesEnabled').prop('checked', !!s.characterEntriesEnabled);
  $('#sg_equipmentEntriesEnabled').prop('checked', !!s.equipmentEntriesEnabled);
  $('#sg_abilityEntriesEnabled').prop('checked', !!s.abilityEntriesEnabled);
  $('#sg_characterEntryPrefix').val(String(s.characterEntryPrefix || '人物'));
  $('#sg_equipmentEntryPrefix').val(String(s.equipmentEntryPrefix || '装备'));
  $('#sg_abilityEntryPrefix').val(String(s.abilityEntryPrefix || '能力'));
  $('#sg_structuredEntriesSystemPrompt').val(String(s.structuredEntriesSystemPrompt || DEFAULT_STRUCTURED_ENTRIES_SYSTEM_PROMPT));
  $('#sg_structuredEntriesUserTemplate').val(String(s.structuredEntriesUserTemplate || DEFAULT_STRUCTURED_ENTRIES_USER_TEMPLATE));
  $('#sg_structuredCharacterPrompt').val(String(s.structuredCharacterPrompt || DEFAULT_STRUCTURED_CHARACTER_PROMPT));
  $('#sg_structuredEquipmentPrompt').val(String(s.structuredEquipmentPrompt || DEFAULT_STRUCTURED_EQUIPMENT_PROMPT));
  $('#sg_structuredAbilityPrompt').val(String(s.structuredAbilityPrompt || DEFAULT_STRUCTURED_ABILITY_PROMPT));
  $('#sg_summaryCustomEndpoint').val(String(s.summaryCustomEndpoint || ''));
  $('#sg_summaryCustomApiKey').val(String(s.summaryCustomApiKey || ''));
  $('#sg_summaryCustomModel').val(String(s.summaryCustomModel || ''));
  fillSummaryModelSelect(Array.isArray(s.summaryCustomModelsCache) ? s.summaryCustomModelsCache : [], String(s.summaryCustomModel || ''));
  $('#sg_summaryCustomMaxTokens').val(s.summaryCustomMaxTokens || 2048);
  $('#sg_summaryCustomStream').prop('checked', !!s.summaryCustomStream);
  $('#sg_summaryToWorldInfo').prop('checked', !!s.summaryToWorldInfo);
  $('#sg_summaryWorldInfoTarget').val(String(s.summaryWorldInfoTarget || 'chatbook'));
  $('#sg_summaryWorldInfoFile').val(String(s.summaryWorldInfoFile || ''));
  $('#sg_summaryWorldInfoCommentPrefix').val(String(s.summaryWorldInfoCommentPrefix || '剧情总结'));
  $('#sg_summaryWorldInfoKeyMode').val(String(s.summaryWorldInfoKeyMode || 'keywords'));
  $('#sg_summaryIndexPrefix').val(String(s.summaryIndexPrefix || 'A-'));
  $('#sg_summaryIndexPad').val(s.summaryIndexPad ?? 3);
  $('#sg_summaryIndexStart').val(s.summaryIndexStart ?? 1);
  $('#sg_summaryIndexInComment').prop('checked', !!s.summaryIndexInComment);
  $('#sg_summaryToBlueWorldInfo').prop('checked', !!s.summaryToBlueWorldInfo);
  $('#sg_summaryBlueWorldInfoFile').val(String(s.summaryBlueWorldInfoFile || ''));

  // 自动绑定世界书
  $('#sg_autoBindWorldInfo').prop('checked', !!s.autoBindWorldInfo);
  $('#sg_autoBindWorldInfoPrefix').val(String(s.autoBindWorldInfoPrefix || 'SG'));
  updateAutoBindUI();

  // 地图功能
  $('#sg_mapEnabled').prop('checked', !!s.mapEnabled);
  $('#sg_mapSystemPrompt').val(String(s.mapSystemPrompt || DEFAULT_SETTINGS.mapSystemPrompt || ''));
  setTimeout(() => updateMapPreview(), 100);

  $('#sg_wiTriggerEnabled').prop('checked', !!s.wiTriggerEnabled);
  $('#sg_wiTriggerLookbackMessages').val(s.wiTriggerLookbackMessages || 20);
  $('#sg_wiTriggerIncludeUserMessage').prop('checked', !!s.wiTriggerIncludeUserMessage);
  $('#sg_wiTriggerUserMessageWeight').val(s.wiTriggerUserMessageWeight ?? 1.6);
  $('#sg_wiTriggerStartAfterAssistantMessages').val(s.wiTriggerStartAfterAssistantMessages || 0);
  $('#sg_wiTriggerMaxEntries').val(s.wiTriggerMaxEntries || 4);
  $('#sg_wiTriggerMaxCharacters').val(s.wiTriggerMaxCharacters ?? 2);
  $('#sg_wiTriggerMaxEquipments').val(s.wiTriggerMaxEquipments ?? 2);
  $('#sg_wiTriggerMaxPlot').val(s.wiTriggerMaxPlot ?? 3);
  $('#sg_wiTriggerMinScore').val(s.wiTriggerMinScore ?? 0.08);
  $('#sg_wiTriggerMaxKeywords').val(s.wiTriggerMaxKeywords || 24);
  $('#sg_wiTriggerInjectStyle').val(String(s.wiTriggerInjectStyle || 'hidden'));
  $('#sg_wiTriggerDebugLog').prop('checked', !!s.wiTriggerDebugLog);

  $('#sg_wiRollEnabled').prop('checked', !!s.wiRollEnabled);
  $('#sg_wiRollStatSource').val(String(s.wiRollStatSource || 'variable'));
  $('#sg_wiRollStatVarName').val(String(s.wiRollStatVarName || 'stat_data'));
  $('#sg_wiRollRandomWeight').val(s.wiRollRandomWeight ?? 0.3);
  $('#sg_wiRollDifficulty').val(String(s.wiRollDifficulty || 'normal'));
  $('#sg_wiRollInjectStyle').val(String(s.wiRollInjectStyle || 'hidden'));
  $('#sg_wiRollDebugLog').prop('checked', !!s.wiRollDebugLog);
  $('#sg_wiRollStatParseMode').val(String(s.wiRollStatParseMode || 'json'));
  $('#sg_wiRollProvider').val(String(s.wiRollProvider || 'custom'));
  $('#sg_wiRollCustomEndpoint').val(String(s.wiRollCustomEndpoint || ''));
  $('#sg_wiRollCustomApiKey').val(String(s.wiRollCustomApiKey || ''));
  $('#sg_wiRollCustomModel').val(String(s.wiRollCustomModel || 'gpt-4o-mini'));
  $('#sg_wiRollCustomMaxTokens').val(s.wiRollCustomMaxTokens || 512);
  $('#sg_wiRollCustomTopP').val(s.wiRollCustomTopP ?? 0.95);
  $('#sg_wiRollCustomTemperature').val(s.wiRollCustomTemperature ?? 0.2);
  $('#sg_wiRollCustomStream').prop('checked', !!s.wiRollCustomStream);
  $('#sg_wiRollSystemPrompt').val(String(s.wiRollSystemPrompt || DEFAULT_ROLL_SYSTEM_PROMPT));
  $('#sg_roll_custom_block').toggle(String(s.wiRollProvider || 'custom') === 'custom');

  $('#sg_wiTriggerMatchMode').val(String(s.wiTriggerMatchMode || 'local'));
  $('#sg_wiIndexPrefilterTopK').val(s.wiIndexPrefilterTopK ?? 24);
  $('#sg_wiIndexProvider').val(String(s.wiIndexProvider || 'st'));
  $('#sg_wiIndexTemperature').val(s.wiIndexTemperature ?? 0.2);
  $('#sg_wiIndexSystemPrompt').val(String(s.wiIndexSystemPrompt || DEFAULT_INDEX_SYSTEM_PROMPT));
  $('#sg_wiIndexUserTemplate').val(String(s.wiIndexUserTemplate || DEFAULT_INDEX_USER_TEMPLATE));
  $('#sg_wiIndexCustomEndpoint').val(String(s.wiIndexCustomEndpoint || ''));
  $('#sg_wiIndexCustomApiKey').val(String(s.wiIndexCustomApiKey || ''));
  $('#sg_wiIndexCustomModel').val(String(s.wiIndexCustomModel || 'gpt-4o-mini'));
  $('#sg_wiIndexCustomMaxTokens').val(s.wiIndexCustomMaxTokens || 1024);
  $('#sg_wiIndexTopP').val(s.wiIndexTopP ?? 0.95);
  $('#sg_wiIndexCustomStream').prop('checked', !!s.wiIndexCustomStream);
  fillIndexModelSelect(Array.isArray(s.wiIndexCustomModelsCache) ? s.wiIndexCustomModelsCache : [], s.wiIndexCustomModel);

  const mm = String(s.wiTriggerMatchMode || 'local');
  $('#sg_index_llm_block').toggle(mm === 'llm');
  $('#sg_index_custom_block').toggle(mm === 'llm' && String(s.wiIndexProvider || 'st') === 'custom');

  $('#sg_wiBlueIndexMode').val(String(s.wiBlueIndexMode || 'live'));
  $('#sg_wiBlueIndexFile').val(String(s.wiBlueIndexFile || ''));
  $('#sg_summaryMaxChars').val(s.summaryMaxCharsPerMessage || 4000);
  $('#sg_summaryMaxTotalChars').val(s.summaryMaxTotalChars || 24000);

  $('#sg_summary_custom_block').toggle(String(s.summaryProvider || 'st') === 'custom');
  $('#sg_summaryWorldInfoFile').toggle(String(s.summaryWorldInfoTarget || 'chatbook') === 'file');
  $('#sg_summaryBlueWorldInfoFile').toggle(!!s.summaryToBlueWorldInfo);
  $('#sg_summaryIndexFormat').toggle(String(s.summaryWorldInfoKeyMode || 'keywords') === 'indexId');

  updateBlueIndexInfoLabel();

  updateSummaryInfoLabel();
  renderSummaryPaneFromMeta();
  renderWiTriggerLogs();
  renderRollLogs();

  updateButtonsEnabled();
}

function updateBlueIndexInfoLabel() {
  const $info = $('#sg_blueIndexInfo');
  if (!$info.length) return;
  const s = ensureSettings();
  const count = Array.isArray(s.summaryBlueIndex) ? s.summaryBlueIndex.length : 0;
  const mode = String(s.wiBlueIndexMode || 'live');
  if (mode === 'live') {
    const file = pickBlueIndexFileName();
    const ts = blueIndexLiveCache?.loadedAt ? new Date(Number(blueIndexLiveCache.loadedAt)).toLocaleTimeString() : '';
    const err = String(blueIndexLiveCache?.lastError || '').trim();
    const errShort = err ? err.replace(/\s+/g, ' ').slice(0, 60) + (err.length > 60 ? '…' : '') : '';
    $info.text(`（蓝灯索引：${count} 条｜实时：${file || '未设置'}${ts ? `｜更新：${ts}` : ''}${errShort ? `｜读取失败：${errShort}` : ''}）`);
  } else {
    $info.text(`（蓝灯索引：${count} 条｜缓存）`);
  }
}

// -------------------- wiTrigger logs (per chat meta) --------------------

function formatTimeShort(ts) {
  try {
    const d = new Date(Number(ts) || Date.now());
    return d.toLocaleTimeString();
  } catch {
    return '';
  }
}

function renderWiTriggerLogs(metaOverride = null) {
  const $box = $('#sg_wiLogs');
  if (!$box.length) return;
  const meta = metaOverride || getSummaryMeta();
  const logs = Array.isArray(meta?.wiTriggerLogs) ? meta.wiTriggerLogs : [];
  if (!logs.length) {
    $box.html('<div class="sg-hint">(暂无)</div>');
    return;
  }

  const shown = logs.slice(0, 30);
  const html = shown.map((l) => {
    const ts = formatTimeShort(l.ts);
    const skipped = l.skipped === true;
    const picked = Array.isArray(l.picked) ? l.picked : [];
    const titles = picked.map(x => String(x?.title || '').trim()).filter(Boolean);
    const titleShort = titles.length
      ? (titles.slice(0, 4).join('；') + (titles.length > 4 ? '…' : ''))
      : '（无命中条目）';
    const user = String(l.userText || '').replace(/\s+/g, ' ').trim();
    const userShort = user ? (user.slice(0, 120) + (user.length > 120 ? '…' : '')) : '';
    const kws = Array.isArray(l.injectedKeywords) ? l.injectedKeywords : [];
    const kwsShort = kws.length ? (kws.slice(0, 20).join('、') + (kws.length > 20 ? '…' : '')) : '';

    if (skipped) {
      const assistantFloors = Number(l.assistantFloors || 0);
      const startAfter = Number(l.startAfter || 0);
      const reasonKey = String(l.skippedReason || '').trim();
      const reasonText = reasonKey === 'minAssistantFloors'
        ? `AI 回复楼层不足（${assistantFloors}/${startAfter}）`
        : (reasonKey || '跳过');
      const detailsLines = [];
      if (userShort) detailsLines.push(`<div><b>用户输入</b>：${escapeHtml(userShort)}</div>`);
      detailsLines.push(`<div><b>未触发</b>：${escapeHtml(reasonText)}</div>`);
      return `
      <details>
        <summary>${escapeHtml(`${ts}｜未触发：${reasonText}`)}</summary>
        <div class="sg-log-body">${detailsLines.join('')}</div>
      </details>
    `;
    }

    const detailsLines = [];
    if (userShort) detailsLines.push(`<div><b>用户输入</b>：${escapeHtml(userShort)}</div>`);
    detailsLines.push(`<div><b>将触发绿灯条目</b>：${escapeHtml(titles.join('；') || '（无）')}</div>`);
    detailsLines.push(`<div><b>注入触发词</b>：${escapeHtml(kwsShort || '（无）')}</div>`);
    if (picked.length) {
      const scored = picked.map(x => `${String(x.title || '').trim()}（${Number(x.score || 0).toFixed(2)}）`).join('；');
      detailsLines.push(`<div class="sg-hint">相似度：${escapeHtml(scored)}</div>`);
    }
    return `
      <details>
        <summary>${escapeHtml(`${ts}｜命中${titles.length}条：${titleShort}`)}</summary>
        <div class="sg-log-body">${detailsLines.join('')}</div>
      </details>
    `;
  }).join('');

  $box.html(html);
}

function appendWiTriggerLog(log) {
  try {
    const meta = getSummaryMeta();
    const arr = Array.isArray(meta.wiTriggerLogs) ? meta.wiTriggerLogs : [];
    arr.unshift(log);
    meta.wiTriggerLogs = arr.slice(0, 50);
    // 不 await：避免阻塞 MESSAGE_SENT
    setSummaryMeta(meta).catch(() => void 0);
    if ($('#sg_modal_backdrop').is(':visible')) renderWiTriggerLogs(meta);
  } catch { /* ignore */ }
}

function renderRollLogs(metaOverride = null) {
  const $box = $('#sg_rollLogs');
  if (!$box.length) return;
  const meta = metaOverride || getSummaryMeta();
  const logs = Array.isArray(meta?.rollLogs) ? meta.rollLogs : [];
  if (!logs.length) {
    $box.html('(暂无)');
    return;
  }
  const shown = logs.slice(0, 30);
  const html = shown.map((l) => {
    const ts = l?.ts ? new Date(l.ts).toLocaleString() : '';
    const action = String(l?.action || '').trim();
    const outcome = String(l?.outcomeTier || '').trim()
      || (l?.success == null ? 'N/A' : (l.success ? '成功' : '失败'));
    const finalVal = Number.isFinite(Number(l?.final)) ? Number(l.final).toFixed(2) : '';
    let summary = '';
    if (l?.summary && typeof l.summary === 'object') {
      const pick = l.summary.summary ?? l.summary.text ?? l.summary.message;
      summary = String(pick || '').trim();
      if (!summary) {
        try { summary = JSON.stringify(l.summary); } catch { summary = String(l.summary); }
      }
    } else {
      summary = String(l?.summary || '').trim();
    }
    const userShort = String(l?.userText || '').trim().slice(0, 160);

    const detailsLines = [];
    if (userShort) detailsLines.push(`<div><b>用户输入</b>：${escapeHtml(userShort)}</div>`);
    if (summary) detailsLines.push(`<div><b>摘要</b>：${escapeHtml(summary)}</div>`);
    return `
      <details>
        <summary>${escapeHtml(`${ts}｜${action || 'ROLL'}｜${outcome}${finalVal ? `｜最终=${finalVal}` : ''}`)}</summary>
        <div class="sg-log-body">${detailsLines.join('')}</div>
      </details>
    `;
  }).join('');
  $box.html(html);
}

function appendRollLog(log) {
  try {
    const meta = getSummaryMeta();
    const arr = Array.isArray(meta.rollLogs) ? meta.rollLogs : [];
    arr.unshift(log);
    meta.rollLogs = arr.slice(0, 50);
    setSummaryMeta(meta).catch(() => void 0);
    if ($('#sg_modal_backdrop').is(':visible')) renderRollLogs(meta);
  } catch { /* ignore */ }
}

function updateWorldbookInfoLabel() {
  const s = ensureSettings();
  const $info = $('#sg_worldbookInfo');
  if (!$info.length) return;

  try {
    if (!s.worldbookJson) {
      $info.text('（未导入世界书）');
      return;
    }
    const stats = computeWorldbookInjection();
    const base = `已导入世界书：${stats.importedEntries} 条`;
    if (!s.worldbookEnabled) {
      $info.text(`${base}（未启用注入）`);
      return;
    }
    if (stats.mode === 'active' && stats.selectedEntries === 0) {
      $info.text(`${base}｜模式：active｜本次无条目命中（0 条）`);
      return;
    }
    $info.text(`${base}｜模式：${stats.mode}｜本次注入：${stats.injectedEntries} 条｜字符：${stats.injectedChars}｜约 tokens：${stats.injectedTokens}`);
  } catch {
    $info.text('（世界书信息解析失败）');
  }
}

function formatSummaryMetaHint(meta) {
  const last = Number(meta?.lastFloor || 0);
  const count = Array.isArray(meta?.history) ? meta.history.length : 0;
  if (!last && !count) return '（未生成）';
  return `已生成 ${count} 次｜上次触发层：${last}`;
}

function updateSummaryInfoLabel() {
  const $info = $('#sg_summaryInfo');
  if (!$info.length) return;
  try {
    const meta = getSummaryMeta();
    $info.text(formatSummaryMetaHint(meta));
  } catch {
    $info.text('（总结状态解析失败）');
  }
}


function updateSummaryManualRangeHint(setDefaults = false) {
  const $hint = $('#sg_summaryManualHint');
  if (!$hint.length) return;

  try {
    const s = ensureSettings();
    const ctx = SillyTavern.getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const mode = String(s.summaryCountMode || 'assistant');
    const floorNow = computeFloorCount(chat, mode);
    const every = clampInt(s.summaryEvery, 1, 200, 20);

    // Optional: show how many entries would be generated when manual split is enabled.
    const $from = $('#sg_summaryManualFrom');
    const $to = $('#sg_summaryManualTo');
    let extra = '';
    if (s.summaryManualSplit) {
      const fromVal0 = String($from.val() ?? '').trim();
      const toVal0 = String($to.val() ?? '').trim();
      const fromN = Number(fromVal0);
      const toN = Number(toVal0);
      if (Number.isFinite(fromN) && Number.isFinite(toN) && fromN > 0 && toN > 0 && floorNow > 0) {
        const a = clampInt(fromN, 1, floorNow, 1);
        const b = clampInt(toN, 1, floorNow, floorNow);
        const len = Math.abs(b - a) + 1;
        const pieces = Math.max(1, Math.ceil(len / every));
        extra = `｜分段：${pieces} 条（每${every}层）`;
      } else {
        extra = `｜分段：每${every}层一条`;
      }
    }

    $hint.text(`（可选范围：1-${floorNow || 0}${extra}）`);
    if (!$from.length || !$to.length) return;

    const fromVal = String($from.val() ?? '').trim();
    const toVal = String($to.val() ?? '').trim();

    if (setDefaults && floorNow > 0 && (!fromVal || !toVal)) {
      const a = Math.max(1, floorNow - every + 1);
      $from.val(a);
      $to.val(floorNow);
    }
  } catch {
    $hint.text('（可选范围：?）');
  }
}

function renderSummaryPaneFromMeta() {
  const $el = $('#sg_sum');
  if (!$el.length) return;

  const meta = getSummaryMeta();
  const hist = Array.isArray(meta.history) ? meta.history : [];

  if (!hist.length) {
    lastSummary = null;
    lastSummaryText = '';
    $el.html('(尚未生成)');
    updateButtonsEnabled();
    return;
  }

  const last = hist[hist.length - 1];
  lastSummary = last;
  lastSummaryText = String(last?.summary || '');

  const md = hist.slice(-12).reverse().map((h, idx) => {
    const title = String(h.title || `${ensureSettings().summaryWorldInfoCommentPrefix || '剧情总结'} #${hist.length - idx}`);
    const kws = Array.isArray(h.keywords) ? h.keywords : [];
    const when = h.createdAt ? new Date(h.createdAt).toLocaleString() : '';
    const range = h?.range ? `（${h.range.fromFloor}-${h.range.toFloor}）` : '';
    return `### ${title} ${range}\n\n- 时间：${when}\n- 关键词：${kws.join('、') || '（无）'}\n\n${h.summary || ''}`;
  }).join('\n\n---\n\n');

  renderMarkdownInto($el, md);
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

  s.inlineModulesSource = String($('#sg_inlineModulesSource').val() || 'inline');
  s.inlineShowEmpty = $('#sg_inlineShowEmpty').is(':checked');

  s.customEndpoint = String($('#sg_customEndpoint').val() || '').trim();
  s.customApiKey = String($('#sg_customApiKey').val() || '');
  s.customModel = String($('#sg_customModel').val() || '').trim();
  s.customMaxTokens = clampInt($('#sg_customMaxTokens').val(), 256, 200000, s.customMaxTokens || 8192);
  s.customStream = $('#sg_customStream').is(':checked');

  // modulesJson：先不强行校验（用户可先保存再校验），但会在分析前用默认兜底
  s.modulesJson = String($('#sg_modulesJson').val() || '').trim() || JSON.stringify(DEFAULT_MODULES, null, 2);

  s.customSystemPreamble = String($('#sg_customSystemPreamble').val() || '');
  s.customConstraints = String($('#sg_customConstraints').val() || '');

  // 快捷选项写入
  s.quickOptionsEnabled = $('#sg_quickOptionsEnabled').is(':checked');
  s.quickOptionsShowIn = String($('#sg_quickOptionsShowIn').val() || 'inline');
  s.quickOptionsJson = String($('#sg_quickOptionsJson').val() || '[]');

  s.presetIncludeApiKey = $('#sg_presetIncludeApiKey').is(':checked');

  s.worldbookEnabled = $('#sg_worldbookEnabled').is(':checked');
  s.worldbookMode = String($('#sg_worldbookMode').val() || 'active');
  s.worldbookMaxChars = clampInt($('#sg_worldbookMaxChars').val(), 500, 50000, s.worldbookMaxChars || 6000);
  s.worldbookWindowMessages = clampInt($('#sg_worldbookWindowMessages').val(), 5, 80, s.worldbookWindowMessages || 18);

  // summary
  s.summaryEnabled = $('#sg_summaryEnabled').is(':checked');
  s.summaryEvery = clampInt($('#sg_summaryEvery').val(), 1, 200, s.summaryEvery || 20);
  s.summaryManualSplit = $('#sg_summaryManualSplit').is(':checked');
  s.summaryCountMode = String($('#sg_summaryCountMode').val() || 'assistant');
  s.summaryProvider = String($('#sg_summaryProvider').val() || 'st');
  s.summaryTemperature = clampFloat($('#sg_summaryTemperature').val(), 0, 2, s.summaryTemperature || 0.4);
  s.summarySystemPrompt = String($('#sg_summarySystemPrompt').val() || '').trim() || DEFAULT_SUMMARY_SYSTEM_PROMPT;
  s.summaryUserTemplate = String($('#sg_summaryUserTemplate').val() || '').trim() || DEFAULT_SUMMARY_USER_TEMPLATE;
  s.summaryReadStatData = $('#sg_summaryReadStatData').is(':checked');
  s.summaryStatVarName = String($('#sg_summaryStatVarName').val() || 'stat_data').trim() || 'stat_data';
  s.structuredEntriesEnabled = $('#sg_structuredEntriesEnabled').is(':checked');
  s.characterEntriesEnabled = $('#sg_characterEntriesEnabled').is(':checked');
  s.equipmentEntriesEnabled = $('#sg_equipmentEntriesEnabled').is(':checked');
  s.abilityEntriesEnabled = $('#sg_abilityEntriesEnabled').is(':checked');
  s.characterEntryPrefix = String($('#sg_characterEntryPrefix').val() || '人物').trim() || '人物';
  s.equipmentEntryPrefix = String($('#sg_equipmentEntryPrefix').val() || '装备').trim() || '装备';
  s.abilityEntryPrefix = String($('#sg_abilityEntryPrefix').val() || '能力').trim() || '能力';
  s.structuredEntriesSystemPrompt = String($('#sg_structuredEntriesSystemPrompt').val() || '').trim() || DEFAULT_STRUCTURED_ENTRIES_SYSTEM_PROMPT;
  s.structuredEntriesUserTemplate = String($('#sg_structuredEntriesUserTemplate').val() || '').trim() || DEFAULT_STRUCTURED_ENTRIES_USER_TEMPLATE;
  s.structuredCharacterPrompt = String($('#sg_structuredCharacterPrompt').val() || '').trim() || DEFAULT_STRUCTURED_CHARACTER_PROMPT;
  s.structuredEquipmentPrompt = String($('#sg_structuredEquipmentPrompt').val() || '').trim() || DEFAULT_STRUCTURED_EQUIPMENT_PROMPT;
  s.structuredAbilityPrompt = String($('#sg_structuredAbilityPrompt').val() || '').trim() || DEFAULT_STRUCTURED_ABILITY_PROMPT;
  s.summaryCustomEndpoint = String($('#sg_summaryCustomEndpoint').val() || '').trim();
  s.summaryCustomApiKey = String($('#sg_summaryCustomApiKey').val() || '');
  s.summaryCustomModel = String($('#sg_summaryCustomModel').val() || '').trim() || 'gpt-4o-mini';
  s.summaryCustomMaxTokens = clampInt($('#sg_summaryCustomMaxTokens').val(), 128, 200000, s.summaryCustomMaxTokens || 2048);
  s.summaryCustomStream = $('#sg_summaryCustomStream').is(':checked');
  s.summaryToWorldInfo = $('#sg_summaryToWorldInfo').is(':checked');
  s.summaryWorldInfoTarget = String($('#sg_summaryWorldInfoTarget').val() || 'chatbook');
  s.summaryWorldInfoFile = String($('#sg_summaryWorldInfoFile').val() || '').trim();
  s.summaryWorldInfoCommentPrefix = String($('#sg_summaryWorldInfoCommentPrefix').val() || '剧情总结').trim() || '剧情总结';
  s.summaryWorldInfoKeyMode = String($('#sg_summaryWorldInfoKeyMode').val() || 'keywords');
  s.summaryIndexPrefix = String($('#sg_summaryIndexPrefix').val() || 'A-').trim() || 'A-';
  s.summaryIndexPad = clampInt($('#sg_summaryIndexPad').val(), 1, 12, s.summaryIndexPad ?? 3);
  s.summaryIndexStart = clampInt($('#sg_summaryIndexStart').val(), 1, 1000000, s.summaryIndexStart ?? 1);
  s.summaryIndexInComment = $('#sg_summaryIndexInComment').is(':checked');
  s.summaryToBlueWorldInfo = $('#sg_summaryToBlueWorldInfo').is(':checked');
  s.summaryBlueWorldInfoFile = String($('#sg_summaryBlueWorldInfoFile').val() || '').trim();

  // 自动绑定世界书
  s.autoBindWorldInfo = $('#sg_autoBindWorldInfo').is(':checked');
  s.autoBindWorldInfoPrefix = String($('#sg_autoBindWorldInfoPrefix').val() || 'SG').trim() || 'SG';

  // 地图功能
  s.mapEnabled = $('#sg_mapEnabled').is(':checked');
  s.mapSystemPrompt = String($('#sg_mapSystemPrompt').val() || '').trim() || DEFAULT_SETTINGS.mapSystemPrompt;

  s.wiTriggerEnabled = $('#sg_wiTriggerEnabled').is(':checked');
  s.wiTriggerLookbackMessages = clampInt($('#sg_wiTriggerLookbackMessages').val(), 5, 120, s.wiTriggerLookbackMessages || 20);
  s.wiTriggerIncludeUserMessage = $('#sg_wiTriggerIncludeUserMessage').is(':checked');
  s.wiTriggerUserMessageWeight = clampFloat($('#sg_wiTriggerUserMessageWeight').val(), 0, 10, s.wiTriggerUserMessageWeight ?? 1.6);
  s.wiTriggerStartAfterAssistantMessages = clampInt($('#sg_wiTriggerStartAfterAssistantMessages').val(), 0, 200000, s.wiTriggerStartAfterAssistantMessages || 0);
  s.wiTriggerMaxEntries = clampInt($('#sg_wiTriggerMaxEntries').val(), 1, 20, s.wiTriggerMaxEntries || 4);
  s.wiTriggerMaxCharacters = clampInt($('#sg_wiTriggerMaxCharacters').val(), 0, 10, s.wiTriggerMaxCharacters ?? 2);
  s.wiTriggerMaxEquipments = clampInt($('#sg_wiTriggerMaxEquipments').val(), 0, 10, s.wiTriggerMaxEquipments ?? 2);
  s.wiTriggerMaxPlot = clampInt($('#sg_wiTriggerMaxPlot').val(), 0, 10, s.wiTriggerMaxPlot ?? 3);
  s.wiTriggerMinScore = clampFloat($('#sg_wiTriggerMinScore').val(), 0, 1, (s.wiTriggerMinScore ?? 0.08));
  s.wiTriggerMaxKeywords = clampInt($('#sg_wiTriggerMaxKeywords').val(), 1, 200, s.wiTriggerMaxKeywords || 24);
  s.wiTriggerInjectStyle = String($('#sg_wiTriggerInjectStyle').val() || s.wiTriggerInjectStyle || 'hidden');
  s.wiTriggerDebugLog = $('#sg_wiTriggerDebugLog').is(':checked');

  s.wiRollEnabled = $('#sg_wiRollEnabled').is(':checked');
  s.wiRollStatSource = String($('#sg_wiRollStatSource').val() || s.wiRollStatSource || 'variable');
  s.wiRollStatVarName = String($('#sg_wiRollStatVarName').val() || s.wiRollStatVarName || 'stat_data').trim();
  s.wiRollRandomWeight = clampFloat($('#sg_wiRollRandomWeight').val(), 0, 1, s.wiRollRandomWeight ?? 0.3);
  s.wiRollDifficulty = String($('#sg_wiRollDifficulty').val() || s.wiRollDifficulty || 'normal');
  s.wiRollInjectStyle = String($('#sg_wiRollInjectStyle').val() || s.wiRollInjectStyle || 'hidden');
  s.wiRollDebugLog = $('#sg_wiRollDebugLog').is(':checked');
  s.wiRollStatParseMode = String($('#sg_wiRollStatParseMode').val() || s.wiRollStatParseMode || 'json');
  s.wiRollProvider = String($('#sg_wiRollProvider').val() || s.wiRollProvider || 'custom');
  s.wiRollCustomEndpoint = String($('#sg_wiRollCustomEndpoint').val() || s.wiRollCustomEndpoint || '').trim();
  s.wiRollCustomApiKey = String($('#sg_wiRollCustomApiKey').val() || s.wiRollCustomApiKey || '');
  s.wiRollCustomModel = String($('#sg_wiRollCustomModel').val() || s.wiRollCustomModel || 'gpt-4o-mini');
  s.wiRollCustomMaxTokens = clampInt($('#sg_wiRollCustomMaxTokens').val(), 128, 200000, s.wiRollCustomMaxTokens || 512);
  s.wiRollCustomTopP = clampFloat($('#sg_wiRollCustomTopP').val(), 0, 1, s.wiRollCustomTopP ?? 0.95);
  s.wiRollCustomTemperature = clampFloat($('#sg_wiRollCustomTemperature').val(), 0, 2, s.wiRollCustomTemperature ?? 0.2);
  s.wiRollCustomStream = $('#sg_wiRollCustomStream').is(':checked');
  s.wiRollSystemPrompt = String($('#sg_wiRollSystemPrompt').val() || '').trim() || DEFAULT_ROLL_SYSTEM_PROMPT;

  s.wiTriggerMatchMode = String($('#sg_wiTriggerMatchMode').val() || s.wiTriggerMatchMode || 'local');
  s.wiIndexPrefilterTopK = clampInt($('#sg_wiIndexPrefilterTopK').val(), 5, 80, s.wiIndexPrefilterTopK ?? 24);
  s.wiIndexProvider = String($('#sg_wiIndexProvider').val() || s.wiIndexProvider || 'st');
  s.wiIndexTemperature = clampFloat($('#sg_wiIndexTemperature').val(), 0, 2, s.wiIndexTemperature ?? 0.2);
  s.wiIndexSystemPrompt = String($('#sg_wiIndexSystemPrompt').val() || s.wiIndexSystemPrompt || DEFAULT_INDEX_SYSTEM_PROMPT);
  s.wiIndexUserTemplate = String($('#sg_wiIndexUserTemplate').val() || s.wiIndexUserTemplate || DEFAULT_INDEX_USER_TEMPLATE);
  s.wiIndexCustomEndpoint = String($('#sg_wiIndexCustomEndpoint').val() || s.wiIndexCustomEndpoint || '');
  s.wiIndexCustomApiKey = String($('#sg_wiIndexCustomApiKey').val() || s.wiIndexCustomApiKey || '');
  s.wiIndexCustomModel = String($('#sg_wiIndexCustomModel').val() || s.wiIndexCustomModel || 'gpt-4o-mini');
  s.wiIndexCustomMaxTokens = clampInt($('#sg_wiIndexCustomMaxTokens').val(), 128, 200000, s.wiIndexCustomMaxTokens || 1024);
  s.wiIndexTopP = clampFloat($('#sg_wiIndexTopP').val(), 0, 1, s.wiIndexTopP ?? 0.95);
  s.wiIndexCustomStream = $('#sg_wiIndexCustomStream').is(':checked');

  s.wiBlueIndexMode = String($('#sg_wiBlueIndexMode').val() || s.wiBlueIndexMode || 'live');
  s.wiBlueIndexFile = String($('#sg_wiBlueIndexFile').val() || '').trim();
  s.summaryMaxCharsPerMessage = clampInt($('#sg_summaryMaxChars').val(), 200, 8000, s.summaryMaxCharsPerMessage || 4000);
  s.summaryMaxTotalChars = clampInt($('#sg_summaryMaxTotalChars').val(), 2000, 80000, s.summaryMaxTotalChars || 24000);
}

function openModal() {
  ensureModal();
  pullSettingsToUi();
  updateWorldbookInfoLabel();
  updateSummaryManualRangeHint(true);
  // 打开面板时尝试刷新一次蓝灯索引（不阻塞 UI）
  ensureBlueIndexLive(false).catch(() => void 0);
  setStatus('', '');
  $('#sg_modal_backdrop').show();
  showPane('md');
}
function closeModal() { $('#sg_modal_backdrop').hide(); }

function injectMinimalSettingsPanel() {
  const $root = $('#extensions_settings');
  if (!$root.length) return;
  if ($('#sg_settings_panel_min').length) return;

  $root.append(`
    <div class="sg-panel-min" id="sg_settings_panel_min">
      <div class="sg-min-row">
        <div class="sg-min-title">剧情指导 StoryGuide <span class="sg-sub">v${SG_VERSION}</span></div>
        <button class="menu_button sg-btn" id="sg_open_from_settings">打开面板</button>
      </div>
      <div class="sg-min-hint">支持自定义输出模块（JSON），并且自动追加框会缓存+监听重渲染，尽量不被变量更新覆盖。</div>
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

  ensureChatActionButtons();

  scheduleReapplyAll('start');
  installCardZoomDelegation();

  scheduleReapplyAll('start');
}

// -------------------- events --------------------

function setupEventListeners() {
  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    startObservers();

    // 预热蓝灯索引（实时读取模式下），尽量避免第一次发送消息时还没索引
    ensureBlueIndexLive(true).catch(() => void 0);

    eventSource.on(event_types.CHAT_CHANGED, () => {
      inlineCache.clear();
      scheduleReapplyAll('chat_changed');
      ensureChatActionButtons();
      ensureBlueIndexLive(true).catch(() => void 0);
      if (document.getElementById('sg_modal_backdrop') && $('#sg_modal_backdrop').is(':visible')) {
        pullSettingsToUi();
        setStatus('已切换聊天：已同步本聊天字段', 'ok');
      }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
      // 禁止自动生成：不在收到消息时自动分析/追加
      scheduleReapplyAll('msg_received');
      // 自动总结（独立功能）
      scheduleAutoSummary('msg_received');
    });

    eventSource.on(event_types.MESSAGE_SENT, () => {
      // 禁止自动生成：不在发送消息时自动刷新面板
      // ROLL 判定（尽量在生成前完成）
      maybeInjectRollResult('msg_sent').catch(() => void 0);
      // 蓝灯索引 → 绿灯触发（尽量在生成前完成）
      maybeInjectWorldInfoTriggers('msg_sent').catch(() => void 0);
      scheduleAutoSummary('msg_sent');
    });
  });
}

// -------------------- 悬浮按钮和面板 --------------------

let floatingPanelVisible = false;
let lastFloatingContent = null;
let sgFloatingResizeGuardBound = false;
let sgFloatingToggleLock = 0;

const SG_FLOATING_BTN_POS_KEY = 'storyguide_floating_btn_pos_v1';
let sgBtnPos = null;

function loadBtnPos() {
  try {
    const raw = localStorage.getItem(SG_FLOATING_BTN_POS_KEY);
    if (raw) sgBtnPos = JSON.parse(raw);
  } catch { }
}

function saveBtnPos(left, top) {
  try {
    sgBtnPos = { left, top };
    localStorage.setItem(SG_FLOATING_BTN_POS_KEY, JSON.stringify(sgBtnPos));
  } catch { }
}

// Sync CSS viewport units for mobile browsers with dynamic bars.
function updateSgVh() {
  const root = document.documentElement;
  if (!root) return;
  const h = window.visualViewport?.height || window.innerHeight || 0;
  if (!h) return;
  root.style.setProperty('--sg-vh', `${h * 0.01}px`);
}

updateSgVh();
window.addEventListener('resize', updateSgVh);
window.addEventListener('orientationchange', updateSgVh);
window.visualViewport?.addEventListener('resize', updateSgVh);

// 检测移动端/平板竖屏模式（禁用自定义定位，使用 CSS 底部弹出样式）
// 匹配 CSS 媒体查询: (max-width: 768px), (max-aspect-ratio: 1/1)
function isMobilePortrait() {
  if (window.matchMedia) {
    return window.matchMedia('(max-width: 768px), (max-aspect-ratio: 1/1)').matches;
  }
  return window.innerWidth <= 768 || (window.innerHeight >= window.innerWidth);
}

function createFloatingButton() {
  if (document.getElementById('sg_floating_btn')) return;

  const btn = document.createElement('div');
  btn.id = 'sg_floating_btn';
  btn.className = 'sg-floating-btn';
  btn.innerHTML = '📘';
  btn.title = '剧情指导';
  // Allow dragging but also clicking. We need to distinguish click from drag.
  btn.style.touchAction = 'none';

  document.body.appendChild(btn);

  // Restore position
  loadBtnPos();
  if (sgBtnPos) {
    const w = 50; // approx width
    const h = 50;
    const clamped = clampToViewport(sgBtnPos.left, sgBtnPos.top, w, h);
    btn.style.left = `${Math.round(clamped.left)}px`;
    btn.style.top = `${Math.round(clamped.top)}px`;
    btn.style.bottom = 'auto';
    btn.style.right = 'auto';
  } else {
    // Default safe position for mobile/desktop if never moved
    // Use top positioning to avoid bottom bar interference on mobile/desktop
    // Mobile browsers often have dynamic bottom bars, so "bottom" is risky.
    btn.style.top = '150px';
    btn.style.right = '16px';
    btn.style.bottom = 'auto'; // override CSS
    btn.style.left = 'auto';
  }

  // --- Unified Interaction Logic ---
  const isMobile = window.innerWidth < 1200;

  // Variables or drag
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  let moved = false;
  let longPressTimer = null; // Legacy

  // Mobile: Simple Click Mode
  if (isMobile) {
    btn.style.cursor = 'pointer';
    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleFloatingPanel();
    };
    return; // SKIP desktop logic
  }
  // Desktop logic continues below...

  const onDown = (ev) => {
    dragging = true;
    moved = false;
    startX = ev.clientX;
    startY = ev.clientY;

    const rect = btn.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    btn.style.transition = 'none';
    btn.setPointerCapture(ev.pointerId);

    // If needed: Visual feedback for press
  };

  const onMove = (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    if (!moved && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      moved = true;
      btn.style.bottom = 'auto';
      btn.style.right = 'auto';
    }

    if (moved) {
      const newLeft = startLeft + dx;
      const newTop = startTop + dy;

      const w = btn.offsetWidth;
      const h = btn.offsetHeight;
      const clamped = clampToViewport(newLeft, newTop, w, h);

      btn.style.left = `${Math.round(clamped.left)}px`;
      btn.style.top = `${Math.round(clamped.top)}px`;
    }
  };

  const onUp = (ev) => {
    if (!dragging) return;
    dragging = false;
    btn.releasePointerCapture(ev.pointerId);
    btn.style.transition = '';

    if (moved) {
      const left = parseInt(btn.style.left || '0', 10);
      const top = parseInt(btn.style.top || '0', 10);
      saveBtnPos(left, top);
    }
  };

  btn.addEventListener('pointerdown', onDown);
  btn.addEventListener('pointermove', onMove);
  btn.addEventListener('pointerup', onUp);
  btn.addEventListener('pointercancel', onUp);

  // Robust click handler
  btn.addEventListener('click', (e) => {
    // If we just dragged, 'moved' might still be true
    if (moved) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    toggleFloatingPanel();
  });
}

function createFloatingPanel() {
  if (document.getElementById('sg_floating_panel')) return;

  const panel = document.createElement('div');
  panel.id = 'sg_floating_panel';
  panel.className = 'sg-floating-panel';
  panel.innerHTML = `
    <div class="sg-floating-header" style="cursor: move; touch-action: none;">
      <span class="sg-floating-title">📘 剧情指导</span>
        <div class="sg-floating-actions">
          <button class="sg-floating-action-btn" id="sg_floating_show_report" title="查看分析">📖</button>
          <button class="sg-floating-action-btn" id="sg_floating_show_map" title="查看地图">🗺️</button>
          <button class="sg-floating-action-btn" id="sg_floating_roll_logs" title="ROLL日志">🎲</button>
          <button class="sg-floating-action-btn" id="sg_floating_settings" title="打开设置">⚙️</button>
          <button class="sg-floating-action-btn" id="sg_floating_close" title="关闭">✕</button>
        </div>
    </div>
    <div class="sg-floating-body" id="sg_floating_body">
      <div style="padding:20px; text-align:center; color:#aaa;">
        点击 <button class="sg-inner-refresh-btn" style="background:none; border:none; cursor:pointer; font-size:1.2em;">🔄</button> 生成
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  // Restore position (Only on Desktop/Large screens, NOT in mobile portrait)
  // On mobile portrait, we rely on CSS defaults (bottom sheet style) to ensure visibility
  if (!isMobilePortrait() && window.innerWidth >= 1200) {
    loadFloatingPanelPos();
    if (sgFloatingPinnedPos) {
      const w = panel.offsetWidth || 300;
      const h = panel.offsetHeight || 400;
      // Use saved position but ensure it is on screen
      const clamped = clampToViewport(sgFloatingPinnedPos.left, sgFloatingPinnedPos.top, w, h);
      panel.style.left = `${Math.round(clamped.left)}px`;
      panel.style.top = `${Math.round(clamped.top)}px`;
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
    }
  }

  // 事件绑定
  $('#sg_floating_close').on('click', () => {
    hideFloatingPanel();
  });

    $('#sg_floating_show_report').on('click', () => {
      showFloatingReport();
    });

    $('#sg_floating_show_map').on('click', () => {
      showFloatingMap();
    });

    // Delegate inner refresh click
    $(document).on('click', '.sg-inner-refresh-btn', async (e) => {
      // Only handle if inside our panel
      if (!$(e.target).closest('#sg_floating_panel').length) return;
      await refreshFloatingPanelContent();
    });

    $(document).on('click', '.sg-inner-map-reset-btn', async (e) => {
      if (!$(e.target).closest('#sg_floating_panel').length) return;
      try {
        await setMapData(getDefaultMapData());
        showFloatingMap();
      } catch (err) {
        console.warn('[StoryGuide] map reset failed:', err);
      }
    });

    $(document).on('click', '.sg-inner-map-toggle-btn', (e) => {
      if (!$(e.target).closest('#sg_floating_panel').length) return;
      const s = ensureSettings();
      s.mapAutoUpdate = !isMapAutoUpdateEnabled(s);
      saveSettings();
      showFloatingMap();
    });

    $('#sg_floating_roll_logs').on('click', () => {
      showFloatingRollLogs();
    });

  $('#sg_floating_settings').on('click', () => {
    openModal();
    hideFloatingPanel();
  });

  // Drag logic
  const header = panel.querySelector('.sg-floating-header');
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  let moved = false;

  const onDown = (ev) => {
    if (ev.target.closest('button')) return; // ignore buttons
    if (isMobilePortrait()) return; // 移动端竖屏禁用拖拽，使用 CSS 底部弹出

    dragging = true;
    startX = ev.clientX;
    startY = ev.clientY;

    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    moved = false;

    panel.style.bottom = 'auto';
    panel.style.right = 'auto';
    panel.style.transition = 'none'; // disable transition during drag

    header.setPointerCapture(ev.pointerId);
  };

  const onMove = (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    if (!moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) moved = true;

    const newLeft = startLeft + dx;
    const newTop = startTop + dy;

    // Constrain to viewport
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const clamped = clampToViewport(newLeft, newTop, w, h);

    panel.style.left = `${Math.round(clamped.left)}px`;
    panel.style.top = `${Math.round(clamped.top)}px`;
  };

  const onUp = (ev) => {
    if (!dragging) return;
    dragging = false;
    header.releasePointerCapture(ev.pointerId);
    panel.style.transition = ''; // restore transition

    if (moved) {
      const left = parseInt(panel.style.left || '0', 10);
      const top = parseInt(panel.style.top || '0', 10);
      saveFloatingPanelPos(left, top);
    }
  };

  header.addEventListener('pointerdown', onDown);
  header.addEventListener('pointermove', onMove);
  header.addEventListener('pointerup', onUp);
  header.addEventListener('pointercancel', onUp);

  // Double click to reset
  header.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('button')) return; // ignore buttons
    clearFloatingPanelPos();
    panel.style.left = '';
    panel.style.top = '';
    panel.style.bottom = ''; // restore CSS default
    panel.style.right = '';  // restore CSS default
  });
}

function toggleFloatingPanel() {
  const now = Date.now();
  if (now - sgFloatingToggleLock < 280) return;
  sgFloatingToggleLock = now;
  if (floatingPanelVisible) {
    hideFloatingPanel();
  } else {
    showFloatingPanel();
  }
}


function shouldGuardFloatingPanelViewport() {
  // When the viewport is very small (mobile / narrow desktop window),
  // the panel may be pushed off-screen by fixed bottom offsets.
  return window.innerWidth < 560 || window.innerHeight < 520;
}

function ensureFloatingPanelInViewport(panel) {
  try {
    if (!panel || !panel.getBoundingClientRect) return;

    // 移动端竖屏使用 CSS 底部弹出，不需要 JS 定位
    if (isMobilePortrait()) return;

    // Remove viewport size guard to ensure panel is always kept reachable
    // if (!shouldGuardFloatingPanelViewport()) return;

    // 与 clampToViewport 保持一致的边界逻辑（允许 50% 越界）
    const minVisibleRatio = 0.5;
    const minVisiblePx = 40;

    const rect = panel.getBoundingClientRect();
    const w = rect.width || panel.offsetWidth || 300;
    const h = rect.height || panel.offsetHeight || 400;

    const minVisibleW = Math.max(minVisiblePx, w * minVisibleRatio);
    const minVisibleH = Math.max(minVisiblePx, h * minVisibleRatio);

    // Ensure the panel itself never exceeds viewport bounds for max size
    panel.style.maxWidth = `calc(100vw - ${minVisiblePx}px)`;
    panel.style.maxHeight = `calc(100dvh - ${minVisiblePx}px)`;

    // Clamp current on-screen position into viewport.
    const clamped = clampToViewport(rect.left, rect.top, w, h);

    // 检查是否需要调整位置（使用放宽的边界逻辑）
    // 如果可见部分少于 minVisible，则需要调整
    const visibleLeft = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left));
    const visibleTop = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top));

    if (visibleLeft < minVisibleW || visibleTop < minVisibleH || rect.top < 0) {
      panel.style.left = `${Math.round(clamped.left)}px`;
      panel.style.top = `${Math.round(clamped.top)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  } catch { /* ignore */ }
}

function bindFloatingPanelResizeGuard() {
  if (sgFloatingResizeGuardBound) return;
  sgFloatingResizeGuardBound = true;

  window.addEventListener('resize', () => {
    if (!floatingPanelVisible) return;
    const panel = document.getElementById('sg_floating_panel');
    if (!panel) return;
    requestAnimationFrame(() => ensureFloatingPanelInViewport(panel));
  });
}

function showFloatingPanel() {
  createFloatingPanel();
  const panel = document.getElementById('sg_floating_panel');
  if (panel) {
    // 移动端/平板：强制使用底部弹出样式
    if (isMobilePortrait()) {
      panel.style.position = 'fixed';
      panel.style.top = '0';
      panel.style.bottom = '0';
      panel.style.left = '0';
      panel.style.right = '0';
      panel.style.width = '100%';
      panel.style.maxWidth = '100%';
      panel.style.height = 'calc(var(--sg-vh, 1vh) * 100)';
      panel.style.maxHeight = 'calc(var(--sg-vh, 1vh) * 100)';
      panel.style.borderRadius = '0';
      panel.style.resize = 'none';
      panel.style.transform = 'none';
      panel.style.transition = 'none';
      panel.style.opacity = '1';
      panel.style.visibility = 'visible';
      panel.style.display = 'flex';
    } else if (window.innerWidth < 1200) {
      // 桌面端小窗口：清除可能的内联样式，使用 CSS
      panel.style.left = '';
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.right = '';
      panel.style.transform = '';
      panel.style.maxWidth = '';
      panel.style.maxHeight = '';
      panel.style.display = '';
      panel.style.height = '';
      panel.style.opacity = '';
      panel.style.visibility = '';
      panel.style.transition = '';
      panel.style.borderRadius = '';
    } else {
      panel.style.display = '';
    }

    panel.classList.add('visible');
    floatingPanelVisible = true;
    // 如果有缓存内容则显示
    if (lastFloatingContent) {
      updateFloatingPanelBody(lastFloatingContent);
    }

    // 非移动端才运行视口检测
    if (!isMobilePortrait()) {
      bindFloatingPanelResizeGuard();
      requestAnimationFrame(() => ensureFloatingPanelInViewport(panel));
    }
  }
}

function hideFloatingPanel() {
  const panel = document.getElementById('sg_floating_panel');
  if (panel) {
    panel.classList.remove('visible');
    floatingPanelVisible = false;
    if (isMobilePortrait()) {
      panel.style.display = 'none';
    }
  }
}

  async function refreshFloatingPanelContent() {
    const $body = $('#sg_floating_body');
    if (!$body.length) return;

    $body.html('<div class="sg-floating-loading">正在分析剧情...</div>');

    try {
      const s = ensureSettings();
      const { snapshotText } = buildSnapshot();
      const modules = getModules('panel');

      if (!modules.length) {
        $body.html('<div class="sg-floating-loading">没有配置模块</div>');
        return;
      }

      const schema = buildSchemaFromModules(modules);
      const messages = buildPromptMessages(snapshotText, s.spoilerLevel, modules, 'panel');

      let jsonText = '';
      if (s.provider === 'custom') {
        jsonText = await callViaCustom(s.customEndpoint, s.customApiKey, s.customModel, messages, s.temperature, s.customMaxTokens, s.customTopP, s.customStream);
      } else {
        jsonText = await callViaSillyTavern(messages, schema, s.temperature);
        if (typeof jsonText !== 'string') jsonText = JSON.stringify(jsonText ?? '');
      }

      const parsed = safeJsonParse(jsonText);
      if (!parsed) {
        $body.html('<div class="sg-floating-loading">解析失败</div>');
        return;
      }

      // 合并静态模块
      const mergedParsed = mergeStaticModulesIntoResult(parsed, modules);
      updateStaticModulesCache(mergedParsed, modules).catch(() => void 0);

      // 渲染内容
      // Filter out quick_actions from main Markdown body to avoid duplication
      const bodyModules = modules.filter(m => m.key !== 'quick_actions');
      const md = renderReportMarkdownFromModules(mergedParsed, bodyModules);
      const html = renderMarkdownToHtml(md);

      await updateMapFromSnapshot(snapshotText);

      // 添加快捷选项
      const quickActions = Array.isArray(mergedParsed.quick_actions) ? mergedParsed.quick_actions : [];
      const optionsHtml = renderDynamicQuickActionsHtml(quickActions, 'panel');

    const refreshBtnHtml = `
      <div style="padding:2px 8px; border-bottom:1px solid rgba(128,128,128,0.2); margin-bottom:4px; text-align:right;">
        <button class="sg-inner-refresh-btn" title="重新生成分析" style="background:none; border:none; cursor:pointer; font-size:1.1em; opacity:0.8;">🔄</button>
      </div>
    `;

    const fullHtml = refreshBtnHtml + html + optionsHtml;
    lastFloatingContent = fullHtml;
    updateFloatingPanelBody(fullHtml);

  } catch (e) {
    console.warn('[StoryGuide] floating panel refresh failed:', e);
    $body.html(`<div class="sg-floating-loading">分析失败: ${e?.message ?? e}</div>`);
  }
}

function updateFloatingPanelBody(html) {
  const $body = $('#sg_floating_body');
  if ($body.length) {
    $body.html(html);
  }
}

  function showFloatingRollLogs() {
    const $body = $('#sg_floating_body');
    if (!$body.length) return;

  const meta = getSummaryMeta();
  const logs = Array.isArray(meta?.rollLogs) ? meta.rollLogs : [];

  if (!logs.length) {
    $body.html('<div class="sg-floating-loading">暂无 ROLL 日志</div>');
    return;
  }

  const html = logs.slice(0, 50).map((l) => {
    const ts = l?.ts ? new Date(l.ts).toLocaleString() : '';
    const action = String(l?.action || '').trim();
    const outcome = String(l?.outcomeTier || '').trim()
      || (l?.success == null ? 'N/A' : (l.success ? '成功' : '失败'));
    const finalVal = Number.isFinite(Number(l?.final)) ? Number(l.final).toFixed(2) : '';
    let summary = '';
    if (l?.summary && typeof l.summary === 'object') {
      const pick = l.summary.summary ?? l.summary.text ?? l.summary.message;
      summary = String(pick || '').trim();
      if (!summary) {
        try { summary = JSON.stringify(l.summary); } catch { summary = String(l.summary); }
      }
    } else {
      summary = String(l?.summary || '').trim();
    }
    const userShort = String(l?.userText || '').trim().slice(0, 160);

    const detailsLines = [];
    if (userShort) detailsLines.push(`<div><b>用户输入</b>：${escapeHtml(userShort)}</div>`);
    if (summary) detailsLines.push(`<div><b>摘要</b>：${escapeHtml(summary)}</div>`);
    return `
      <details style="margin-bottom:4px; padding:4px; border-bottom:1px solid rgba(128,128,128,0.3);">
        <summary style="font-size:0.9em; cursor:pointer; outline:none;">${escapeHtml(`${ts}｜${action || 'ROLL'}｜${outcome}${finalVal ? `｜最终=${finalVal}` : ''}`)}</summary>
        <div class="sg-log-body" style="padding-left:1em; opacity:0.9; font-size:0.85em; margin-top:4px;">${detailsLines.join('')}</div>
      </details>
    `;
  }).join('');

    $body.html(`<div style="padding:10px; overflow-y:auto; max-height:100%; box-sizing:border-box;">${html}</div>`);
  }

  function showFloatingMap() {
    const $body = $('#sg_floating_body');
    if (!$body.length) return;
    const s = ensureSettings();
    if (!s.mapEnabled) {
      $body.html('<div class="sg-floating-loading">地图功能未启用</div>');
      return;
    }
    const mapData = getMapData();
    const html = renderGridMap(mapData);
    const autoLabel = isMapAutoUpdateEnabled(s) ? '自动更新：开' : '自动更新：关';
    const tools = `
      <div style="padding:2px 8px; border-bottom:1px solid rgba(128,128,128,0.2); margin-bottom:4px; text-align:right;">
        <button class="sg-inner-map-toggle-btn" title="切换自动更新" style="background:none; border:none; cursor:pointer; font-size:0.95em; opacity:0.85; margin-right:6px;">${autoLabel}</button>
        <button class="sg-inner-map-reset-btn" title="重置地图" style="background:none; border:none; cursor:pointer; font-size:1.1em; opacity:0.8;">🗑</button>
      </div>
    `;
    $body.html(`${tools}<div style="padding:10px; overflow:auto; max-height:100%; box-sizing:border-box;">${html}</div>`);
  }

  function showFloatingReport() {
    const $body = $('#sg_floating_body');
    if (!$body.length) return;

  // Use last cached content if available, otherwise show empty state
  if (lastFloatingContent) {
    updateFloatingPanelBody(lastFloatingContent);
  } else {
    $body.html(`
      <div style="padding:20px; text-align:center; color:#aaa;">
        点击 <button class="sg-inner-refresh-btn" style="background:none; border:none; cursor:pointer; font-size:1.2em;">🔄</button> 生成
      </div>
    `);
  }
}

// -------------------- init --------------------

// -------------------- fixed input button --------------------
// -------------------- fixed input button --------------------
function injectFixedInputButton() {
  if (document.getElementById('sg_fixed_input_btn')) return;

  const tryInject = () => {
    if (document.getElementById('sg_fixed_input_btn')) return true;

    // 1. Try standard extension/audit buttons container (desktop/standard themes)
    let container = document.getElementById('chat_input_audit_buttons');

    // 2. Try Quick Reply container (often where "Roll" macros live)
    if (!container) container = document.querySelector('.quick-reply-container');

    // 3. Try finding the "Roll" button specifically and use its parent
    if (!container) {
      const buttons = Array.from(document.querySelectorAll('button, .menu_button'));
      const rollBtn = buttons.find(b => b.textContent && (b.textContent.includes('ROLL') || b.textContent.includes('Roll')));
      if (rollBtn) container = rollBtn.parentElement;
    }

    // 4. Fallback: Insert before the input box wrapper
    if (!container) {
      const wrapper = document.getElementById('chat_input_form');
      if (wrapper) container = wrapper;
    }

    if (!container) return false;

    const btn = document.createElement('div');
    btn.id = 'sg_fixed_input_btn';
    btn.className = 'menu_button';
    btn.style.display = 'inline-block';
    btn.style.cursor = 'pointer';
    btn.style.marginRight = '5px';
    btn.style.padding = '5px 10px';
    btn.style.userSelect = 'none';
    btn.innerHTML = '📘 剧情';
    btn.title = '打开剧情指导悬浮窗';
    // Ensure height consistency
    btn.style.height = 'var(--input-height, auto)';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleFloatingPanel();
    });

    // Check if we found 'chat_input_form' which is huge, we don't want to just appendChild
    if (container.id === 'chat_input_form') {
      container.insertBefore(btn, container.firstChild);
      return true;
    }

    // For button bars, prepend usually works best for visibility
    if (container.firstChild) {
      container.insertBefore(btn, container.firstChild);
    } else {
      container.appendChild(btn);
    }
    return true;
  };

  // Attempt immediately
  tryInject();

  // Watch for UI changes continuously (ST wipes DOM often)
  // We do NOT disconnect, so if the button is removed, it comes back.
  const observer = new MutationObserver((mutations) => {
    // Check if relevant nodes were added or removed
    let needsCheck = false;
    for (const m of mutations) {
      if (m.type === 'childList') {
        needsCheck = true;
        break;
      }
    }
    if (needsCheck) tryInject();
  });

  // observe body for new nodes
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

function init() {
  ensureSettings();
  bindMapEventPanelHandler();
  setupEventListeners();

  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    // 不再在顶栏显示📘按钮（避免占位/重复入口）
    const oldBtn = document.getElementById('sg_topbar_btn');
    if (oldBtn) oldBtn.remove();

    injectMinimalSettingsPanel();
    ensureChatActionButtons();
    installCardZoomDelegation();
    installQuickOptionsClickHandler();
    createFloatingButton();
    injectFixedInputButton();
    installRollPreSendHook();
  });

  // 聊天切换时自动绑定世界书
  eventSource.on(event_types.CHAT_CHANGED, async () => {
    console.log('[StoryGuide] CHAT_CHANGED 事件触发');

    const ctx = SillyTavern.getContext();
    const hasChat = ctx.chat && Array.isArray(ctx.chat);
    const chatLength = hasChat ? ctx.chat.length : 0;

    console.log('[StoryGuide] 聊天状态:', { hasChat, chatLength, chatMetadata: !!ctx.chatMetadata });

    // 放宽检查：只要有 chatMetadata 就尝试运行
    if (!ctx.chatMetadata) {
      console.log('[StoryGuide] 没有 chatMetadata，跳过自动绑定');
      return;
    }

    try {
      await onChatSwitched();
    } catch (e) {
      console.warn('[StoryGuide] 自动绑定世界书失败:', e);
    }
  });

  globalThis.StoryGuide = {
    open: openModal,
    close: closeModal,
    runAnalysis,
    runSummary,
    runInlineAppendForLastMessage,
    reapplyAllInlineBoxes,
    buildSnapshot: () => buildSnapshot(),
    getLastReport: () => lastReport,
    refreshModels,
    _inlineCache: inlineCache,
  };
}

init();

