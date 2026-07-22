# Office Viewer Windows 桌面版功能等效矩阵

## 1. 判定口径

本项目的目标是复刻 VS Code 插件自身的工具前端与用户能力，不复制 VS Code 外壳。桌面壳只负责窗口、标签、菜单、文件生命周期和受限系统能力；Excel、Word、PowerPoint、PDF、Markdown、Git History 等视图尽量直接复用原插件前端。

状态快照日期：2026-07-22。

- **已接入/有自动化证据**：桌面实现存在，并有当前仓库中的单元或 Electron E2E 覆盖；不等于完整格式等效。
- **已接入/验证不足**：实现存在，但缺少保存往返、复杂样本、安全边界或人工对照证据。
- **部分接入**：只覆盖原能力的一部分。
- **未接入**：当前桌面实现中没有等效入口。
- 只有本行全部验收标准完成，才可改为“已验证等效”。构建通过、前端可见或单个最小样本通过均不足以单独作此结论。

原插件范围以 `package.json#contributes`、`src/provider/**`、`src/service/**`、`src/gitHistory/**`、`src/react/view/**` 和 `vditor/**` 的实际代码为准，README 仅作补充。

## 2. 桌面宿主

| ID | 等效范围 | 当前状态与证据 | 尚未完成的验收 |
|---|---|---|---|
| HOST-01 | 本地文件对话框、拖放、命令行/第二实例、多标签、去重、最近文件 | 已接入/有自动化证据：会话单测覆盖去重；多份 Electron E2E 通过命令行打开多文件，XLSX 用例覆盖第二实例去重；preload 提供受限拖放与对话框 API | 文件对话框取消、系统双击、50 文件、中文/超长/特殊路径和重启后最近文件仍缺独立门禁 |
| HOST-02 | 读取、原子保存、另存为、只读、脏状态、关闭确认、外部修改 | 已接入/有自动化证据：会话单测覆盖原子替换、另存、挂起恢复、512 MiB 上限；XLSX、Word、Markdown、HTML、CSV 文本路径已有保存往返 E2E | 只读另存取消、EACCES/磁盘满、保存中崩溃、外部冲突三选一和占用文件仍未完整验证 |
| HOST-03 | Electron 最小权限边界 | 已接入/部分验证：`contextIsolation`、sandbox、禁用 renderer Node；固定 IPC、session 授权、文件大小/路径校验；HTML、SVG、Markdown、字体、HEIC 使用隔离协议或 iframe | 仍需对打包产物做恶意 renderer、导航、外链协议、任意 channel 和网络抓包测试 |
| HOST-04 | Windows 安装包、便携版、文件关联 | 已接入/验证不足：最终源码执行 `desktop:dist` 成功生成 NSIS 与 portable，格式关联已写入构建配置；`win-unpacked` 已通过 XLSX 打开/编辑/保存/第二实例自动化，portable 已通过 XLSX 首屏检查（本机冷启动 32 秒） | 产物未签名；安装/升级/卸载、关联回退及干净 Windows 10/11 未验证 |
| HOST-05 | 主题、窗口/视图状态、开发工具、在资源管理器中显示、外链 | 部分接入：桌面亮/暗主题、本次会话最近文件、受控外链、资源管理器和生产禁用 DevTools 已实现 | 窗口与文档视图跨重启恢复、主题/图标与原插件逐项视觉对照未完成 |
| HOST-06 | 远程与虚拟 URI | 未接入：桌面版当前只接受本地文件路径 | 若最终不支持 `vscode-vfs`/`vscode-remote`，需在发布范围中明确说明并验证拒绝提示 |
| HOST-07 | 遥测隐私 | 部分接入：桌面实现未接入原插件遥测上报 | 仍需网络 Mock/抓包证明无用户未触发请求，并形成公开隐私说明 |

## 3. 查看器、编辑器与格式

