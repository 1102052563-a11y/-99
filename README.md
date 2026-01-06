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


## v0.6.2
- 优化面板按钮布局（不再竖排）
- 移除“本聊天专用”区块（与自定义提示重复）


## v0.6.2
- 修复面板按钮竖排（保存设置/分析/刷新模型等）
- 缩小扩展列表中的“打开面板”按钮占用


## v0.6.2
- 修复扩展页“打开面板”按钮仍竖排/占用过大


## v0.6.2
- 移除顶栏📘入口按钮（仅保留扩展页“打开面板”与聊天区生成/重Roll按钮）
