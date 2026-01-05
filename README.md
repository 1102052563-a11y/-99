# 剧情指导 StoryGuide（SillyTavern 扩展）

## v0.4.0：自定义输出模块 & 每个模块提示词
你可以在面板里直接编辑「输出模块（JSON）」：
- 自定义模块数量与顺序
- 每个模块独立 prompt（提示词）
- 控制该模块是否在面板报告/自动追加框中展示
- 插件会根据模块动态生成 JSON Schema 并强制模型按字段输出

### 模块配置字段
- key: JSON 字段名（唯一）
- title: 报告显示标题
- type: "text" 或 "list"（list = string[]）
- prompt: 该模块的生成提示词（会写入 Output Fields）
- required: 是否强制要求字段输出（默认 true）
- panel: 是否在“报告”里展示（默认 true）
- inline: 是否在“自动追加分析框”里展示（默认 false）
- maxItems: type=list 时限制最大条目（可选）

### 提示词骨架自定义
- 自定义 System 补充：更改整体风格/角色，比如更像“旁白”“编剧室”
- 自定义 Constraints 补充：加硬规则，比如“每条不超过 20 字”

## 独立 API 更稳定
custom 优先走酒馆后端代理：
- /api/backends/chat-completions/status
- /api/backends/chat-completions/generate
接口不存在（404/405）才 fallback 直连（可能 CORS）。

## 抗覆盖
额外变量模型更新导致的二次重渲染，会被 MutationObserver 兜底补贴（并保持折叠状态）。