| ID | 原插件格式/能力 | 当前状态与自动化证据 | 主要剩余风险 |
|---|---|---|---|
| FMT-EXCEL | `.xls/.xlsx/.xlsm/.csv/.tsv/.ods`；原 Excel UI、编辑、保存/另存、CSV 文本切换 | 已接入/有自动化证据：全后缀路由 E2E；XLSX 单元格编辑保存往返；CSV 文本/表格切换、文本编辑保存并回到表格视图 | 复杂公式/样式/图片/保护/打印未形成黄金样本；真实 XLSM 宏保真、CSV 编码和 `.xls/.ods` 保存仍未证明 |
| FMT-WORD | `.docx/.dotx`；原 Word 编辑器、工具栏、编辑和保存 | 已接入/有自动化证据：两种后缀可见，原工具栏存在，DOCX 文本编辑后通过独立 OOXML 读取验证保存 | 批注、页眉页脚、复杂表格/图片、只读另存、DOTX 保存与视觉对照不足 |
| FMT-PPT | `.pptx/.pptm`；原 PowerPoint 查看器、缩略图、翻页、缩放/平移 | 已接入/有自动化证据：两种后缀、两页缩略图、状态栏和主题控件 E2E | PPTM 仅使用改名样本，未验证真实宏文件；复杂图表、媒体、键盘边界和大文件不足 |
| FMT-PDF | `.pdf`；原 PDF.js 前端 | 已接入/有自动化证据：隔离的原 PDF.js viewer、页码/缩放/搜索/打印等工具栏已有 Electron E2E | 加密、表单、损坏、链接安全、超大 PDF 和打印/下载产物未完整验证 |
| FMT-PARQUET | `.parquet` 查看、基础类型编辑与保存 | 已接入/部分验证：有效/损坏样本、数据行和错误 UI 有 E2E | 编辑保存、schema 往返、nullable/嵌套类型和大表未验证 |
| FMT-EPUB | `.epub`；目录、导航、搜索、信息、主题与排版设置 | 已接入/有自动化证据：原前端、章节链接、相对图片、元数据清理及损坏文件 E2E | 搜索、设置/进度跨重启、多书隔离、无目录和大书不足 |
| FMT-HTML | `.html/.htm/.xhtml`；预览、源代码/分栏、`Ctrl+Shift+V`、保存刷新 | 已接入/有自动化证据：相对 CSS/图片/脚本、源代码编辑保存、预览刷新、Node/父级 API 隔离及路径穿越拒绝 E2E | 弹窗、导航、外链和更多编码/损坏输入仍需安全矩阵 |
| FMT-MARKDOWN | `.md/.markdown`；原 Vditor、WYSIWYG/IR、源文本、保存、图片、WikiLink、公式/Mermaid、导出、AI 与设置 | 已接入/有自动化证据：原工具栏、富文本和源文本保存重开、本地图片、脚本隔离、KaTeX/Mermaid HTML、DOCX 媒体、PDF 大纲/无大纲；设置 UI 持久化、源模式图片/文本粘贴和 `Ctrl+Alt+E` 双向切换有 E2E；图片路径、设置安全存储、OpenAI/Anthropic 流与取消有单测 | PlantUML、WikiLink 全边界、其余快捷键、真实各 AI 供应商错误矩阵和复杂导出文档仍不足 |
| FMT-IMAGE | `.jpg/.jpeg/.pjpeg/.pjp/.png/.gif/.apng/.bmp/.ico/.cur/.webp/.tif/.tiff/.heic/.heif`；原图片 gallery | 已接入/有自动化证据：所有声明后缀（含真实 HEIC、TIFF）均通过原 gallery E2E；HEIC 解码器处于独立沙箱 | 动画帧、EXIF 方向、超大/损坏样本、目录海量图片与内存回收不足 |
| FMT-SVG | `.svg`；原代码编辑/格式化/预览/导出前端 | 已接入/部分验证：原控件与预览可见，恶意 active script 未执行 | 实际格式化、保存、SVG/PNG 导出语义和更多外链/事件属性攻击未形成闭环 |
| FMT-PSD/XMIND/ICNS | `.psd/.xmind/.icns` 原查看器 | 已接入/有自动化证据：有效与损坏 PSD/ICNS；有效/损坏 XMind；合成图、图层文本、图标尺寸和脑图根节点可见 | PSD 嵌套/色彩模式、XMind 多 sheet/超大图、ICNS 多 chunk 覆盖不足 |
| FMT-FONT | `.ttf/.otf/.woff/.woff2`；原字体信息、字形与搜索 | 已接入/有自动化证据：四格式及损坏样本 E2E；WOFF2 解码在独立沙箱且主 CSP 无 eval | 搜索交互、复杂字体/可变字体、大字形集和资源回收不足 |
| FMT-ZIP | `.zip/.jar/.apk/.vsix/.crx`；原 ZIP/JAR 前端、浏览、预览、解压、ZIP 编辑保存 | 已接入/部分验证：原前端浏览；单测覆盖添加/删除保存、解压和 traversal/symlink/压缩比拒绝；E2E 覆盖损坏与穿越归档 | 密码、编码切换、真实 APK/VSIX/CRX/JAR 信息、UI 添加删除保存和解压对话框不足 |
| FMT-NONZIP | `.7z/.rar/.tar/.tar.gz/.tgz`；原归档前端 | 已接入/有自动化证据：五种入口原前端 E2E；真实 7z/RAR/TAR/TAR.GZ/TGZ 单测覆盖读取与损坏，TAR 安全边界覆盖穿越/符号链接 | 密码归档、UI 解压、取消/部分失败、超大归档和设备名边界不足 |
| FMT-JAVA | `.class`；FernFlower 反编译只读显示 | 已接入/有自动化证据：真实 class 反编译、临时输出清理单测及 CodeMirror E2E | 无 Java、损坏/大 class、内部类、超时和只读临时目录不足 |

