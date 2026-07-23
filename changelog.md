# Change log

# 0.5.6 Feature Batch 3: Inspection, Templates and Assistant Depth 2026-7-23

This release lands the third feature batch from the three module roadmaps (docs/plans/): 13 new features across HTML, Markdown and the AI assistant.

Desktop application:

- Disable background throttling on the main window: exports reveal their output in File Explorer, which can fully cover the app window, and Windows occlusion tracking then froze rAF/IntersectionObserver — editors, virtualized views and animations appeared dead while the process was alive.

HTML module:

- Local HTML validation (问题 panel): unclosed/mismatched tags, duplicate ids and deprecated tags with line numbers; clicking an issue jumps to the CodeMirror source line.
- Network request waterfall: per-resource start/duration bars colored by type, as a view toggle inside the resource panel.
- Dark mode simulation: rewrite prefers-color-scheme media queries plus a matchMedia patch, with 跟随系统 / 强制浅色 / 强制深色 toolbar modes.
- JS disable switch: reloads the preview with `script-src 'none'` CSP and reveals noscript content.
- In-preview text find (Ctrl+F): highlighted matches, counter and previous/next navigation inside the iframe.

Markdown module:

- Mermaid render error panel: failed diagrams show a structured inline error block with the failing line number, details and the offending source line.
- Dead-link and missing-image scanner (检查死链): scans relative links and image references, reports missing targets in a host panel, click to reveal the line in the editor.
- Template system (从模板插入): built-in templates (blank / meeting notes / weekly report / README) plus user templates from a userData directory; inserting replaces the content and marks the document dirty.
- Fix: inserting generated content (templates, AI TOC/summary) now re-enables the toolbar save button.

AI assistant:

- Edit and resend history messages: inline editing on user bubbles, truncates later turns and re-attaches the original selection snapshot.
- Ollama model discovery: the model field offers a datalist from the probed /api/tags model list, falling back to free input.
- Model parameters: global temperature / maxTokens settings injected per protocol (OpenAI, Anthropic, Gemini, Ollama; CLI providers ignored).
- Pre-send sensitive data detection: private keys, tokens, AWS keys, e-mails and Chinese ID numbers (checksum-validated) trigger a masked confirmation bar before sending.
- Settings dialog restructured into four tabs: 常规 / Provider / 动作 / 关于.

# 0.5.5 Feature Batch 2: Debug Tooling, Writing Modes and Assistant Upgrades 2026-7-23

This release lands the second feature batch from the three module roadmaps (docs/plans/): 16 new features across HTML, Markdown and the AI assistant.

Desktop application:

- Fix the Word editor swallowing the first click after loading: the antd fullscreen Spin mask stayed mounted while fading out and intercepted hit-testing, so fast clicks never reached the editor (Word.tsx now unmounts the mask as soon as loading ends).

HTML module:

- Console panel: captures console log/warn/error plus uncaught exceptions from the sandboxed preview through an injected inspector bridge, level-colored and clearable.
- Resource list panel: name/type/size/duration/status of page resources (PerformanceResourceTiming with a DOM-scan fallback for opaque origins).
- Performance metrics bar: DCL / FCP / LCP / resource count and total bytes via PerformanceObserver.
- Responsive device presets: Desktop / iPhone 390×844 / iPad 820×1180 / custom size with a device frame, coexisting with the 50–200% preview zoom.
- Full-page screenshot PNG export (导出 PNG) through the hidden-window capturePage pipeline, written next to the source file.

Markdown module:

- Export plain text (导出纯文本): strips Markdown syntax (front-matter optional) and writes a .txt next to the source file.
- Focus mode (专注模式): typewriter scrolling with the current block highlighted.
- Zen mode (禅模式): distraction-free fullscreen, ESC to exit.
- Drag any file into the editor to insert a relative `[name](path)` link; images still go through the image service.
- AI one-click TOC / summary generation (AI 生成目录 / AI 生成摘要) inserted at the top of the document through the streaming polish pipeline.

