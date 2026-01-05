# 剧情指导 StoryGuide（SillyTavern 扩展）

## v0.3.5（抗覆盖增强）
你遇到的“额外变量模型更新”会导致消息 DOM 二次重渲染，从而覆盖掉我们后插入的分析框。

v0.3.5 的解决思路：
- 分析框内容按消息 id 缓存（inlineCache）
- MutationObserver 监听 chat/body 的重渲染
- 一旦分析框被覆盖消失，自动补贴回去
- 点击分析框标题可折叠/展开（状态也会缓存，重渲染后仍保持）

## 独立 API（custom）更稳定
custom 优先走酒馆后端代理：
- /api/backends/chat-completions/status
- /api/backends/chat-completions/generate
如接口不存在（404/405）才 fallback 直连（可能 CORS）。

## 使用
- 顶栏 📘 打开面板
- 勾选“自动追加分析框到回复末尾”
- 点击框标题即可隐藏/展开
