# 文档交互智能助手使用说明

## 打开助手

打开任意文档后，点击右下角“AI 助手”，或按 `Ctrl+Shift+I`。选择提供器后，可直接提问或使用内置分析动作。

## 本地 Codex 与 Claude Code

应用会自动检测已安装的原生 Windows CLI：

- Claude Code 默认关闭工具、项目扩展和会话持久化，适合文档问答。
- Codex 使用只读隔离与临时会话，但当前 CLI 无法彻底关闭读取工具，因此界面将其标为高信任实验模式。敏感文档优先使用 Claude 安全模式或可信的直连接口。

应用不会代替用户登录，也不会读取或显示 CLI 的令牌。状态检测只执行 `--version`，不会发起模型推理。

## DeepSeek、Kimi 与第三方模型

1. 打开助手右上角的设置按钮。
2. 启用内置 DeepSeek/Kimi，或点击“添加第三方模型”。
3. 选择接口类型，填写基础地址、模型与 API Key。
4. 只有 Ollama、LM Studio 等本机/局域网服务需要勾选“允许访问本机/局域网地址”。
5. 保存并应用。

DeepSeek 与 Kimi 的内置地址来自其官方 OpenAI-compatible 文档：

- DeepSeek：<https://api-docs.deepseek.com/>
- Kimi：<https://platform.kimi.com/docs/api/overview>

API Key 使用 Windows 安全存储加密。留空表示保持已保存密钥；界面不会回显旧密钥。

## 隐私说明

- 文档只在用户点击发送或快捷分析动作时交给当前模型。
- 选择第三方接口时，文档内容会发送到对应服务商；请遵守所在组织的数据规则。
- 本地 CLI 默认使用无状态请求，避免由 Office Viewer 主动保存助手会话。
- 当前版本不会让模型直接修改文件。

## 当前格式支持

Markdown/HTML/文本/代码、DOCX、PPTX、XLS/XLSX/ODS 和带文本层的 PDF 可提取正文。扫描 PDF、图片以及部分复杂二进制格式目前只提供元数据，并在对话中明确提示。