AI assistant:

- Selection floating action bar (解释 / 翻译 / 引用到助手) over the text, Markdown and HTML viewers, wired through a cross-iframe selection bus.
- Custom quick actions: create, edit and reorder in the settings dialog, merged into the quick-action bar and the slash-command palette.
- Prompt library: save frequent prompts and insert them into the composer from a panel.
- Global invoke shortcut (Ctrl+Shift+Space, toggleable) focuses the main window and opens the assistant panel.
- Real network probing for HTTP providers: latency and model lists (/v1/models, Ollama /api/tags) shown in the settings dialog.
- Custom system prompt profile: persona / output language / style injected ahead of the safety rules.

# 0.5.4 Feature Batch 1: Markdown, HTML and AI Assistant 2026-7-23

This release lands the first feature batch from the three module roadmaps (docs/plans/).

Markdown module:

- Print the current document (context menu 打印 / Ctrl+Cmd+P) through a hidden sandboxed print window.
- Export long-image PNG (导出长图): full-page rendering of the document next to the source file.
- One-click TOC toolbar button: inserts or updates a `[toc]` marker (fence-aware, idempotent).
- Live word count chip: CJK-aware 字数/词数/预计阅读时长, debounced, in the editor corner.

HTML module:

- CodeMirror 6 source editor replacing the plain textarea: HTML highlighting, auto close tags/brackets, line numbers, search keymap.
- Format source button (built-in indentation formatter, desktop/shared/html-format.ts).
- Preview zoom control (50–200%) and an insert-snippet menu with six templates (tab stops).
- Export PDF via a new hidden-window IPC pipeline (`office-desktop:html:export-pdf`).

AI assistant:

- Regenerate the last answer; export the conversation as Markdown; per-message latency/size stats (first-token/total time, characters).
- Context extraction indicator in the context bar (strategy, extracted/source characters, truncation badge).
- Slash commands in the composer ('/' opens the quick-action palette with keyboard navigation).
- Five new built-in quick actions: 改写语气, 压缩篇幅, 生成会议纪要, SWOT 分析, 对比选段与全文.

# 0.5.3 Tahoe Polish and Interaction Fixes 2026-7-23

Desktop application:

- Fix a data-loss class of bugs where the global Office host bridge let a hidden document's save route to the wrong session or silently no-op; bridges are now an activation stack driven by the visible document.
- Make the dirty-close confirmation compute against fresh document state so confirming can no longer discard tabs opened while the dialog was up.
- Restore window dragging on the frameless window (`-webkit-app-region` on the title bar) and stop text drags from triggering the file drop overlay.
- Fix document tabs and recent files appearing dead while Git History is open; opening files, tabs or recents now leaves Git History.
- Keep assistant conversations per document: opening Git History no longer aborts in-flight requests or wipes the chat, and selections inside Git History no longer leak into prompts.
- Close app menus on outside click, surface open/sync errors with a document open (floating banner), and re-register recent files on reopen so metadata and watchers refresh (new `openPaths` IPC).
- Assistant: throttle streaming Markdown re-renders (memo + deferred), stop forced scroll-to-bottom while reading, retry without duplicating the user bubble (and keep the original selection context), open reply links externally, disable quick actions for unavailable providers, and clean up resize listeners on pointer cancel.
- Show the real app version (injected from package.json at build time) in the About dialog.

Design (macOS 26 Tahoe / Liquid Glass):

- Add specular highlights, deeper translucency, larger corner radii (8/10/16px) and spring motion curves across the shell and assistant.
- Float the tab strip and metadata bar as rounded glass islands; smooth 300 ms light/dark theme crossfade; menu/message pop-in animations.
- Enable Windows 11 Mica window material (gated by build 22621+) with a transparent-shell fallback for other platforms.
- Refine typography toward macOS defaults and switch icons to a lighter 1.5px stroke with a rounded app mark.

# 0.5.2 macOS Design Language Redesign 2026-7-23