## 4. 非查看器工具

| ID | 原插件能力 | 当前状态与自动化证据 | 主要剩余风险 |
|---|---|---|---|
| TOOL-GIT | 仓库/文件历史、原提交图和详情、搜索筛选、remote、同步、分支/tag/stash/merge/revert/reset/clean 等操作 | 已接入/部分验证：复用原 Git History 前端；当前文件历史、提交图、详情、工具栏和上下文菜单有真实仓库 E2E；Quick Sync 设置从默认隐藏到启用显示及持久化有 E2E；服务单测覆盖数据契约、安全分支操作、仓库授权和 stash/file-history | remote/认证/冲突，以及每个破坏性 action 的确认、取消、失败恢复和仓库状态矩阵尚未逐项 E2E |
| TOOL-HTTP | `.http/.rest` 编辑、变量、请求发送、响应视图、重定向/表单/GraphQL/Basic、模板 | 已接入/有自动化证据：CodeMirror 补全、hover、F12/Shift+F12、符号大纲、文档链接、诊断、请求与变量 CodeLens 已映射；真实本地服务 E2E 覆盖编辑、私网确认、环境变量、发送、响应、设置持久化和加密环境；服务单测覆盖语言服务、命名请求、响应变量、跨域凭据剥离、body 文件边界、GraphQL/表单/Basic | F12/Shift+F12/hover、复制 cURL/正文及保存响应仍缺动作级 E2E；代理、TLS、断网、超时/取消和大响应矩阵不足 |
| TOOL-YAML/XML | YAML 大纲与锚点/别名；XML 全文格式化 | 已接入/有自动化证据：模型单测及 Electron E2E 覆盖 YAML 多文档大纲、锚点/别名和 XML 格式化保存 | YAML 定义跳转交互、XML 选区格式化、复杂错误恢复不足 |
| TOOL-LANG | NGINX、Kotlin、REG、TOML、Kusto 语言前端与 HTTP snippets | 已接入/有自动化证据：CodeMirror 语言路由、语法前端和内置 completion 模板有单测；所有语言有 Electron E2E | 与原 TextMate 逐 token 高亮、括号/注释快捷键及 `.conf` 冲突选择未逐项对照 |
| TOOL-THEME | One Dark Modern/Classic、Office Material Icon Theme | 部分接入：桌面壳提供亮/暗主题，原查看器内部主题能力继续存在 | 原两套主题和文件图标未完成逐项视觉等效与可访问性检查 |

