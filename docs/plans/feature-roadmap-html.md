# HTML 模块功能路线图（30 项）


> **进度（v0.5.4）**：已交付 ✅ 1 CodeMirror 编辑器（含 3 自动闭合）、4 格式化、22 缩放、8 片段模板、26 导出 PDF。
> **进度（v0.5.5）**：批次 2 ✅ 9 控制台面板、12 资源清单面板、14 性能指标条、16 响应式设备预设、25 整页截图 PNG 导出。
> **进度（v0.5.6）**：批次 3 ✅ 6 HTML 本地校验、13 网络请求瀑布、18 深色模式模拟、20 JS 禁用开关、27 预览内文本查找（跳过 L 级大项 10 DOM 检查器、29 axe 无障碍）。

> 基线：沙箱预览 iframe（`office-html:` 协议 + 严格 CSP）、分屏源码编辑（textarea）、保存/另存、外部变更 live reload。当前宿主仅 116 行（`DesktopHtmlDocumentViewer.tsx`），是三模块中扩展空间最大的。
> 扩展点：宿主工具栏手写 JSX（加按钮成本低）；协议处理器是服务能力入口；CodeMirror 生态已在项目内（`@codemirror/*` 全套依赖）。

## 源码编辑器升级

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 1 | CodeMirror 6 替换 textarea（HTML 高亮/折叠/搜索/多光标） | P0 | M | 复用 `DesktopTextDocumentViewer.tsx` 的 CM 封装 |
| 2 | Emmet 缩写展开（ul>li*3 → 完整标签） | P1 | M | @emmetio/codemirror6-plugin |
| 3 | 自动闭合标签与括号 | P0 | S | @codemirror/autocomplete closeBrackets + html 扩展 |
| 4 | 源码格式化（js-beautify，可配缩进） | P0 | S | 工具栏按钮 + 格式化库 |
| 5 | 源码压缩 minify（去注释/空白） | P2 | S | html-minifier 类库 |
| 6 | HTML 本地校验（未闭合标签/重复 id/弃用标签规则集） | P1 | M | 校验模块 + 问题面板 |
| 7 | 保存前后 diff 视图（Monaco/CM diff 或简单高亮） | P1 | M | 宿主 diff 面板 |
| 8 | 片段/模板库（HTML5 骨架、表单、表格、卡片等一键插入） | P0 | S | 片段菜单 + 内置模板 |

## 调试与检查

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 9 | 控制台面板（捕获 iframe console/error/warn 分级显示） | P0 | M | preload 注入桥 + 宿主面板 |
| 10 | DOM 检查器（元素树展开 + 属性/样式查看） | P1 | L | iframe 桥（postMessage 序列化 DOM） |
| 11 | 元素点击选取 → 源码定位（inspect 模式） | P1 | L | 注入覆盖层 + 源码映射 |
| 12 | 资源清单面板（css/js/img 列表、大小、加载状态） | P0 | M | PerformanceResourceTiming 读取 |
| 13 | 网络请求瀑布（时间轴可视化） | P1 | M | Performance API + 面板 |
| 14 | 性能指标条（DCL/FCP/LCP/资源总量） | P1 | S | PerformanceObserver |
| 15 | LocalStorage/Cookie 查看器（只读 + 清除） | P2 | M | iframe 桥读取 |

## 预览与模拟

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 16 | 响应式设备预设（iPhone/iPad/Desktop + 自定义宽高） | P0 | M | iframe 容器尺寸切换 + 设备框 |
| 17 | 设备横竖屏旋转 | P1 | S | 尺寸交换 |
| 18 | 深色模式模拟（注入 prefers-color-scheme） | P1 | S | iframe 样式/媒体注入 |
| 19 | 打印媒体模拟（print stylesheet 预览） | P2 | S | 媒体类型切换 |
| 20 | JS 禁用开关（无脚本重载，CSP 动态调整） | P1 | M | 协议处理器参数 |
| 21 | CSS 调试样式注入（outline 所有元素等调试 snippet） | P2 | S | 注入菜单 |
| 22 | 预览缩放控制（50%–200%） | P0 | S | iframe zoom/transform |

## 导航与输出

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 23 | 预览内多页导航（站内链接可点击跳转 + 前进/后退） | P1 | M | 协议处理器会话导航栈 |
| 24 | 地址栏（当前预览 URL 显示 + 输入跳转同目录页面） | P1 | M | 工具栏扩展 |
| 25 | 整页/可视区截图 PNG 导出 | P0 | M | 复用 markdown-export 隐藏窗口 capturePage |
| 26 | 打印/导出 PDF | P0 | M | printToPDF（同上模式） |
| 27 | 预览内文本查找（Ctrl+F 高亮跳转） | P1 | M | 注入查找脚本 |
| 28 | SEO/meta 检查面板（title/description/og/ canonical 解析评分） | P2 | M | DOM 解析 + 规则评分 |
| 29 | 无障碍审计（axe-core 报告：对比度/aria/alt） | P1 | L | axe-core 注入 + 报告面板 |

## 基础

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 30 | 模块 i18n 化（硬编码中文 → i18n 10 语言） | P0 | S | 宿主 JSX |

## 建议批次

- **批次 1（编辑器基础）**：1 CodeMirror、3 闭合、4 格式化、8 模板、22 缩放、26 导出 PDF、30 i18n
- **批次 2（调试核心）**：9 控制台、12 资源清单、14 性能指标、16 设备预设、25 截图
- **批次 3（检查与模拟）**：6 校验、10 DOM 检查、13 瀑布、18 深色模拟、20 JS 开关、27 查找、29 axe
- **批次 4（深度）**：2 Emmet、5 minify、7 diff、11 元素定位、15 存储查看、17 旋转、19 打印媒体、21 CSS 注入、23 多页导航、24 地址栏、28 SEO