Desktop application:

- Completely redesign the desktop shell with an Apple macOS design language: system color palette (light `#f5f5f7` / dark `#1e1e20`), macOS blue accent, SF-style system font stack, unified corner-radius scale and soft ambient shadows.
- Style the frameless window controls as macOS traffic lights with hover glyphs and pressed feedback.
- Restyle menus as frosted rounded popovers, document tabs as Safari-style floating capsules, and file-type tokens as tinted rounded badges.
- Rework the welcome screen, metadata bar and status bar with Finder/inspector-inspired typography, frosted translucency and macOS focus rings and transitions.
- Rebuild the AI assistant launcher, panel, chat bubbles and settings dialog in a macOS Notification Center style.
- Add a desktop-only Ant Design theme so dialogs and inputs match the macOS shell without affecting the VS Code extension.
- Re-map viewer theme variables so embedded document viewers follow the desktop light/dark macOS theme.

AI assistant:

- Fix Claude Code requests always failing: `--print --output-format stream-json` now passes the required `--verbose` flag.
- Retry CLI requests once without version-specific flags (`--safe-mode`, `--ignore-user-config`, `--ignore-rules`) when an older CLI rejects them.
- Surface Codex stdout error events (`turn.failed`, non-transient `error`) in the UI instead of a generic exit-code message.
- Skip redundant Claude assistant/result snapshots after streamed deltas so responses no longer appear duplicated.
- Pass proxy, API-key and certificate environment variables through to local CLI providers.
- Discover Codex and Claude executables in more install layouts (Codex desktop `bin` directories, `%USERPROFILE%\.local\bin`).
- Show the probe failure reason next to unavailable local providers instead of only disabling the send button.
- Render assistant replies as rich Markdown (headings, lists, tables, syntax-highlighted code blocks, quotes) instead of plain pre-wrapped text, using markdown-it with raw HTML escaped.

# 0.5.1 Desktop Layout Hotfix 2026-7-22

Desktop application:

- Fix the desktop shell failing to expand after Windows DPI or viewport changes, which left a large blank area below the status bar.
- Pin the header, tab strip, workspace and status bar to explicit grid rows so the fixed AI assistant cannot disturb the application layout.
- Keep the Markdown editor-theme picker within its compact height after the document viewport expands.
- Add Electron regression assertions that require both the application shell and status bar to reach the viewport bottom.

Release engineering:

- Make the Windows Release workflow upload versioned installers without hard-coded `0.5.0` filenames.

# 0.5.0 Desktop Baseline 2026-7-22

This release establishes the first independently maintained Windows desktop baseline.

Desktop application:

- Add a standalone Electron host instead of wrapping the VS Code workbench.
- Recreate the Office Viewer visual language with compact title, menu, tab, metadata and status areas.
- Add native Windows open/save dialogs, drag-and-drop, recent files, file associations, single-instance handoff and atomic saves.
- Preserve the original Word editor, Excel editor, PowerPoint viewer, Markdown editor and the broader document-format matrix.
- Add the complete Git History workspace to the desktop application.
- Add safe archive browsing and editing for ZIP/JAR/VSIX/APK/RAR/7Z/TAR/TAR.GZ/TGZ.
- Add desktop HTTP/REST requests, text-language services, HTML preview and Java class decompilation.

AI assistant:

- Add a document interaction assistant in the lower-right corner.
- Support local Codex CLI, Claude Code CLI, Ollama, OpenAI-compatible providers, Anthropic and Gemini.
- Include DeepSeek and Kimi presets plus user-defined providers.
- Protect API credentials with Electron safeStorage and Windows security storage.
- Detect providers only when the assistant is opened.
- Cache extracted document context by normalized file path, modification time and file size.

Performance:

