<div align="center">

<img src="image/logo.png" width="96" alt="Office Viewer logo">

# Office Viewer Desktop

**面向 Windows 的独立文档查看、编辑与 AI 交互工作台**

无需 VS Code，即可在统一桌面界面中处理 Office、Markdown、PDF、图片、压缩包和开发者文档。

<a href="https://github.com/suzike/Office-Viewer/releases/latest"><img src="https://img.shields.io/github/v/release/suzike/Office-Viewer?display_name=tag&sort=semver&style=flat-square" alt="Release"></a>
<img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?style=flat-square&logo=windows" alt="Windows 10/11">
<img src="https://img.shields.io/badge/Electron-43.1.1-47848F?style=flat-square&logo=electron" alt="Electron 43.1.1">
<a href="LICENSE"><img src="https://img.shields.io/github/license/suzike/Office-Viewer?style=flat-square" alt="MIT License"></a>
<a href="https://github.com/suzike/Office-Viewer/actions/workflows/main.yml"><img src="https://github.com/suzike/Office-Viewer/actions/workflows/main.yml/badge.svg?style=flat-square" alt="CI"></a>

[⬇️ 下载](https://github.com/suzike/Office-Viewer/releases/latest) ·
[📖 更新日志](changelog.md) ·
[🧩 功能对照](docs/migration/feature-parity.md) ·
[🐛 问题反馈](https://github.com/suzike/Office-Viewer/issues)

<img src="docs/assets/screenshots/ai-assistant.png?v=0.5.6" alt="Office Viewer AI 文档助手">

</div>

## 📌 项目定位

Office Viewer Desktop 是一个真正的 Windows 桌面应用，不是 VS Code 外壳。它复用了优秀的开源文档渲染能力，并增加了独立窗口、多文档标签、Windows 文件关联、原子保存、Git History、文档 AI 助手、后台解析缓存和真实性能基准。

本项目源自 MIT 许可的 [`cweijan/vscode-office`](https://github.com/cweijan/vscode-office)。原作者版权和许可证完整保留；独立桌面层及后续功能由本仓库继续维护。详情见 [NOTICE.md](NOTICE.md)。

## ✨ 核心能力

| 模块 | 能力 |
| --- | --- |
| 🗂 多文档工作区 | 原生 Windows 窗口、拖放打开、多标签、最近文件、文件元数据、深浅色模式、单实例文件转交、macOS 设计语言界面（Windows 11 Mica 材质） |
| 📝 Word | `.docx` / `.dotx` 渲染与编辑、格式工具栏、表格、链接、撤销重做、原文件保存 |
| 📊 Excel | `.xls` / `.xlsx` / `.xlsm` / `.ods` / `.csv` / `.tsv` 查看与编辑、公式栏、筛选、冻结、样式、图片、查找和保存 |
| 📽 PowerPoint | `.pptx` / `.pptm` 幻灯片渲染、缩略图导航、缩放、主题切换和全屏查看 |
| 📑 Markdown | 所见即所得、目录、表格、公式、Mermaid（含错误诊断）、WikiLink、主题、查找替换、字数统计、专注/禅模式、模板插入、死链检查、打印，以及 PDF/DOCX/HTML/长图/纯文本导出 |
| 📕 PDF 与电子书 | PDF 文本层、缩放和搜索；EPUB 阅读与章节导航 |
| 🖼 图片与设计 | PNG/JPEG/GIF/WebP/BMP/ICO/ICNS/HEIC/TIFF/SVG/PSD/XMind/字体文件 |
| 🗜 压缩包 | ZIP/JAR/VSIX/APK/RAR/7Z/TAR/TAR.GZ/TGZ 浏览、预览、添加、删除和安全解压 |
| 🛠 开发者工具 | Git History、HTTP/REST 请求、Java Class 反编译、JSON/YAML/XML/TOML/代码文本查看；HTML 预览带源码编辑、本地校验、控制台、资源列表与网络瀑布、性能指标、响应式设备模拟、深色模式模拟、JS 禁用、预览内查找和 PNG/PDF 导出 |
| 🤖 AI 文档助手 | 当前文档问答、总结、改写、翻译、风险检查、选区浮动操作、斜杠命令与自定义快捷动作、提示词库、编辑重发、发送前敏感数据检测、模型参数调节、全局唤醒快捷键、流式响应和多模型切换 |

## 🖥 界面预览

<table>
  <tr>
    <td width="50%" align="center"><strong>Excel 工作簿</strong><br><img src="docs/assets/screenshots/excel-workbook.png?v=0.5.6" alt="Excel viewer"></td>
    <td width="50%" align="center"><strong>Word 编辑器</strong><br><img src="docs/assets/screenshots/word-editor.png?v=0.5.6" alt="Word editor"></td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>PowerPoint 查看器</strong><br><img src="docs/assets/screenshots/powerpoint-viewer.png?v=0.5.6" alt="PowerPoint viewer"></td>
    <td width="50%" align="center"><strong>Git History</strong><br><img src="image/README/1783342874748.png?v=0.5.6" alt="Git History"></td>
  </tr>
</table>

## 🤖 AI 文档助手

右下角的文档助手支持以下提供器：

| 类型 | 提供器 |
| --- | --- |
| 本地 CLI | Codex CLI · Claude Code CLI |
| 本地模型 | Ollama（自动发现已安装模型） |
| 云端 API | OpenAI 兼容接口（DeepSeek、Kimi 及自定义服务）· Anthropic Messages · Google Gemini |

AI 提供器只在首次打开助手时检测，不拖慢应用启动。文档上下文按“绝对路径 + 修改时间 + 文件大小”缓存；重复提问不会反复解析未修改文件。API Key 通过 Electron `safeStorage` 使用 Windows 安全存储保护，不会回传给渲染页面。

助手还支持划词浮动操作（解释 / 翻译 / 引用到助手）、斜杠命令与自定义快捷动作、提示词库、历史消息编辑重发、对话导出 Markdown 和全局唤醒快捷键（Ctrl+Shift+Space）。向远程模型发送前会检测私钥、Token、AWS 密钥、邮箱和身份证号等敏感数据，并要求确认后才会发出；temperature 与 maxTokens 等模型参数可按提供器分别调节。

> ⚠️ Codex CLI 目前标记为高信任实验模式，因为 CLI 自身无法完全关闭本地读取工具。使用任何远程模型前，请确认文档内容满足组织的数据安全要求。

## 📦 支持格式

<details>
<summary>展开完整格式列表</summary>

| 类别 | 扩展名 |
| --- | --- |
| Office | `.docx` `.dotx` `.xls` `.xlsx` `.xlsm` `.ods` `.csv` `.tsv` `.pptx` `.pptm` |
| 文档 | `.pdf` `.epub` `.md` `.markdown` `.html` `.htm` `.xhtml` |
| 图片/设计 | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` `.ico` `.icns` `.heic` `.heif` `.tif` `.tiff` `.svg` `.psd` `.xmind` |
| 字体 | `.ttf` `.otf` `.woff` `.woff2` |
| 数据 | `.parquet` `.json` `.jsonc` `.yaml` `.yml` `.xml` `.toml` `.ini` `.properties` |
| 压缩包 | `.zip` `.jar` `.vsix` `.apk` `.rar` `.7z` `.tar` `.tar.gz` `.tgz` |
| 开发者文件 | `.http` `.rest` `.class` 以及常见源码、配置和日志文本 |

</details>

## ⬇️ 下载与安装

前往 [GitHub Releases](https://github.com/suzike/Office-Viewer/releases/latest) 下载：

| 文件 | 说明 |
| --- | --- |
| `Office.Viewer.Setup.0.5.6.exe` | 标准安装版 |
| `Office.Viewer.0.5.6.exe` | 无需安装的便携版 |

当前基线产物尚未配置商业 Authenticode 证书，因此 Windows SmartScreen 可能显示“未知发布者”。请从本仓库 Release 下载并核对 Release 中公布的 SHA-256。

## 🏗 架构

<div align="center">
<img src="docs/assets/architecture.svg?v=0.5.6" width="820" alt="Office Viewer Desktop 架构图">
</div>

安全边界包括上下文隔离、禁用 Renderer Node 集成、会话令牌文件访问、路径穿越防护、压缩炸弹限制、私网模型显式授权、Markdown/HTML 主动内容过滤和凭据脱敏。

## ⚡ 性能基线

测试环境为 Windows 11、Intel Core i9-14900HX、32 GiB 内存，使用真实 Electron、两份 480×12 XLSX 和经过生产 IPC 的本地流式 AI mock。

| 指标 | v0.5.0 Desktop Baseline |
| --- | ---: |
| 冷启动 | 1,400 ms |
| 首个 XLSX 打开 | 1,263 ms |
| 标签切换 P95 | 37.6 ms |
| AI 首字响应 | 223 ms |
| Main 峰值 | 217 MiB |
| Renderer 峰值 | 199 MiB |
| 完整进程树峰值 | 680 MiB |

完整定义与复现方法见 [桌面性能基准](docs/performance/desktop-benchmark.md) 和 [基线结果](docs/performance/results/candidate-packaged-final.json)。机器、电源模式和杀毒软件都会影响绝对数值。

## 🧰 本地开发

**环境要求**：Windows 10/11 x64 · Node.js 22+ · npm（构建安装包时需要 Windows PowerShell）

```powershell
git clone https://github.com/suzike/Office-Viewer.git
cd Office-Viewer
npm ci
```

**开发与验证**：

```powershell
npm run desktop:dev          # Electron 桌面开发模式
npm run desktop:typecheck    # 桌面 TypeScript 检查
npm run desktop:build        # 构建 Renderer 与 Main/Preload
npm run test:desktop:unit    # 桌面单元测试
npm run test:desktop:e2e     # Windows Electron 端到端测试
npm run benchmark:desktop    # 真实桌面性能基准
npm run desktop:dist         # NSIS 安装版 + 便携版
```

仓库仍保留原 VS Code 扩展构建入口，便于同步上游渲染能力：

```powershell
npm run dev
npm run build
npm run package
```

## ⚠️ 已知限制

- 可编辑 Word 运行时只能由当前第三方编辑器从 DOCX Buffer 建立。Worker 会执行预热和只读预解析，但无法直接把预解析 DOM 变成完整可编辑实例；当前通过草稿缓存与防抖序列化保证切换和保存正确。
- PowerPoint 首次渲染依赖 DOM/Canvas，不能完全移出 Renderer；解析结果和缩略图已使用有界缓存。
- Release 尚未进行商业代码签名。
- AI 输出可能不准确，重要结论需要人工核验。

## 🔒 隐私与安全

- 桌面版默认在本机读取和处理文档；
- 只有用户主动发送问题时，所选文档上下文才会交给当前 AI 提供器；
- 本地模型地址访问需要显式允许本机/局域网；
- API Key 不写入普通 JSON、日志、README 或性能结果；
- 性能测试只使用 `127.0.0.1` 确定性 mock，不连接真实 LLM。

如发现安全问题，请不要在公开 Issue 中附带敏感文档或密钥。请通过仓库维护者的 GitHub 私信或 GitHub Security Advisory 私下报告。

## 🤝 版本与贡献

- 版本记录：[changelog.md](changelog.md)
- 桌面功能对照：[docs/migration/feature-parity.md](docs/migration/feature-parity.md)
- 测试计划：[docs/migration/test-plan.md](docs/migration/test-plan.md)
- 问题反馈：[GitHub Issues](https://github.com/suzike/Office-Viewer/issues)

提交改动前请至少运行与修改范围匹配的构建和测试。新增格式需要同时说明路由、读写能力、安全边界和 Electron E2E 覆盖。

## 🙏 Credits

- 上游项目：[cweijan/vscode-office](https://github.com/cweijan/vscode-office)
- PDF：[Mozilla PDF.js](https://github.com/mozilla/pdf.js)
- Excel：[@cweijan/exceljs](https://www.npmjs.com/package/@cweijan/exceljs)、[x-spreadsheet](https://github.com/myliang/x-spreadsheet)、[SheetJS](https://github.com/SheetJS/sheetjs)
- Word：[@eigenpal/docx-editor-react](https://www.npmjs.com/package/@eigenpal/docx-editor-react)、[docxjs](https://github.com/VolodymyrBaydalka/docxjs)
- PowerPoint：[pptxviewjs](https://www.npmjs.com/package/pptxviewjs)
- Markdown：[Vditor](https://github.com/Vanessa219/vditor)
- EPUB：[epub.js](https://github.com/futurepress/epub.js)
- 图像与设计：[heic2any](https://github.com/alexcorvi/heic2any)、[ag-psd](https://github.com/Agamnentzar/ag-psd)、[Mind Elixir](https://github.com/ssshooter/mind-elixir-core)
- HTTP：[REST Client](https://github.com/Huachao/vscode-restclient)
- 文件图标：[Material Icon Theme](https://github.com/PKief/vscode-material-icon-theme)

## 📄 License

[MIT](LICENSE)。衍生与第三方归属见 [NOTICE.md](NOTICE.md)。
