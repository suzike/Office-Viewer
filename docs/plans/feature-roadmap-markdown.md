# Markdown 模块功能路线图（30 项）


> **进度（v0.5.4）**：已交付 ✅ 1 打印、3 长图 PNG、13 一键 TOC、9 字数统计（批次 1 部分项）。
> **进度（v0.5.5）**：批次 2 ✅ 7 导出纯文本、10 专注模式、11 禅模式、22 拖拽插入相对链接、29 AI 生成目录/摘要（跳过 14/16/20）。
> **进度（v0.5.6）**：批次 3 ✅ 15/23/24（跳过 2/21/25/27）。

> 基线：vditor 编辑器（wysiwyg/ir）、图片服务（粘贴/上传/路径模板）、PDF/HTML/DOCX 导出、AI 润色（流式+diff 审阅）、双设置面板、源码模式。
> 扩展点：宿主 `DesktopMarkdownDocumentViewer.tsx` + iframe 消息总线（`resource/markdown/index.js` handler.on）；主进程服务 `desktop/main/markdown-*.ts`；IPC 五文件链。

## 导出与打印

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 1 | 打印（隐藏窗口打印当前文档） | P0 | S | markdown-export-service（复用 printToPDF 窗口） |
| 2 | 导出 EPUB（章节拆分 + 目录 + 封面） | P1 | L | markdown-export-service 新分支 |
| 3 | 导出长图 PNG（整页 capturePage） | P0 | M | markdown-export-service（隐藏窗口 capturePage） |
| 4 | 导出 PPTX（按 H1/H2 分页，Marp 风格） | P2 | L | export-service + pptx 库 |
| 5 | 导出设置面板（纸张 A4/Letter、四边距、页眉页脚） | P0 | M | settings-service schema + 设置对话框 |
| 6 | PDF 导出水印（文字/透明度/角度） | P2 | M | export-service PDF 生成段（pdf-lib） |
| 7 | 导出纯文本（剥离 front-matter/语法符号选项） | P1 | S | 右键菜单 + export-service |

## 编辑增强

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 8 | 全文查找替换（正则/大小写/全词/替换全部） | P0 | M | vditor FindBar 增强（vditor/src/ts） |
| 9 | 字数统计栏（字符/词/段落/阅读时长） | P0 | S | 宿主状态条 or vditor counter |
| 10 | 专注模式（打字机滚动 + 当前行/段高亮） | P1 | M | vditor 编辑区样式 + 设置项 |
| 11 | 禅模式（全屏无干扰，ESC 退出） | P1 | S | 宿主全屏 overlay |
| 12 | 大纲拖拽重排章节（移动对应文本块） | P2 | L | vditor outline + 文本块移动 |
| 13 | 一键生成/更新 TOC（[toc] 标记插入与刷新） | P0 | S | 工具栏按钮 + markdown-it toc 已有基础 |
| 14 | 表格可视化增强（列宽拖拽、行列插入按钮） | P1 | L | vditor fork 表格模块 |
| 15 | Mermaid 渲染错误面板（显示语法错误行） | P1 | M | 预览渲染钩子 + 错误 UI |
| 16 | KaTeX 可视化公式插入对话框（符号面板 + 实时预览） | P1 | M | vditor ui 对话框 |
| 17 | 任务列表进度统计（x/y 完成度显示） | P2 | S | 大纲/状态条统计 |
| 18 | 粘贴 HTML 自动转 Markdown（富文本粘贴） | P0 | M | vditor paste 钩子 + turndown |
| 19 | 自定义 CSS 片段（注入预览与导出） | P2 | M | settings-service + 模板 |

## 图片与资源

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 20 | 图片压缩（保存时本地重压缩，质量可调） | P1 | M | markdown-image-service |
| 21 | 图库面板（浏览文档全部图片：定位引用/替换/删除/重命名） | P1 | L | 宿主新面板 + image-service 列表 IPC |
| 22 | 拖拽任意文件插入相对链接（非图片 → [name](path)） | P1 | S | vditor drop 钩子 |
| 23 | 死链与缺失图片扫描器（报告面板） | P1 | M | 主进程扫描 service + 宿主报告 UI |

## 文档管理

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 24 | 模板系统（新建文档从模板库选择） | P1 | M | settings-service 模板目录 + 新建流程 |
| 25 | 版本快照（保存时自动快照 + 历史对比/恢复） | P1 | L | 新 snapshot-service（userData 存储 + diff UI） |
| 26 | 拼写检查（本地词典，中英文） | P2 | L | CodeMirror/vditor 拼写层 |

## AI 深化

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 27 | AI 流式 diff 逐块接受/拒绝（细粒度审阅） | P1 | L | aiDiff/aiReviewPanel 增强 |
| 28 | AI 光标续写（行内幽灵文本补全，Tab 接受） | P2 | L | vditor 编辑器 inline completion + markdown-ai-service |
| 29 | AI 一键生成目录/摘要并插入文档 | P1 | M | 右键菜单 + AI Polish 预设 |

## 基础

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 30 | 模块 i18n 化（设置对话框等硬编码中文 → i18n 10 语言） | P0 | M | 宿主 + resource/markdown/lang.js |

## 建议批次

- **批次 1（P0 快赢）**：1 打印、3 长图、5 导出设置、8 查找替换、9 字数统计、13 TOC、18 粘贴转换、30 i18n
- **批次 2（P0/P1 核心）**：7 纯文本、10 专注、11 禅模式、14 表格、16 公式、20 压缩、22 拖链、29 AI 目录
- **批次 3（P1 深度）**：2 EPUB、15 mermaid 错误、21 图库、23 死链、24 模板、25 快照、27 diff 审阅
- **批次 4（P2）**：4 PPTX、6 水印、12 大纲重排、17 任务统计、19 CSS 片段、26 拼写、28 续写
