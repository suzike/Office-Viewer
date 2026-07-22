# Office Viewer Windows 桌面版测试计划与发布门禁

## 1. 当前状态

状态快照日期：2026-07-22。当前产品结论是 **声明功能面实现完成、发布认证部分完成**；复杂样本、Windows 环境矩阵和逐项视觉认证尚未全部完成。

仓库现有自动化入口：

| 命令 | 当前覆盖 |
|---|---|
| `npm run desktop:typecheck` | Electron main/preload/shared API 与桌面 renderer TypeScript 检查 |
| `npm run desktop:build` | Vite 桌面 renderer 与 Electron host 构建 |
| `npm run test:desktop:unit` | 19 个测试文件、56 个 `node:test` 用例；串行运行 |
| `npm run test:desktop:e2e` | 16 个 Windows Electron E2E 文件；串行运行 |
| `npm run test:desktop:packaged` | 对 `win-unpacked` 执行 XLSX 打开、编辑保存与第二实例门禁 |
| `npm run test:desktop` | 构建后依次运行全部桌面 unit 与 E2E |
| `npm run build` | 原 VS Code 扩展生产构建回归 |
| `npm run desktop:dist` | Windows NSIS 与 portable 打包 |

本轮已把以下新增 E2E 纳入 `test:desktop:e2e`，避免单独通过却不进入总门禁：

- `electron-image-formats.e2e.test.mjs`
- `electron-git-history.e2e.test.mjs`
- `electron-text-languages.e2e.test.mjs`

本轮最终集成记录：`npm run test:desktop:unit` 退出码 0，56/56 通过；16 个 Electron E2E 场景均通过，其中聚合运行时 HTTP/Markdown 超时并连锁取消两个表格场景，4 个场景随后均以独立进程复验通过；`npm run test:desktop:packaged` 退出码 0。聚合套件的进程资源隔离仍需继续加固。

最终产物：

| 文件 | 字节数 | SHA-256 | Authenticode |
|---|---:|---|---|
| `Office Viewer Setup 0.5.0.exe` | 203,545,225 | `2D33D2E6B1181AEAFFF75B36C8BBAAECA59FA3C19B73A5B0633A0FF6F1793CD8` | `NotSigned` |
| `Office Viewer 0.5.0.exe` | 203,192,946 | `A8F50F03D8D47053E1F57DB21239CB382EB31D361DEE56184F5A0A7C85DAD325` | `NotSigned` |

## 2. 自动化覆盖清单

### 2.1 单元与服务测试（19 文件，56 用例）

| 测试文件 | 已覆盖的核心行为 |
|---|---|
| `file-session-manager.test.mjs` | session 去重、原子覆盖、另存、挂起恢复、512 MiB 上限、图片 sibling token、Markdown 资源/WikiLink 路径边界 |
| `archive-service.test.mjs` | ZIP 添加/删除保存、安全解压、穿越/符号链接/可疑压缩比拒绝 |
| `nonzip-archive-service.test.mjs` | 真实 7z/RAR/TAR/TAR.GZ/TGZ、损坏输入、穿越和符号链接祖先拒绝 |
| `java-decompiler-service.test.mjs` | 真实 class 反编译与临时输出清理 |
| `http-service.test.mjs` | 请求分块、环境/响应变量、跨域凭据剥离、body 路径限制、GraphQL/表单/Basic |
| `http-language.test.mjs` | 定义、引用、符号、文档链接、诊断、补全及已发送请求诊断清理 |
| `http-settings-service.test.mjs` | 原设置矩阵、环境加密、无安全存储时拒绝明文及非法值拒绝 |
| `git-history-service.test.mjs` | 原前端数据契约、安全分支操作、仓库授权、stash 与文件历史筛选 |
| `text-language.test.mjs` | 文本语言路由、YAML 大纲/锚点、XML 格式化、内置补全模板 |
| `markdown-settings-service.test.mjs` | 完整 viewer 设置持久化与安全存储不可用时拒绝明文 key |
| `markdown-secret-guard.test.mjs` | AI key 仅内存回填并清理历史明文 |
| `markdown-image-service.test.mjs` | 图片路径模板/变量、字节校验、路径穿越和伪装扩展拒绝 |
| `markdown-ai-service.test.mjs` | OpenAI-compatible 流、Anthropic JSON、取消与凭据 URL 拒绝 |
| `markdown-export-service.test.mjs` | HTML 清理/样式和静态 DOCX OOXML 产物 |

### 2.2 Windows Electron E2E（16 文件）