- Cache parsed Excel, Word and PowerPoint data with bounded LRU policies.
- Move Excel, TIFF and Word pre-parsing to background workers.
- Release parser workers after their request queue becomes idle.
- Keep dirty editors alive while clean documents reuse parsed caches.
- Add real Electron benchmarks for cold start, first document, tab switching, AI first token and memory peaks.
- Reduce packaged XLSX tab-switch P95 from 237.9 ms to 37.6 ms on the baseline machine.

Quality and security:

- Add 56 desktop unit tests and Windows Electron end-to-end coverage across the supported format families.
- Add file-session authorization, path traversal defenses, archive bomb limits, private-network controls, active-content filtering and credential redaction.
- Add Windows CI, a manually dispatched Windows Release workflow, standalone documentation and reproducible screenshots.
- Fix bitmap-only Windows clipboard paste and prevent source/visual Markdown mode round-trips from becoming falsely dirty.

Known limitations:

- Editable Word documents still require buffer-based initialization in the third-party editor; worker pre-parsing is used for prewarming/read-only flows, with draft buffering for edit correctness.
- Release executables are not Authenticode-signed yet.

# 4.1.6 2026-7-20

Markdown Editor:

- Focus the find input after clicking the find button.
- Fix anchor and footnote jump failure in documents.

Excel:

- Add formula bar.
- Improve VS Code theme compatibility.
- Add an Edit in VS Code action to the CSV editor toolbar.
- Add filter changes to history and increase zoom debounce delay.
- Fix:
  - Fix inability to save edited empty CSV files.
  - Sync clipboard highlight when switching sheets.
  - Prevent image selection when selecting a range.
  - Prevent images from appearing across all sheets.

Diff:

- Skip CSV and DOCX files in diff view.

# 4.1.5 2026-7-8

Fix:

- Fix unexpected file reload on edit.
- Prevent Zip Slip path traversal in archive extraction(Reported by Mykhailo Kholiev).

Git History:

- Improve git history view UI.
- Change date format to yyyy-MM-dd.
- Support more remote URL formats.

Markdown Editor:

New:

- Add Shift+Tab support.
- Add typewriter mode support.
- Add new line button for quick row insertion.
- Support quick drag to resize images(Pro Feature).

Update:

- Improve large file editing performance.
- Add replace feature to find component.
- IR mode: support block drag-and-drop and table enhancements.
- Beautify context menu and settings modal.
- Remove automatic double quote completion.
- Remove default 400px code block height limit.

Fix:

- Fix failure to edit tags and wikilinks normally.
- Fix extra blank line left after deleting sublist
- Fix settings modal closing when deleting prompt or model.

Excel:

Update:

- Copy cells with HTML formatting.
- Support zoom adjustment via scroll wheel.
- Preserve formatting when pasting from Excel.
- Support editable image drag and resize.
- Support cell selection in config function.
- Improve user interaction and context menu appearance.
- Change page scrolling from cell-based to pixel-based.

Fix:

- Fix find component focus accuracy.
- Fix vertical alignment display error.
- Fix cell text overflow, editor overlay, and row height.
- Fix cell interaction and descending sort after sorting.

# 4.1.3-4 2026-7-3

Fix:

- Fix SVG loading failure.
- Fix PPTX loading failure.

# 4.1.2 2026-7-3

Markdown Editor:

- Improve AI review panel.
- Add quick action presets for AI Polish.
- Add output language selection for AI Polish.

Fix:

- Fix math formulas and diagrams (Mermaid, PlantUML) not rendering correctly after code block lazy-loading optimization.

# 4.1.1 2026-7-3

Markdown Editor:

- Add code search support within code blocks.
- Improve editor performance when handling multiple code blocks.

Export:

- Move PDF export margin inside the content container.
- Upgrade html-to-docx for improved DOCX export quality.
- Dynamically load export dependencies (HTML, DOCX, PDF) to reduce extension size.

Git History:

- Add warning echo for Git operations.
- Fix graph being incorrectly dimmed.
- Align author filter options and simplify filtered graph.

Update:

- Improve view rendering performance.
- Replace cheerio with node-html-parser.
- Dynamically load Mermaid and Puppeteer to reduce extension size.