## 5. 设置、命令和快捷键

| 范围 | 当前状态 | 尚未完成 |
|---|---|---|
| Markdown 设置 | 编辑模式、编辑器/CodeMirror/Mermaid 主题、图片路径模板、workspace 基准、PDF 上边距和原 viewer 设置已持久化；AI key 仅进系统安全存储，安全存储不可用时拒绝明文回退 | Chromium 自定义路径和 puppeteer 参数没有独立桌面设置；全部选项值与非法值回退仍需逐项 UI E2E |
| HTTP 设置 | 环境变量、重定向、响应视图、Unicode 解码、表单编码、私网确认、超时、`previewColumn`、日志级别、请求体缩进和 CodeLens 开关均已映射并持久化；环境 JSON 使用系统安全存储且无明文回退 | 全部非法值回退、跨升级迁移和多工作区隔离仍需补充验证 |
| Git 设置 | Quick Sync 入口和原 Git History 设置入口已存在；`quickSyncButton` 已持久化并有 E2E | 其余原设置值和跨升级迁移未逐项验证 |
| 应用命令 | `Ctrl+S` 保存链路；CSV 表格/文本切换；HTML 预览/源代码切换；HTTP 发送；Git History/当前文件历史；Markdown 原工具栏命令与 `Ctrl+Alt+E` 已接入并验证 | HTTP cURL/响应保存复制及 Markdown 其余快捷键仍需动作级自动化；不能只以实现代码存在判定通过 |

## 6. 当前结论与发布阻塞项

当前已完成原插件声明功能面到 Windows 桌面版的实现映射，原工具前端也已复用；当前发布状态仍是 **功能实现完成、发布认证部分完成**，不能把尚未执行的复杂格式、环境矩阵和视觉认证写成已验证等效。自动化现包含 14 个单元测试文件（43 个用例）和 15 个 Windows Electron E2E 文件；以下项目仍阻塞“最终发布等效”结论：

1. 真实复杂 Office 黄金样本、XLSM/PPTM 宏保真、CSV 编码和全部写路径的只读/失败/冲突/崩溃恢复。
2. Git 远程与全部破坏性操作、HTTP 网络错误与部分动作级 UI 矩阵、Markdown 其余快捷键和全部富文本结构。
3. 安装/升级/卸载、文件关联、Windows 10/11、DPI/IME/辅助功能、长时间和大文件人工门禁。
4. 打包产物安全动态测试、零非预期网络证明与许可证核对；当前 npm 审计为 0 漏洞，但二进制组件仍需许可证清单。
5. 原插件与桌面版逐格式、逐工具的前端视觉对照截图及差异登记。

详细执行门禁见 [test-plan.md](./test-plan.md)。

## 7. 防遗漏核对

每个发布候选必须重新比较：

1. `package.json#contributes.customEditors.selector` 的唯一后缀集合、provider 路由、桌面路由与 fixture 清单。
2. 原插件所有 `registerCommand`、设置读取、webview 消息与桌面菜单/快捷键/IPC 的映射。
3. `gitActions.ts` 的每个 action 是否同时具备 UI、宿主处理、确认、成功刷新、失败反馈和测试。
4. `shortcut.md` 与真实键盘处理器是否一致，Windows 保留键和应用壳冲突是否已记录。
5. PDF、Java、解压、字体/HEIC 解码、Markdown 导出等二进制或动态资源是否进入离线打包和许可证门禁。
