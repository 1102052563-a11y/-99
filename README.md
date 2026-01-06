# 剧情指导 StoryGuide（SillyTavern 扩展）

## v0.5.2：Bug 修复与性能优化

### 更新日志
- **修复**：优化了 DOM 监听器 (MutationObserver)，防止因插件自动插入 UI 而导致无限循环渲染或卡顿。
- **优化**：增强了 JSON 解析能力，即使模型在 JSON 前后输出废话也能正确提取内容。
- **安全**：增加了对 `ctx.chat` 数据读取的防御性检查。

### v0.5.1 功能回顾
- **世界书导入**：支持导入 JSON 格式世界书，并按需注入（Active/All 模式）。
- **预设系统**：支持一键导出/导入插件配置（含/不含 API Key）。
- **自定义模块**：完全自定义输出字段和提示词。

### 安装方法
1. 下载 ZIP 并解压。
2. 将文件夹放入 `SillyTavern/public/scripts/extensions/` 目录下。
3. 刷新页面。