Fix:

- Resolve inline HTML rendering issue.
- Resolve file loading failure on Windows virtual space.

# 4.1.0 2026-7-1

New: Add Parquet file format support.

Markdown Editor:

- Improve visual design.
- Update keyboard shortcuts.
- Support code block font configuration.
- Improve light/dark mode switching logic.
- Fix failure to open relative path files in IR mode.
- Support font size adjustment via scroll wheel in the editor.

Pro:

- Introduce Pro license activation.
- Remove Sponsor banner after Pro activation.
- Support custom font color and background color editing.
- Support adjusting image width and height in the Markdown editor.
- Support beautiful PDF / HTML / DOCX export with theme, font, and font-size options.

Git History:

- Improve visual design.
- Adjust Git branch colors for better visibility in light mode.
- Gray out non-current commits while loading Git history view.
- Fix color inconsistency between graph lines and branches in Git history view.

# 4.0.9 2026-6-29

Update:

- Restore missing HTML viewer previewer registration.
- Fix outline loading failure caused by special headings (code blocks, line breaks).
- Improve file loading performance by streaming via webview URI instead of message buffer transfer.

# 4.0.8 2026-6-29

Markdown editor:

Update:

- Add image preview.
- Beautify CodeMirror toolbar.
- Disable latex syntax validation.
- Remember last selected theme preference.
- Sync settings to other editors after modification.
- Support expandable code blocks with configurable height.

Git History:

- Improve Git view and Git history view styling.
- Support double-click to quick push in Git view.
- Git history view supports pull and batch operations.

Fix:

- Support saving links with spaces.
- Fix class file decompilation failure.
- Fix Wikilinks in remote environment.
- Preserve bold text color in light theme.
- Prevent file cache generation after each view.
- Fix relative links and images in remote environment.
- Fix markdown editor loading issue for Russian locale.
- Fix the missing margin for the first child element at the top of the page.

# 4.0.7 2026-6-26

New:

- Support editing Vditor configuration via a configuration file.
- Markdown editor supports remote and web workspaces (vscode-vfs, vscode-remote).

Update:

- Beautify alert color.
- Improve PDF loading performance.
- Improve Git history view styling.
- Improve TIFF/HEIC loading performance.
- Change the default Excel font size to 11.
- Remove Git history caching for more accurate data.

Markdown:

- Add AI polish usage tip in settings panel.
- Fix CodeMirror font not syncing with typography settings.
- Fix pasted math formula blocks being converted into code blocks.

Fix:

- Fix incorrect read-only mode detection.
- Fix remote URL order in Git view with multiple repositories.

# 4.0.6 2026-6-26

New:

- Full support for Excel.
- Support editing DOCX files.
- Support the web version of VS Code.

Markdown:

- Support Wikilinks.
- Support AI-powered polishing.
- Support configuring editor typography.
- Support previewing and editing inline HTML.
- Support highlighting and autocompletion for latex formulas.

# 4.0.5 2026-6-23

Important: **Refactor Markdown editor**: beautified UI with modernized toolbar, in-page search (Ctrl/Cmd+F), and real-time code block editing

Other:

- Update Material Icons
- Add Kusto (KQL) syntax highlighting
- Beautify Git history view: refreshed styling and a commit details panel
- Support batch Git operations: push branches, add tags, and delete tags across multiple remotes in one action

# 4.0.4 2026-6-19

New:

- Add Kotlin syntax highlighting
- Add Nginx conf syntax highlighting
- Add anonymous usage telemetry (respects VS Code global telemetry settings)

Update:

- Beautify the SVG and PDF view
- Hide sponsor banner in Excel view while loading
- Refresh Git history after deleting filtered branches

# 4.0.3 2026-6-18

Important:

- Redesign the One Dark Modern theme
- Add Git history management feature

New:

- Add SVG editor
- Add support for ODS format
- Add syntax highlighting for TOML
- Add YAML outline and anchor navigation support

