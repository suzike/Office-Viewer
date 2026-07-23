# AI 交互助手功能路线图（30 项）


> **进度（v0.5.4）**：已交付 ✅ 4 导出对话、6 重新生成、9 context 提取指示、14 斜杠命令、20 新增 5 动作、25 用量耗时显示。
> **进度（v0.5.5）**：批次 2 ✅ 13 选区悬浮操作条、15 自定义快捷动作、16 提示词库、19 全局唤起快捷键、21 HTTP 网络探测、24 自定义系统提示词。
> **进度（v0.5.6）**：批次 3 ✅ 5/22/23/27/30（跳过 2/8/10/11）

> 基线：5 类 provider（Codex/Claude CLI + OpenAI 兼容/Anthropic/Gemini/Ollama）、10 个快捷动作、选区上下文（16K）、流式 Markdown 渲染、safeStorage 密钥、提示注入防护、每文档会话缓存（2026-07 新增）。
> 扩展点：`DEFAULT_ACTIONS` 一行加动作；provider kind 加适配分支；`extractDocument` 加提取策略；controller 全 prop 驱动易加面板功能；`AssistantMessage.references`/`onReferenceActivate` 死管道可启用。

## 会话管理

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 1 | 对话持久化（userData 按文档存储，重启恢复） | P0 | M | 新 conversation-service + controller |
| 2 | 多会话管理（新建/切换/重命名/删除，侧栏列表） | P1 | L | conversation-service + 面板 UI |
| 3 | 按文档恢复会话（重开文档自动载入上次对话） | P0 | M | 同 1 |
| 4 | 导出对话（Markdown/JSON 下载） | P0 | S | 头部菜单 + 序列化 |
| 5 | 编辑并重发历史消息 | P1 | M | 消息气泡编辑态 + 重发逻辑 |
| 6 | 重新生成（仅重跑最后一条回答） | P0 | S | lastRequestRef 已有基础 |
| 7 | 会话分支 fork（从任意消息分叉） | P2 | L | 会话树模型 |

## 上下文与引用

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 8 | 答案引用落地（references 跳转/高亮文档片段） | P1 | L | ai-document-context-service 产出片段 + viewer 联动 |
| 9 | context 事件 UI（提取策略/字符量/截断提示徽标） | P0 | S | controller 已收到 context 事件（当前忽略） |
| 10 | 多标签页联合上下文（勾选多个打开文档） | P1 | L | context-service 多会话提取 |
| 11 | 附件支持（额外文件注入上下文，50 页/格上限） | P1 | M | 附件选择 + context-service |
| 12 | RAG-lite 分块索引（大文档按语义块检索注入） | P2 | L | 新 chunk-index-service |
| 13 | 选区悬浮操作条（选中文档文字 → 浮出"解释/翻译/引用到助手"） | P1 | M | document-surface 覆盖层 |

## 输入与效率

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 14 | 斜杠命令（/总结 /翻译 等，输入框自动补全） | P0 | M | composer 命令解析 |
| 15 | 自定义快捷动作编辑（增删改 + 排序，持久化） | P1 | M | 设置对话框新分组 |
| 16 | 提示词库（保存常用 prompt，快速插入） | P1 | M | 设置 + composer 面板 |
| 17 | 语音输入（Web Speech API 中文识别） | P2 | M | composer 麦克风按钮 |
| 18 | 回复朗读 TTS（speechSynthesis，可调速） | P2 | S | 消息气泡按钮 |
| 19 | 全局唤起快捷键（Electron globalShortcut 呼出窗口+面板） | P1 | S | main 进程注册 |
| 20 | 新增 5 个内置动作（改写语气/压缩到 N 字/会议纪要/SWOT/选段对比） | P0 | S | DEFAULT_ACTIONS 追加 |

## Provider 与参数

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 21 | HTTP provider 真实网络探测（延迟 + 模型拉取） | P0 | M | probeProviders HTTP 分支 |
| 22 | Ollama 模型自动发现（/api/tags 下拉选择） | P1 | M | 设置对话框 + 探测 |
| 23 | 模型参数（temperature/max_tokens 每 provider 可调） | P1 | M | settings schema + buildProviderRequest |
| 24 | 自定义系统提示词（persona/输出语言/风格） | P1 | S | buildDocumentPrompt 前置 |

## 质量与安全

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 25 | 用量与耗时显示（每次请求字符量/首字时间/总耗时） | P0 | S | service 事件带统计 + 气泡 footer |
| 26 | 回答质量反馈（👍/👎 落盘，供日后分析） | P2 | S | 气泡按钮 + 存储 |
| 27 | 发送前敏感信息检测（密钥/邮箱/身份证正则，警告确认） | P1 | M | composer 拦截 + 规则集 |
| 28 | 工具调用（function calling：模型请求读取指定单元格/页码深读） | P2 | L | service 工具协议 + context-service |

## 基础

| # | 功能 | 优先级 | 工作量 | 涉及位置 |
|---|---|---|---|---|
| 29 | 模块 i18n 化（面板全部硬编码中文 → i18n 10 语言） | P0 | L | 全部助手组件 |
| 30 | 设置 UI 重构（分组标签页：常规/Provider/动作/关于） | P1 | M | ai-settings-dialog 结构 |

## 建议批次

- **批次 1（P0 会话核心）**：1 持久化、3 恢复、4 导出、6 重新生成、9 context UI、14 斜杠命令、20 新动作、25 用量显示
- **批次 2（P0/P1 体验）**：13 悬浮条、15 自定义动作、16 提示词库、19 全局快捷键、21 网络探测、24 persona、29 i18n
- **批次 3（P1 深度）**：2 多会话、5 编辑重发、8 引用、10 多文档、11 附件、22 Ollama 发现、23 参数、27 敏感检测、30 设置重构
- **批次 4（P2）**：7 分支、12 RAG、17 语音、18 TTS、26 反馈、28 工具调用