| 测试文件 | 已覆盖的核心行为 |
|---|---|
| `electron-xlsx.e2e.test.mjs` | 启动参数去重、原 Excel 前端、XLSX 单元格编辑保存往返、第二实例 |
| `electron-spreadsheet-formats.e2e.test.mjs` | XLS/XLSM/ODS/CSV/TSV 路由；CSV 表格/文本切换、保存并回到表格 |
| `electron-word-powerpoint.e2e.test.mjs` | DOCX/DOTX 原 Word UI 与 DOCX OOXML 保存；PPTX/PPTM 原 PowerPoint UI/缩略图 |
| `electron-xmind-epub.e2e.test.mjs` | 原 XMind/EPUB 前端、损坏文件、EPUB 元数据清理、相对图片和内部链接 |
| `electron-image-svg.e2e.test.mjs` | 原图片/SVG 工具 UI、SVG active script 隔离 |
| `electron-image-formats.e2e.test.mjs` | 所有声明图片后缀，包括真实 HEIC 与 TIFF；原 gallery |
| `electron-parquet-psd-font-icns.e2e.test.mjs` | 有效/损坏 Parquet、PSD、TTF/OTF/WOFF/WOFF2、ICNS；WOFF2 沙箱 |
| `electron-zip.e2e.test.mjs` | 原 ZIP UI、目录浏览、损坏和穿越条目拒绝 |
| `electron-nonzip-archive.e2e.test.mjs` | 原 7z/RAR/TAR/TAR.GZ/TGZ UI |
| `electron-pdf.e2e.test.mjs` | 隔离的原 PDF.js viewer UI |
| `electron-html.e2e.test.mjs` | 相对资源/脚本、Node/API 隔离、路径穿越、源代码编辑保存与刷新；Java viewer |
| `electron-markdown.e2e.test.mjs` | 原 Vditor、富文本/源文本保存重开、本地图片、源模式图片/文本粘贴、设置持久化、`Ctrl+Alt+E` 双向切换、脚本隔离及 PDF/HTML/DOCX 导出 |
| `electron-http.e2e.test.mjs` | HTTP 编辑、私网确认、环境变量、真实请求和响应 UI；CodeMirror、大纲、诊断、文档链接、两类 CodeLens、`previewColumn=current` 与加密设置持久化 |
| `electron-git-history.e2e.test.mjs` | 真实仓库当前文件历史、原提交图、详情、工具栏和上下文菜单；Quick Sync 显示设置及持久化 |
| `electron-text-languages.e2e.test.mjs` | YAML/XML、NGINX、Kotlin、REG、TOML、Kusto 前端；XML 格式化保存 |

这些是已有自动化的实际边界。测试文件存在或最小样本通过，不等于复杂格式、全部操作和发布环境已经等效。

## 3. 必跑命令

```powershell
# 可重复安装与静态/构建门禁
npm ci
npm run desktop:typecheck
npm run desktop:build

# 桌面自动化
npm run test:desktop:unit
npm run test:desktop:e2e
npm run test:desktop:packaged

# 原扩展回归、Windows 打包与生产依赖
npm run build
npm run desktop:dist
npm audit --omit=dev
```

每次候选版本必须记录命令、退出码、持续时间、Node/Electron/Windows 版本、打包路径和 SHA-256。仓库当前没有只检查不改写的 lint script；打包自动化覆盖 `win-unpacked`，但仍没有覆盖 NSIS 安装流程与 portable 解包后的常驻自动化门禁。

## 4. 发布阻塞自动化矩阵