Update:

- Add dark mode toggle to PDF viewer
- Update markdown editor default theme
- Add icons for Parquet, SQLite, and DuckDB
- Change the default PPTX view to light mode
- Support quick switch color in markdown editor

# 4.0.2 2026-6-15

- Integrate HTTP client for `.http` and `.rest` files
- Support XMind, PSD, ICNS, HEIC and TIFF formats

# 4.0.1 2026-6-14

- Better zip viewer
- Fix excel save tip gone

# 4.0.0 2026-6-14

- Support pptx and epub files
- Support 7zip and tar.gz archives
- Better support for docx, excel, pdf and archives

# 3.5.7 2026-6-12

- Fixed paste image failed in markdown editor

# 3.5.6 2026-6-10

- Update puppeteer-core version
- Beautify zip,font,image and markdown view
- Fix command 'office.markdown.paste' hijacks ctrl/cmd+v

# 3.5.5 2026-6-8

- Update mermaid version
- Integrate Vditor resources
- Fix Excel cell shortcut keys not working on MacOS

# 3.5.4 2025-4-28

- Support edit excel and csv file.

# 3.5.3 2025-4-17

- Support view rar file.

# 3.5.2 2025-4-10

- Compatible with rest client.

# 3.5.1 2025-4-7

- Better support for zip viewer.
- Update extension name and icon.
- Support export markdown with Mermaid.

# 3.5.0 2025-1-14

- Remove markdown editor border.

# 3.4.8 2024-12-14

- Modify the font of the markdown editor.

# 3.4.6 2024-12-13

- Add more markdown editor theme.
- Support refresh for zip viewer.

# 3.4.2 2024-9-28

- Fixed "Edit In VS Code" shortcut not working.
- Fixed copying content failure in preview mode.

# 3.3.4 2024-6-4

- Better csv and zip support.

# 3.3.3 2024-5-6

- Support edit svg in VS Code.
- Fix shortcut key conflict with Copilot.
- Support display font item name and search font item.

# 3.3.2 2024-4-6

- Support sort zip items.

# 3.3.1 2024-3-30

- Update font and pdf viewer.

# 3.3.0 2024-3-29

- Rewrite the UI front end using React.

# 3.2.5 2024-3-8

- Add shortcut document.
- Update editor switch icon.
- Fix load chinese zip entry failed.

# 3.2.4 2024-3-5

New:

- Support view woff2 font.
- Support modifying editor theme individually.

Markdown

- Follow vscode editor font size.
- Add button to quick switch markdown editor.

Other:

- Support edit in vscode for csv.
- Support edit in vscode for svg.
- Only use image viewer for svg.

# 3.2.0 2024-3-4

- Use vscode default editor when diffing.
- Fix cannot save outline state for macOS.
- Fix cannot find chromium path on macOS.

# 3.1.7 2023-9-32

- Fix export markdown to docx fail.

# 3.1.5 2023-5-18

- Support view apk file.

# 3.1.4 2023-5-4

- Support view zip file.

# 3.1.2 2023-4-25

- Change inactive tab foreground color.

# 3.1.1 2023-4-24

- Update peek view colors.
- Remove semantic highlighting.

# 3.1.0 2023-4-13

- Better theme colors.
- Markdown:
  - Katex compatible wrong formula.
  - Load the chart with a white background.
  - Support for rendering latex formulas in an offline environment.

# 3.0.4 2023-4-11

- Modify the background color of the theme.

# 3.0.2 2023-4-5

- Update extension icon.

# 3.0.1 2023-4-3

- Fix git view cannot view pictures.
- Support for reloading workspace docx after file changes.
- PDF:
  - Fixed sometimes opening PDF failed.
  - Do not display the sidebar on small screens.
  - Support export markdown to pdf without outline.

# 3.0.0 2023-3-29

- Better docx rendering.

# 2.9.6 2023-3-7

