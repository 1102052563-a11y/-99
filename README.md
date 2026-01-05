# 剧情指导 StoryGuide（SillyTavern 扩展）

## v0.3.4（独立API稳定性增强）
参考常见“独立API”插件做法：custom provider 优先走酒馆后端代理（同源请求），减少 CORS/连不上：

- 刷新模型：`POST /api/backends/chat-completions/status`
- 生成：`POST /api/backends/chat-completions/generate`

若你的酒馆版本不支持这些接口（返回 404/405），插件会回退到浏览器直连（可能出现 CORS）。

## 使用
- 顶栏 📘 打开面板
- Provider 选 `custom` 时：填 **API基础URL**（建议形如 `https://xxx.com/v1`），再点“检查/刷新模型”选择模型。
- 若 provider=st，则使用当前酒馆连接的 API（最稳）。

## 自动追加分析框
开启后，每条 AI 回复都会在消息末尾追加一个蓝色“剧情指导”框（不修改原始消息内容，只做 UI 追加）。

## License
MIT


## v0.3.4 追加框不再被覆盖
- 针对“额外变量模型/后处理导致消息重渲染”场景：分析框会缓存并通过 DOM 观察器自动补贴，避免被覆盖消失。


## v0.3.4
- 自动追加的“剧情指导”方框：点击标题栏可隐藏/展开（折叠状态会在重渲染补贴时保持）