| ID | 场景 | 当前证据 | 发布前要求 |
|---|---|---|---|
| A-001 | 类型、桌面构建、原扩展构建 | 历史执行通过；当前最终提交仍需重跑 | 全部退出 0，无忽略错误 |
| A-002 | 单元与 Electron E2E 总门禁 | 19 个 unit 文件、16 个 E2E 文件均已纳入脚本；本轮 56/56 unit 通过，16 个 E2E 场景均已通过但聚合进程隔离仍需加固 | 每个候选均须全量执行，0 失败、0 跳过 |
| A-003 | renderer/preload/IPC 安全 | 静态配置、路径/大小校验和多个恶意 fixture 有局部证据 | 打包产物上验证 Node/任意 IPC/任意路径/导航/协议均不可越权 |
| A-004 | 保存/另存/脏状态 | 原子保存单测，XLSX/Word/Markdown/HTML/CSV 有保存 E2E | 只读、取消、EACCES、磁盘满、占用、保存中终止均不得截断或清脏 |
| A-005 | 外部修改与冲突 | watcher 与确认代码存在 | 无编辑时重载；有编辑时重载/保留/另存均可恢复，应用自身保存不循环 |
| A-006 | 全格式路由 | 现有 E2E 覆盖当前声明的主要格式集合 | 自动比较 selector/provider/桌面路由/fixture 集合；大小写、复合后缀、未知格式有断言 |
| A-007 | Office 语义保真 | 最小格式 UI 与部分保存证据 | 复杂 Excel/Word/PPT 黄金样本；公式/样式/图片/批注/媒体；真实宏不执行且不静默丢失 |
| A-008 | HTML/SVG/Markdown/PDF 安全 | 隔离 origin、脚本清理和 active SVG 有局部证据 | 覆盖 `file:`、`javascript:`、`data:`、弹窗、导航、任意文件读取、恶意 PDF 链接 |
| A-009 | 归档安全 | ZIP/TAR traversal、symlink、压缩比已有单测 | 所有后端统一覆盖绝对路径、设备名、条目数/展开量、密码失败、取消和临时清理 |
| A-010 | Git 操作安全 | 读取/安全分支操作和真实历史有证据 | 每个 remote/merge/cherry-pick/revert/reset/tag/stash/clean action 验证确认、取消、失败和状态一致 |
| A-011 | HTTP/AI/外部网络 | HTTP 重定向剥离、路径边界、AI key/取消有单测 | TLS/代理/断网/超时/大响应/401/限流；日志脱敏；未触发功能时零请求 |
| A-012 | 大文件与压力 | 512 MiB 文件拒绝、部分单文件大小限制 | 100 MiB PDF、50 MiB Office、100k 行表、海量图片/归档；取消、内存回收与 200 次开关文档 |
| A-013 | Windows 入口 | CLI 与第二实例有 E2E | 对话框、拖放、双击关联、中文/特殊/长路径行为等价 |
| A-014 | 打包 | 最终源码已生成 NSIS/portable；`win-unpacked` 打包 E2E 通过，portable XLSX 首屏检查通过；产物未签名，本机 portable 冷启动 32 秒 | 在干净 Windows 10/11 x64 做安装、升级、卸载、关联与 portable 复测，并配置正式代码签名 |
| A-015 | 依赖与许可证 | 当前 `npm audit --json` 为 0 漏洞 | 最终重新审计；维护第三方许可证清单，核对 Java/JAR、解码器、字体和压缩依赖 |

## 5. 人工与视觉等效矩阵

| ID | 场景 | 通过标准 |
|---|---|---|
| M-001 | 安装、升级、卸载、便携 | 开始菜单/卸载项/图标/许可证正确；升级保留设置；卸载不删用户文档 |
| M-002 | 文件关联 | 用户选择的格式可关联与恢复默认；双击路径无丢失 |
| M-003 | Windows 10/11、100/150/200% DPI、多显示器 | 无核心控件截断；窗口和对话框位置合理；图标/文字清晰 |
| M-004 | 中文输入法与中文/特殊路径 | Word/Excel/Markdown 输入不重不漏，候选窗正确，路径标题不乱码 |
| M-005 | 键盘与焦点 | 仅键盘可打开、切标签、保存、关闭和取消；快捷键只作用于当前工具 |
| M-006 | 辅助功能 | Narrator 有名称/角色/状态；焦点可见；颜色不是唯一状态信号 |
| M-007 | 脏关闭和外部冲突 | 关闭标签/窗口与外部写入均不会静默覆盖，取消确实阻止关闭 |
| M-008 | 原插件前端逐项对照 | 同一黄金文件并排对比；工具栏、菜单、内容、交互和错误 UI 的差异有截图与裁决 |
| M-009 | 断网、睡眠/唤醒、盘符断开 | 本地功能不受断网影响；网络失败可恢复；watcher 不风暴；盘符恢复可重载 |
| M-010 | 长时间与性能体感 | 冷启动、首屏、峰值内存和 UI 卡顿有机器/样本记录；无持续句柄或内存线性增长 |

## 6. 准出规则

- 所有 P0 自动化 100% 执行并通过，0 个已知 Blocker/Critical。
- 保存、路径穿越、任意 IPC/文件访问、秘密泄露、崩溃/冻结和静默格式损坏均为发布阻塞。
- `feature-parity.md` 每个能力必须同时有实现证据、自动化边界和必要人工/视觉证据；不能用 grouped smoke 代替逐项验收。
- NSIS 与 portable 必须基于最终源码生成，并在干净 Windows 10/11 x64 各至少一次实际启动。
- 未验证项目必须明确标记，不得因脚本存在、子任务完成或历史运行通过而写成当前候选已通过。

## 7. 执行记录模板

```text
执行批次：
Git commit：
Windows 版本/架构：
Node/Electron 版本：
命令与退出码：
测试文件/用例总数：
失败、跳过、未执行：
打包产物与 SHA-256：
日志/截图/视频路径：
缺陷与复测结果：
```

最终范围与当前差距见 [feature-parity.md](./feature-parity.md)。