- Reduce the size of the excel save notice.
- Support resizing the view through ctrl/meta with mouse scrolling.
- Word:

  - Fix cannot display images.
  - Fix pager jumping incorrectly.
  - Reduce pagination navigator size.
- Markdown:

  - Support hide toolbar.
  - Fix extension activation failure when rest client exists.
  - Support open hyperlinks via meta or middle mouse button.

# 2.9.5 2023-1-12

- 更新主题的editorInlayHint颜色.
- Markdown:
  - 代码块预览增加行号显示.
  - 支持配置代码块颜色样式.
  - 粘贴图片路径增加workspaceDir变量.
  - 修复无法导出PDF.
  - 修复无法显示绝对路径的图片.

# 2.9.4 2022-12-20

- 调整代码块颜色.
- 支持设置导出pdf的chromium路径.

# 2.9.3 2022-12-10

- 修复Pdf部分字体无法加载.
- QuickItem和菜单的border颜色优化.

# 2.9.2 2022-12-6

- 修复表格工具栏消失.
- 保存xlsx时增加确认框.
- 导出Html和docx时不生成目录.
- 修复图片过多时无法显示图片文件名.

# 2.9.1 2022-11-23

- 调整markdown编辑器小屏下的大纲宽度
- Markdown转换的Pdf调整页面边距.

# 2.9.0 2022-11-9

- Speed up extension activation.

# 2.8.1 2022-10-29

- Fix preview html unable to load images.
- Markdown:
  - Support export to docx.
  - Fix hr can not display on dark theme.
  - Edit math formulas using different background colors.
  - Fix export pdf not rendering math formulas that start or end with spaces.

# 2.8.0 2022-10-24

- Change markdown editor default language to english.
- Supporting change of language for editor [en_US, ja_JP, ko_KR, ru_RU, zh_CN, zh_TW]

# 2.7.9 2022-10-23

- 修复小屏下工具栏丢失.

# 2.7.8 2022-10-19

- Markdown:
  - 修复导出的pdf数学公式显示异常.
  - 优化自带主题的markdown显示效果.
- Pdf:
  - 优先显示大纲视图.
  - 美化部分视觉效果.
  - 修复只能显示二级大纲.

# 2.7.7 2022-10-18

- markdown:
  - 升级katex版本.
  - 固定工具栏位置.
  - 记住文件最后的编辑位置.
  - 修复切换不同的markdown总数没有更新.
  - 修复小屏下工具栏样式异常, 以及无法显示大纲.

# 2.7.5 2022-10-12

- 优化大纲切换的焦点.

# 2.7.4 2022-10-11

- markdown
  - 修复字数没有实时更新.
  - 修复diff视图无法显示图片.
  - 修复部分情况下在外部编辑后没有实时更新.
- 修复excel无法保存更新.
- 图片浏览器支持通过ctrl+滑动放大图片.

# 2.7.3 2022-10-5

- 完善焦点聚焦逻辑.
- 支持ctrl+shift+v粘贴为纯文本.
- 增加自动清理webview缓存.
- Markdown:

  - 自动识别粘贴的图片类型.
  - 修复粘贴文本后选中的文本还在.
- 预览Html支持解析本地js文件.

# 2.7.2 2022-9-15

- 移除图片中的空格.
- 修复latex公式显示不全.

# 2.7.1 2022-9-5

- 优化编辑器焦点恢复功能.

# 2.7.0 2022-9-2

- 升级vditor版本.
- 增加设置编辑器焦点的延迟.
- 美化右键菜单样式, 点击其他地方后隐藏菜单.

# 2.6.9 2022-8-29

- 修复代码块背景颜色异常.

# 2.6.8 2022-8-28

- Markdown: 修复显示绝对路径图片的设置无效.
- Xlsx:
  - 支持查看xlsm文件.
  - 加快excel文件打开速度.
  - 修复xlsx超过26的列无法显示.

# 2.6.7 2022-8-28

