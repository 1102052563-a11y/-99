# 剧情指导 StoryGuide（SillyTavern 扩展）

一个不依赖油猴的 SillyTavern UI Extension：从“当前聊天 + 角色卡 + 你粘贴的原著后续/大纲”中抽取正在经历的世界，生成编剧式的剧情指导报告。

## 功能
- 世界简介（简洁）
- 重要剧情点（关键节点列表）
- 当前时间点的具体剧情（当前场景）
- 后续将会发生的事（可能走向）
- 主角行为对剧情造成的影响（偏离/推动点）
- 基于原著后续/大纲给主角提示（支持 不剧透/轻剧透/全剧透）

## 安装（从 Git 仓库导入）
在 SillyTavern：
1. 打开 **Extensions** 面板
2. 选择 **Install extension**（从 Git 仓库导入）
3. 粘贴本仓库 URL，安装后启用

## 使用
1. 打开 Settings → Extensions（或扩展面板的管理页面），找到 **剧情指导 StoryGuide**
2. 在“本聊天专用”里粘贴：
   - 世界观/设定补充（可选）
   - 原著后续/大纲（强烈建议，提示会更准）
3. 点击“分析当前剧情”
4. 可复制 Markdown、复制 JSON，或将提示放入输入框（默认用 /sys）

## Provider 说明
- **使用当前 SillyTavern API（推荐）**：最稳，走 ST 内部请求，避免 CORS。
- **自定义 endpoint**：直接在浏览器请求 OpenAI 兼容 chat/completions，可能被 CORS 拦截。

## 外部调用（浏览器内）
扩展会挂一个全局对象：
- `window.StoryGuide.runAnalysis()`
- `window.StoryGuide.buildSnapshot()`
- `window.StoryGuide.getLastReport()`

## License
MIT
