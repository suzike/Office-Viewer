import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DesktopAiAssistantSettings,
  DesktopAiCustomAction,
  DesktopAiPromptSnippet,
  DesktopAiProviderInput,
  DesktopAiProviderStatus,
  DesktopFileSession,
} from '../../../desktop/shared/desktop-api'
import { DEFAULT_ACTIONS, DocumentAssistant } from './DocumentAssistant'
import { SelectionActionBar, type SelectionBarAction } from './SelectionActionBar'
import { subscribeAssistantSelection } from './selectionEvents'
import type { AssistantComposerInsert, AssistantDocumentContext, AssistantMessage, AssistantRunState, AssistantSendRequest } from './types'

interface AiAssistantControllerProps {
  readonly session: DesktopFileSession | null
}

type EditableProvider = DesktopAiProviderInput & { apiKey: string; builtIn?: boolean; hasApiKey?: boolean }

export function AiAssistantController({ session }: AiAssistantControllerProps) {
  const [settings, setSettings] = useState<DesktopAiAssistantSettings | null>(null)
  const [statuses, setStatuses] = useState<readonly DesktopAiProviderStatus[]>([])
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [runState, setRunState] = useState<AssistantRunState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [draftProviders, setDraftProviders] = useState<EditableProvider[]>([])
  const [draftActiveProviderId, setDraftActiveProviderId] = useState('')
  const [draftContextLimit, setDraftContextLimit] = useState(160_000)
  const [draftCustomActions, setDraftCustomActions] = useState<DesktopAiCustomAction[]>([])
  const [draftPromptSnippets, setDraftPromptSnippets] = useState<DesktopAiPromptSnippet[]>([])
  const [draftPersona, setDraftPersona] = useState('')
  const [draftOutputLanguage, setDraftOutputLanguage] = useState('')
  const [draftStyle, setDraftStyle] = useState('')
  const [draftGlobalShortcut, setDraftGlobalShortcut] = useState(false)
  const [draftTemperature, setDraftTemperature] = useState('')
  const [draftMaxTokens, setDraftMaxTokens] = useState('')
  const [settingsTab, setSettingsTab] = useState<'general' | 'providers' | 'actions' | 'about'>('providers')
  const [saving, setSaving] = useState(false)
  const [probingProviders, setProbingProviders] = useState(false)
  const [selectedText, setSelectedText] = useState('')
  const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [composerInsert, setComposerInsert] = useState<AssistantComposerInsert | null>(null)
  const activeRequest = useRef<{ requestId: string; sessionId: string; assistantMessageId: string; startedAt: number; firstChunkAt?: number } | null>(null)
  const lastRequestRef = useRef<{ content: string; transportContent: string } | null>(null)
  const messagesRef = useRef<AssistantMessage[]>([])
  const [extraction, setExtraction] = useState<AssistantDocumentContext['extraction']>(null)
  const providerProbeDone = useRef(false)
  const providerProbeInFlight = useRef<Promise<void> | null>(null)

  useEffect(() => { messagesRef.current = messages }, [messages])

  const probeProviders = useCallback(async (forceRefresh = false) => {
    if (!forceRefresh && providerProbeDone.current) return
    if (providerProbeInFlight.current) {
      await providerProbeInFlight.current
      if (!forceRefresh) return
    }
    const task = (async () => {
      setProbingProviders(true)
      try {
        setStatuses(await window.officeDesktop.probeAiAssistantProviders(forceRefresh))
        providerProbeDone.current = true
      } finally {
        setProbingProviders(false)
      }
    })()
    providerProbeInFlight.current = task
    try {
      await task
    } finally {
      if (providerProbeInFlight.current === task) providerProbeInFlight.current = null
    }
  }, [])

  useEffect(() => {
    void window.officeDesktop.loadAiAssistantSettings().then(setSettings).catch((reason) => setError(toMessage(reason)))
  }, [])

  // Per-document conversation cache: opening Git History (session → null) must not
  // abort an in-flight request or wipe the chat; only real document switches reset.
  const conversations = useRef(new Map<string, AssistantMessage[]>())
  const previousSessionId = useRef<string>()
  useEffect(() => {
    const id = session?.id
    if (id === undefined || id === previousSessionId.current) return
    if (previousSessionId.current) {
      conversations.current.set(previousSessionId.current, messagesRef.current)
      if (conversations.current.size > 20) {
        const oldest = conversations.current.keys().next().value
        if (oldest !== undefined) conversations.current.delete(oldest)
      }
    }
    previousSessionId.current = id
    if (activeRequest.current) void window.officeDesktop.cancelAiAssistantRequest(activeRequest.current.requestId)
    activeRequest.current = null
    setMessages(conversations.current.get(id) ?? [])
    setExtraction(null)
    setRunState('idle')
    setError(null)
  }, [session?.id])

  useEffect(() => {
    const updateSelection = () => {
      const selection = window.getSelection()
      const anchor = selection?.anchorNode
      const surface = document.querySelector('.document-surface:not(.document-surface--git)')
      const text = anchor && surface?.contains(anchor) ? selection?.toString().trim() ?? '' : ''
      setSelectedText(text.slice(0, 16_000))
      if (text && selection && selection.rangeCount > 0) {
        const rect = selection.getRangeAt(0).getBoundingClientRect()
        setSelectionAnchor({ x: rect.left + rect.width / 2, y: rect.top })
      } else {
        setSelectionAnchor(null)
      }
    }
    document.addEventListener('selectionchange', updateSelection)
    return () => document.removeEventListener('selectionchange', updateSelection)
  }, [session?.id])

  // Iframe viewers (HTML preview / Markdown editor) forward their selection here.
  useEffect(() => subscribeAssistantSelection((detail) => {
    const text = typeof detail.text === 'string' ? detail.text.trim().slice(0, 16_000) : ''
    setSelectedText(text)
    setSelectionAnchor(text && Number.isFinite(detail.x) && Number.isFinite(detail.y)
      ? { x: detail.x as number, y: detail.y as number }
      : null)
  }), [])

  // Global summon shortcut: the main process focuses the window, we open the panel.
  useEffect(() => window.officeDesktop.onAiAssistantFocus(() => setAssistantOpen(true)), [])

  useEffect(() => window.officeDesktop.onAiAssistantEvent((event) => {
    const active = activeRequest.current
    if (!active || event.requestId !== active.requestId || event.sessionId !== active.sessionId) return
    if (event.type === 'start') {
      setRunState('loading')
      return
    }
    if (event.type === 'context') {
      if (event.context) {
        setExtraction({
          strategy: event.context.strategy,
          extractedCharacters: event.context.extractedCharacters,
          sourceCharacters: event.context.sourceCharacters,
          truncated: event.context.truncated,
          warning: event.context.warning,
        })
      }
      return
    }
    if (event.type === 'chunk') {
      if (!active.firstChunkAt) active.firstChunkAt = Date.now()
      setRunState('streaming')
      setMessages((current) => current.map((message) => message.id === active.assistantMessageId
        ? { ...message, content: message.content + (event.content ?? ''), pending: true }
        : message))
      return
    }
    if (event.type === 'end') {
      const endedAt = Date.now()
      setMessages((current) => current.map((message) => message.id === active.assistantMessageId
        ? {
          ...message,
          pending: false,
          stats: {
            durationMs: endedAt - active.startedAt,
            ttftMs: active.firstChunkAt ? active.firstChunkAt - active.startedAt : undefined,
            characters: message.content.length,
          },
        }
        : message))
      setRunState('idle')
      activeRequest.current = null
      return
    }
    if (event.type === 'error') {
      setMessages((current) => current.map((message) => message.id === active.assistantMessageId
        ? { ...message, pending: false }
        : message))
      setError(event.content || 'AI 助手请求失败。')
      setRunState('error')
      activeRequest.current = null
    }
  }), [])

  const statusById = useMemo(() => new Map(statuses.map((status) => [status.providerId, status])), [statuses])
  const models = useMemo(() => (settings?.providers ?? [])
    .filter((provider) => provider.enabled)
    .map((provider) => {
      const status = statusById.get(provider.id)
      const local = provider.kind === 'codex-cli' || provider.kind === 'claude-cli'
      const highTrust = provider.kind === 'codex-cli'
      return {
        id: provider.id,
        label: provider.name,
        provider: local ? '本地 CLI' : provider.kind === 'ollama' ? '本地模型' : '第三方 API',
        description: status?.available === false ? status.detail : highTrust ? '高信任，只读隔离' : status?.detail,
        available: status?.available ?? true,
        badge: highTrust ? 'EXPERIMENTAL' : local ? 'LOCAL' : provider.model,
      }
    }), [settings, statusById])

  const runRequest = useCallback((content: string, modelId: string, transportContent = content, options?: { dropAssistantId?: string; reuseUser?: boolean; selectionSnapshot?: string }) => {
    if (!session || activeRequest.current) return
    const requestId = `assistant-${crypto.randomUUID()}`
    const userMessage: AssistantMessage = { id: crypto.randomUUID(), role: 'user', content, createdAt: Date.now(), selectionSnapshot: options?.selectionSnapshot }
    const assistantMessageId = crypto.randomUUID()
    const provider = settings?.providers.find((entry) => entry.id === modelId)
    const assistantMessage: AssistantMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      modelLabel: provider?.name,
      pending: true,
    }
    lastRequestRef.current = { content, transportContent }
    const transportUserMessage = { ...userMessage, content: transportContent }
    const historyBase = messagesRef.current.filter((message) => message.id !== options?.dropAssistantId)
    if (options?.reuseUser) {
      // Retry: keep the existing user bubble, refresh it with the original transport
      // content (which may embed the selection snapshot from the first attempt).
      const lastUserIndex = historyBase.map((message) => message.role).lastIndexOf('user')
      if (lastUserIndex !== -1) historyBase[lastUserIndex] = transportUserMessage
    } else {
      historyBase.push(transportUserMessage)
    }
    const history = historyBase
      .filter((message) => message.role === 'user' || message.role === 'assistant' && message.content)
      .slice(-20)
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }))
    activeRequest.current = { requestId, sessionId: session.id, assistantMessageId, startedAt: Date.now() }
    setMessages((current) => {
      const base = options?.dropAssistantId ? current.filter((message) => message.id !== options.dropAssistantId) : current
      return options?.reuseUser ? [...base, assistantMessage] : [...base, userMessage, assistantMessage]
    })
    setError(null)
    setRunState('loading')
    void window.officeDesktop.startAiAssistantRequest({
      requestId,
      sessionId: session.id,
      providerId: modelId,
      messages: history,
    }).catch((reason) => {
      if (activeRequest.current?.requestId !== requestId) return
      setMessages((current) => current.map((message) => message.id === assistantMessageId ? { ...message, pending: false } : message))
      setError(toMessage(reason))
      setRunState('error')
      activeRequest.current = null
    })
  }, [session, settings])

  const send = useCallback((request: AssistantSendRequest) => {
    const selection = request.document?.selection?.text.trim()
    runRequest(request.content, request.modelId, selection ? `${request.content}\n\n当前选中内容：\n${selection}` : request.content, { selectionSnapshot: selection || undefined })
  }, [runRequest])

  const stop = useCallback(() => {
    const active = activeRequest.current
    if (!active) return
    void window.officeDesktop.cancelAiAssistantRequest(active.requestId)
    setMessages((current) => current.map((message) => message.id === active.assistantMessageId ? { ...message, pending: false } : message))
    setRunState('idle')
    activeRequest.current = null
  }, [])

  const openSettings = useCallback(() => {
    if (!settings) return
    setDraftProviders(settings.providers.map((provider) => ({ ...provider, apiKey: '' })))
    setDraftActiveProviderId(settings.activeProviderId)
    setDraftContextLimit(settings.contextCharacterLimit)
    setDraftCustomActions(settings.customActions.map((action) => ({ ...action })))
    setDraftPromptSnippets(settings.promptLibrary.map((snippet) => ({ ...snippet })))
    setDraftPersona(settings.promptProfile.persona ?? '')
    setDraftOutputLanguage(settings.promptProfile.outputLanguage ?? '')
    setDraftStyle(settings.promptProfile.style ?? '')
    setDraftGlobalShortcut(settings.globalShortcutEnabled)
    setDraftTemperature(settings.modelParameters.temperature === undefined ? '' : String(settings.modelParameters.temperature))
    setDraftMaxTokens(settings.modelParameters.maxTokens === undefined ? '' : String(settings.modelParameters.maxTokens))
    setSettingsTab('providers')
    setSettingsError(null)
    setSettingsOpen(true)
  }, [settings])

  const saveSettings = async () => {
    setSaving(true)
    setSettingsError(null)
    try {
      const saved = await window.officeDesktop.saveAiAssistantSettings({
        activeProviderId: draftActiveProviderId,
        contextCharacterLimit: draftContextLimit,
        providers: draftProviders.map(({ builtIn: _builtIn, hasApiKey: _hasApiKey, ...provider }) => provider),
        customActions: draftCustomActions,
        promptLibrary: draftPromptSnippets,
        promptProfile: { persona: draftPersona, outputLanguage: draftOutputLanguage, style: draftStyle },
        globalShortcutEnabled: draftGlobalShortcut,
        modelParameters: {
          temperature: draftTemperature.trim() === '' ? undefined : Number(draftTemperature),
          maxTokens: draftMaxTokens.trim() === '' ? undefined : Number(draftMaxTokens),
        },
      })
      setSettings(saved)
      await probeProviders(true)
      setSettingsOpen(false)
    } catch (reason) {
      setSettingsError(toMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  const updateProvider = (id: string, patch: Partial<EditableProvider>) => {
    setDraftProviders((current) => current.map((provider) => provider.id === id ? { ...provider, ...patch } : provider))
  }

  const selectedModelId = settings?.providers.some((provider) => provider.id === settings.activeProviderId && provider.enabled)
    ? settings.activeProviderId
    : models[0]?.id

  const regenerate = useCallback(() => {
    const lastRequest = lastRequestRef.current
    if (!lastRequest || !selectedModelId) return
    const failedAssistant = [...messagesRef.current].reverse().find((message) => message.role === 'assistant')
    runRequest(lastRequest.content, selectedModelId, lastRequest.transportContent, {
      dropAssistantId: failedAssistant?.id,
      reuseUser: true,
    })
  }, [runRequest, selectedModelId])

  // Edit-and-resend: drop everything after the edited user message and re-run
  // it with the new text, re-attaching the selection captured at the first send.
  const editResend = useCallback((messageId: string, content: string) => {
    if (!selectedModelId || activeRequest.current) return
    const index = messagesRef.current.findIndex((message) => message.id === messageId)
    if (index === -1 || messagesRef.current[index].role !== 'user') return
    const snapshot = messagesRef.current[index].selectionSnapshot
    const truncated = messagesRef.current.slice(0, index)
    messagesRef.current = truncated
    setMessages(truncated)
    setError(null)
    runRequest(content, selectedModelId, snapshot ? `${content}\n\n当前选中内容：\n${snapshot}` : content, { selectionSnapshot: snapshot })
  }, [runRequest, selectedModelId])

  // Built-in actions plus user-defined custom actions from the settings dialog.
  const quickActions = useMemo(() => [
    ...DEFAULT_ACTIONS,
    ...(settings?.customActions ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description ?? '自定义动作',
      prompt: action.prompt,
      requiresSelection: action.requiresSelection === true,
    })),
  ], [settings])

  // Floating selection toolbar: send the selection to the panel with an intent.
  const runSelectionBarAction = useCallback((kind: SelectionBarAction) => {
    const text = selectedText.trim()
    if (!text || !session || !selectedModelId) return
    setAssistantOpen(true)
    if (kind === 'quote') {
      const quoted = text.split('\n').map((line) => `> ${line}`).join('\n')
      setComposerInsert({ text: quoted, token: Date.now() })
      return
    }
    const action = quickActions.find((entry) => entry.id === (kind === 'explain' ? 'explain-selection' : 'translate'))
    const prompt = action?.prompt ?? (kind === 'explain' ? '请结合文档上下文解释我选中的内容。' : '请翻译我选中的内容。')
    runRequest(prompt, selectedModelId, `${prompt}\n\n当前选中内容：\n${text}`)
  }, [quickActions, runRequest, selectedModelId, selectedText, session])

  return (
    <>
      <DocumentAssistant
        models={models}
        selectedModelId={selectedModelId}
        messages={messages}
        open={assistantOpen}
        document={session ? { id: session.id, name: session.name, format: session.extension, path: session.path, selection: selectedText ? { text: selectedText, label: '当前选区' } : null, extraction } : null}
        state={runState}
        error={error}
        disabled={!session}
        quickActions={quickActions}
        promptSnippets={settings?.promptLibrary ?? []}
        composerInsert={composerInsert}
        onOpenChange={(nextOpen) => {
          setAssistantOpen(nextOpen)
          if (nextOpen) void probeProviders().catch((reason) => setError(toMessage(reason)))
        }}
        onModelChange={(providerId) => setSettings((current) => {          if (!current) return current
          const next = { ...current, activeProviderId: providerId }
          void window.officeDesktop.saveAiAssistantSettings({
            activeProviderId: providerId,
            contextCharacterLimit: current.contextCharacterLimit,
            providers: current.providers,
          }).then(setSettings).catch((reason) => setError(toMessage(reason)))
          return next
        })}
        onSend={send}
        onQuickAction={({ action, modelId, document }) => {
          const selection = document?.selection?.text.trim()
          runRequest(action.prompt, modelId, selection ? `${action.prompt}\n\n当前选中内容：\n${selection}` : action.prompt, { selectionSnapshot: selection || undefined })
        }}
        onStop={stop}
        onClear={() => { setMessages([]); setError(null); setRunState('idle') }}
        onRetry={() => regenerate()}
        onEditResend={editResend}
        onRegenerate={() => regenerate()}
        onExportChat={() => {
          if (!messagesRef.current.length) return
          const formatTime = (value: AssistantMessage['createdAt']) => value ? new Date(value).toLocaleString() : ''
          const lines = [
            `# 文档助手对话导出`,
            ``,
            `- 文档：${session?.name ?? '未打开文档'}（${session?.path ?? '无路径'}）`,
            `- 导出时间：${new Date().toLocaleString()}`,
            ``,
            ...messagesRef.current.flatMap((message) => [
              `## ${message.role === 'user' ? '用户' : message.role === 'assistant' ? `助手（${message.modelLabel ?? '模型'}）` : '系统'} · ${formatTime(message.createdAt)}`,
              ``,
              message.content || '（空）',
              ``,
            ]),
          ]
          const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `assistant-chat-${new Date().toISOString().slice(0, 10)}.md`
          anchor.click()
          URL.revokeObjectURL(url)
        }}
        onOpenSettings={openSettings}
        privacyNote="文档仅在主动发送时交给所选模型；密钥由 Windows 安全存储保护。"
      />

      {session && (
        <SelectionActionBar text={selectedText} anchor={selectionAnchor} onAction={runSelectionBarAction} />
      )}

      {settingsOpen && (
        <div className="ai-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
          <section className="ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
            <header>
              <div><p>AI PROVIDER GATEWAY</p><h2 id="ai-settings-title">文档助手模型设置</h2></div>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">×</button>
            </header>
            <nav className="ai-settings-dialog__tabs" aria-label="设置分组">
              {([
                ['general', '常规'],
                ['providers', 'Provider'],
                ['actions', '动作'],
                ['about', '关于'],
              ] as const).map(([tab, label]) => (
                <button key={tab} type="button" className={settingsTab === tab ? 'is-active' : ''} aria-pressed={settingsTab === tab} onClick={() => setSettingsTab(tab)}>{label}</button>
              ))}
            </nav>
            <div className="ai-settings-dialog__body">
              {settingsTab === 'general' && (
                <>
                  <section className="ai-settings-group" aria-label="常规">
                    <header><strong>常规</strong><span>上下文、全局行为与采样参数（仅 HTTP 提供器生效）</span></header>
                    <div className="ai-settings-group__fields">
                      <label>上下文字符数<input type="number" min={8000} max={500000} step={8000} value={draftContextLimit} onChange={(event) => setDraftContextLimit(Number(event.target.value))} /></label>
                      <label>Temperature<input type="number" min={0} max={2} step={0.1} value={draftTemperature} placeholder="留空用提供方默认" onChange={(event) => setDraftTemperature(event.target.value)} /></label>
                      <label>最大输出 Token<input type="number" min={1} max={1000000} step={256} value={draftMaxTokens} placeholder="留空用提供方默认" onChange={(event) => setDraftMaxTokens(event.target.value)} /></label>
                      <label className="ai-settings-dialog__shortcut"><input type="checkbox" checked={draftGlobalShortcut} onChange={(event) => setDraftGlobalShortcut(event.target.checked)} />全局唤起快捷键（Ctrl+Shift+Space）</label>
                    </div>
                  </section>

                  <section className="ai-settings-group" aria-label="助手人格">
                    <header><strong>助手人格</strong><span>注入到每次请求的系统提示词之前</span></header>
                    <div className="ai-settings-group__fields">
                      <label>角色设定<input value={draftPersona} placeholder="例如：资深技术文档审校专家" onChange={(event) => setDraftPersona(event.target.value)} /></label>
                      <label>输出语言<input value={draftOutputLanguage} placeholder="例如：简体中文" onChange={(event) => setDraftOutputLanguage(event.target.value)} /></label>
                      <label>回答风格<input value={draftStyle} placeholder="例如：结论先行、条目化、避免套话" onChange={(event) => setDraftStyle(event.target.value)} /></label>
                    </div>
                  </section>
                </>
              )}

              {settingsTab === 'providers' && (
                <>
                  <div className="ai-settings-dialog__toolbar">
                    <label>默认提供器<select value={draftActiveProviderId} onChange={(event) => setDraftActiveProviderId(event.target.value)}>{draftProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
                    <button type="button" onClick={() => {
                      const id = `custom-${crypto.randomUUID().slice(0, 8)}`
                      setDraftProviders((current) => [...current, { id, name: '自定义模型', kind: 'openai-compatible', enabled: true, model: '', baseUrl: '', apiKey: '' }])
                      setDraftActiveProviderId(id)
                    }}>＋ 添加第三方模型</button>
                    <button type="button" disabled={probingProviders} onClick={() => void probeProviders(true).catch((reason) => setSettingsError(toMessage(reason)))}>{probingProviders ? '检测中…' : '重新检测提供器'}</button>
                  </div>
                  <div className="ai-settings-dialog__providers">
                    {draftProviders.map((provider) => {
                      const isCli = provider.kind === 'codex-cli' || provider.kind === 'claude-cli'
                      const discoveredModels = provider.kind === 'ollama' ? statusById.get(provider.id)?.models : undefined
                      const modelListId = discoveredModels?.length ? `ai-models-${provider.id}` : undefined
                      return (
                        <article key={provider.id} className={!provider.enabled ? 'is-disabled' : ''}>
                          <div className="ai-provider-card__heading">
                            <label className="ai-provider-card__toggle"><input type="checkbox" checked={provider.enabled !== false} onChange={(event) => updateProvider(provider.id, { enabled: event.target.checked })} /><span /></label>
                            <input value={provider.name} onChange={(event) => updateProvider(provider.id, { name: event.target.value })} aria-label="提供器名称" />
                            <code>{provider.id}</code>
                            {!provider.builtIn && <button type="button" onClick={() => { setDraftProviders((current) => current.filter((entry) => entry.id !== provider.id)); if (draftActiveProviderId === provider.id) setDraftActiveProviderId(draftProviders.find((entry) => entry.id !== provider.id)?.id ?? '') }}>删除</button>}
                          </div>
                          <div className="ai-provider-card__fields">
                            <label>接口类型<select value={provider.kind} onChange={(event) => updateProvider(provider.id, { kind: event.target.value as EditableProvider['kind'] })}><option value="codex-cli">Codex CLI</option><option value="claude-cli">Claude Code CLI</option><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="ollama">Ollama</option></select></label>
                            {isCli ? <label>原生 EXE（可选）<input value={provider.executable ?? ''} placeholder="自动发现" onChange={(event) => updateProvider(provider.id, { executable: event.target.value })} /></label> : <label>API 基础地址<input value={provider.baseUrl ?? ''} placeholder="https://…" onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })} /></label>}
                            <label>模型<input list={modelListId} value={provider.model ?? ''} placeholder={isCli ? '使用本地默认模型' : discoveredModels?.length ? '从下拉选择或输入' : '必填'} onChange={(event) => updateProvider(provider.id, { model: event.target.value })} /></label>
                            {modelListId && <datalist id={modelListId}>{discoveredModels!.map((model) => <option key={model} value={model} />)}</datalist>}
                            {!isCli && <label>API Key<input type="password" value={provider.apiKey} placeholder={provider.hasApiKey ? '已安全保存；留空保持不变' : '输入后由 Windows 加密'} onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value, removeApiKey: false })} /></label>}
                            {!isCli && <label className="ai-provider-card__network"><input type="checkbox" checked={provider.allowPrivateNetwork === true} onChange={(event) => updateProvider(provider.id, { allowPrivateNetwork: event.target.checked })} />允许访问本机/局域网地址</label>}
                            {!isCli && provider.hasApiKey && <label className="ai-provider-card__network"><input type="checkbox" checked={provider.removeApiKey === true} onChange={(event) => updateProvider(provider.id, { removeApiKey: event.target.checked, apiKey: event.target.checked ? '' : provider.apiKey })} />删除已安全保存的 API Key</label>}
                          </div>
                          {(() => {
                            const status = statusById.get(provider.id)
                            if (!status) return null
                            const modelPreview = status.models?.length ? ` · 模型：${status.models.slice(0, 3).join('、')}${status.models.length > 3 ? '…' : ''}` : ''
                            return <p className={`ai-provider-card__status${status.available ? ' is-online' : ''}`}>{status.available ? '●' : '○'} {status.detail}{modelPreview}</p>
                          })()}
                        </article>
                      )
                    })}
                  </div>
                </>
              )}

              {settingsTab === 'actions' && (
                <>
                  <section className="ai-settings-group" aria-label="自定义快捷动作">
                    <header>
                      <strong>自定义快捷动作</strong>
                      <span>显示在快捷动作栏与斜杠命令面板</span>
                      <button type="button" onClick={() => setDraftCustomActions((current) => [...current, { id: `action-${crypto.randomUUID().slice(0, 8)}`, label: '新动作', prompt: '', requiresSelection: false }])}>＋ 添加动作</button>
                    </header>
                    {draftCustomActions.length === 0 && <p className="ai-settings-group__empty">尚无自定义动作。</p>}
                    {draftCustomActions.map((action, index) => (
                      <article key={action.id} className="ai-settings-item">
                        <div className="ai-settings-item__heading">
                          <input value={action.label} aria-label="动作名称" onChange={(event) => setDraftCustomActions((current) => current.map((entry) => entry.id === action.id ? { ...entry, label: event.target.value } : entry))} />
                          <code>{action.id}</code>
                          <button type="button" disabled={index === 0} aria-label="上移动作" onClick={() => setDraftCustomActions((current) => moveEntry(current, index, -1))}>↑</button>
                          <button type="button" disabled={index === draftCustomActions.length - 1} aria-label="下移动作" onClick={() => setDraftCustomActions((current) => moveEntry(current, index, 1))}>↓</button>
                          <button type="button" onClick={() => setDraftCustomActions((current) => current.filter((entry) => entry.id !== action.id))}>删除</button>
                        </div>
                        <div className="ai-settings-item__fields">
                          <label>描述<input value={action.description ?? ''} placeholder="一句话说明（可选）" onChange={(event) => setDraftCustomActions((current) => current.map((entry) => entry.id === action.id ? { ...entry, description: event.target.value } : entry))} /></label>
                          <label className="ai-settings-item__check"><input type="checkbox" checked={action.requiresSelection === true} onChange={(event) => setDraftCustomActions((current) => current.map((entry) => entry.id === action.id ? { ...entry, requiresSelection: event.target.checked } : entry))} />需要选中内容</label>
                          <label className="ai-settings-item__prompt">Prompt 模板<textarea rows={2} value={action.prompt} onChange={(event) => setDraftCustomActions((current) => current.map((entry) => entry.id === action.id ? { ...entry, prompt: event.target.value } : entry))} /></label>
                        </div>
                      </article>
                    ))}
                  </section>

                  <section className="ai-settings-group" aria-label="提示词库">
                    <header>
                      <strong>提示词库</strong>
                      <span>在输入框下方一键插入常用提示词</span>
                      <button type="button" onClick={() => setDraftPromptSnippets((current) => [...current, { id: `prompt-${crypto.randomUUID().slice(0, 8)}`, title: '新提示词', content: '' }])}>＋ 添加提示词</button>
                    </header>
                    {draftPromptSnippets.length === 0 && <p className="ai-settings-group__empty">尚无保存的提示词。</p>}
                    {draftPromptSnippets.map((snippet, index) => (
                      <article key={snippet.id} className="ai-settings-item">
                        <div className="ai-settings-item__heading">
                          <input value={snippet.title} aria-label="提示词标题" onChange={(event) => setDraftPromptSnippets((current) => current.map((entry) => entry.id === snippet.id ? { ...entry, title: event.target.value } : entry))} />
                          <code>{snippet.id}</code>
                          <button type="button" disabled={index === 0} aria-label="上移提示词" onClick={() => setDraftPromptSnippets((current) => moveEntry(current, index, -1))}>↑</button>
                          <button type="button" disabled={index === draftPromptSnippets.length - 1} aria-label="下移提示词" onClick={() => setDraftPromptSnippets((current) => moveEntry(current, index, 1))}>↓</button>
                          <button type="button" onClick={() => setDraftPromptSnippets((current) => current.filter((entry) => entry.id !== snippet.id))}>删除</button>
                        </div>
                        <div className="ai-settings-item__fields">
                          <label className="ai-settings-item__prompt">内容<textarea rows={2} value={snippet.content} onChange={(event) => setDraftPromptSnippets((current) => current.map((entry) => entry.id === snippet.id ? { ...entry, content: event.target.value } : entry))} /></label>
                        </div>
                      </article>
                    ))}
                  </section>
                </>
              )}

              {settingsTab === 'about' && (
                <>
                  <div className="ai-settings-dialog__notice">
                    <strong>安全边界</strong>
                    <span>Claude Code 默认禁用工具与会话持久化；Codex CLI 因无法彻底关闭读取工具，被标为高信任实验模式。第三方 API Key 不会返回到页面。</span>
                  </div>
                  <section className="ai-settings-group" aria-label="关于">
                    <header><strong>关于文档助手</strong><span>数据与隐私</span></header>
                    <div className="ai-settings-about">
                      <p>文档内容仅在你主动发送时交给当前所选模型；使用第三方模型前，请确认其数据处理策略。</p>
                      <p>API Key 由 Windows 安全存储加密保存；助手设置（自定义动作、提示词库、人格、模型参数）以 JSON 形式保存在用户数据目录。</p>
                      <p>发送前会对输入做敏感信息检测（私钥、Token、邮箱、身份证号等），命中时需要确认才会发送。</p>
                      <p>HTTP 提供器仅在你点击「重新检测提供器」或保存设置时发送一次模型列表请求；Codex / Claude CLI 在本地沙箱目录中以只读模式运行。</p>
                    </div>
                  </section>
                </>
              )}
            </div>
            {settingsError && <div className="ai-settings-dialog__error" role="alert">{settingsError}</div>}
            <footer><span>保存后会重新检测所有提供器；HTTP 接口仅在检测时发送一次模型列表请求。</span><button type="button" onClick={() => setSettingsOpen(false)}>取消</button><button type="button" className="is-primary" disabled={saving} onClick={() => void saveSettings()}>{saving ? '保存中…' : '保存并应用'}</button></footer>
          </section>
        </div>
      )}
    </>
  )
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function moveEntry<T>(entries: readonly T[], index: number, delta: number): T[] {
  const target = index + delta
  if (target < 0 || target >= entries.length) return [...entries]
  const next = [...entries]
  const [entry] = next.splice(index, 1)
  next.splice(target, 0, entry)
  return next
}