- Markdown:
  - 修复分割线无法显示.
  - 移除单引号和美元符号的补全.
  - 导出的pdf目录序号修改样式为圆圈.
  - 支持关闭代码预览, 修改代码块背景颜色.
- 修复查看docx文件时, 如果页面数量页面错乱.

# 2.6.1 2022-6-19

- 修复在Vditor无法打开相对路径的markdown.

# 2.6.0 2022-6-13

- 对主题的自适应功能进行优化.
- 修复编辑markdown时输出了无关日志.

# 2.5.8 2022-6-7

- 支持打开dotx文件
- markdown编辑器支持打开图片超链接
- 更新超链接颜色

# 2.5.7 2022-6-7

- 优化粘贴图片的逻辑
- 优化自动主题颜色的边框颜色
- 保存后更新字数总数
- 修改默认代码主题

# 2.5.5 2022-5-28

- 支持配置markdown粘贴图片的路径
- 更新vditor版本

# 2.5.1 2021-12-29

- 增加稳定性, 修复图片有时保存失败
- Support save outline open state.

# 2.5.0 2021-12-27

- Update markdown editor:
  - To open a hyperlink, need to hold down ctrl.
  - Support chose image from toolbar.
  - Update editor when external update.
  - Open source code editor as beside.
- Fix puml editor not trigger save.
- Fix html preview not support untitle document.

# 2.4.2 2021-12-4

- Fix markdown editor cannot cut, loss focus.

# 2.4.1 2021-9-9

- Rollback docx support.
- Fix http auto-complection fail.
- Reduce markdown editor cache usage.

# 2.4.0 2021-8-3

- Better http client support.
- Fix markdown editor cannot save.

# 2.2.2 2021-6-19

- Speed up picture pasting

# 2.2.0 2021-6-2

- Not trigger vscode hotkey when match markdown hotkey.
- Support immediately preservation.

# 2.1.1 2021-5-27

- Change vditor mode from ir to wysiwyg.
- Fix markdown cannot type tab.
- Reduce markdown editor padding.

# 2.0.0+

- Support ods file.
- Remove top button of word document.
- Remove markdown style.
- Support inline markdown.
- Support export to html.
- Markdown support auto quote.
- Change viewer name as editor.
- Change default markdown editor as vditor.

# 1.9.1 2021-1-18

- Fix cannot view big xmind.
- Support follow theme with docx viewer.
- Image viewer support show pixel.

# 1.9.0 2020-12-30

- Support view csv file with utf8 encoding.

## 1.8.9 2020-12-21

- Update java decompiler version, change priority as option.
- Markdown editor support paster as plain text.

## 1.8.1 2020-11-24

- Change export markdown pdf chinese font to 'Song  style'
- Export markdown auto add bookmarks.
- Update markdown list style.

## 1.8.0 2020-11-24

- Support play flash swf animation.

## 1.7.10 2020-11-23

- Support open link from markdown.

## 1.7.9 2020-11-19

- support paste image file in markdown editor.

## 1.7.7 2020-11-17

- Update status bar when open markdown editor.

## 1.7.5 2020-11-11

- Add java class decompiler.

## 1.7.1 2020-11-3

- Support generate outline for pdf.

## 1.7.0 2020-11-2

- Support export markdwon to pdf.
- Support edit xlsx、xls、csv.

## 1.6.0 2020-10-19

- Add font viewer.
- Adjust markdown style and fix save fail bug.

## 1.5.0 2020-10-16

- Enhance Image viewer.

## 1.4.3 2020-10-12

- Fix paste fail in terminal.
- Using hyperMD as default markdown editor.

## 1.4.0 2020-10-9

- Integrate stackedit to edit markdown.
- Add csv support.

## 1.3.0 2020-10-8

- Add plantuml support.
- Adjust svg css.

## 1.2.0 2020-10-8

- Add pdf support.
- Add xmind support.

## 1.1.0 2020-10-8

- Add epub support.
- Add svg support.
- Add photoshow support.
- Add windows reg support.
- Add paginition to docx view..
