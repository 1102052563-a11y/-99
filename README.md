# 剧情指导 StoryGuide（SillyTavern 扩展）

## v0.5.1：世界书导入注入 + 预设导入导出（并修复 worldBookText 报错）

### 为什么会出现 `worldBookText is not defined`
旧版把世界书文本当作变量 `worldBookText` 插到 buildSnapshot 里，但没有声明该变量，所以导入后仍会报错。

v0.5.1 已改为：导入后存进 `settings.worldbookJson`，并在 buildSnapshot 内通过 `buildWorldbookBlock()` 生成要注入的文本。

### 世界书（World Info / Lorebook）
- 导入：面板 →「预设与世界书」→ 导入世界书JSON
- 勾选：在分析输入中注入世界书
- 模式：
  - active：仅注入可能激活条目（关键词匹配最近消息）
  - all：注入全部条目

### 预设
- 导出预设：可选是否包含 API Key
- 导入预设：覆盖当前插件设置（建议导入后刷新页面一次）


## v0.5.2
- 世界书注入：显示实际注入条目/字符/≈tokens，并支持选择注入位置（且自动保存）
- 自动分析框：新增“重roll”按钮
- 修复：自动输出现在按“面板模块列表”生成 schema/prompt，预设新增字段会被要求输出
