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
- 世界书：显示“本次注入”条目/字符/Token；支持选择注入位置（并自动保存，避免关闭面板后重置）
- Inline 分析框：新增「↻ 重Roll」按钮（重新生成该条分析）
- 模块：inline 默认继承 panel（新增模块不写 inline 时，也会出现在自动输出）

## v0.5.3
- 世界书 active 模式：增强激活匹配（支持常驻条目标记 & 基础正则）；当注入为 0 时提示“可能没有触发关键词”
