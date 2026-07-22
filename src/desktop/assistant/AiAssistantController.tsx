import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DesktopAiAssistantSettings,
  DesktopAiProviderInput,
  DesktopAiProviderStatus,
  DesktopFileSession,
} from '../../../desktop/shared/desktop-api'
import { DocumentAssistant } from './DocumentAssistant'
import type { AssistantMessage, AssistantRunState, AssistantSendRequest } from './types'

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
  const [saving, setSaving] = useState(false)
  const [probingProviders, setProbingProviders] = useState(false)
  const [selectedText, setSelectedText] = useState('')
  const activeRequest = useRef<{ requestId: string; sessionId: string; assistantMessageId: string } | null>(null)
  const messagesRef = useRef<AssistantMessage[]>([])
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

  useEffect(() => {
    if (activeRequest.current) void window.officeDesktop.cancelAiAssistantRequest(activeRequest.current.requestId)
    activeRequest.current = null
    setMessages([])
    setRunState('idle')
    setError(null)
  }, [session?.id])

  useEffect(() => {
    const updateSelection = () => {
      const selection = window.getSelection()
      const anchor = selection?.anchorNode
      const surface = document.querySelector('.document-surface')
      const text = anchor && surface?.contains(anchor) ? selection?.toString().trim() ?? '' : ''
      setSelectedText(text.slice(0, 16_000))
    }
    document.addEventListener('selectionchange', updateSelection)
    return () => document.removeEventListener('selectionchange', updateSelection)
  }, [session?.id])

  useEffect(() => window.officeDesktop.onAiAssistantEvent((event) => {
    const active = activeRequest.current
    if (!active || event.requestId !== active.requestId || event.sessionId !== active.sessionId) return
    if (event.type === 'start') {
      setRunState('loading')
      return
    }
    if (event.type === 'context') return
    if (event.type === 'chunk') {
      setRunState('streaming')
      setMessages((current) => current.map((message) => message.id === active.assistantMessageId
        ? { ...message, content: message.content + (event.content ?? ''), pending: true }
        : message))
      return
    }
    if (event.type === 'end') {
      setMessages((current) => current.map((message) => message.id === active.assistantMessageId
        ? { ...message, pending: false }
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
        description: highTrust ? '高信任，只读隔离' : status?.detail,
        available: status?.available ?? true,
        badge: highTrust ? 'EXPERIMENTAL' : local ? 'LOCAL' : provider.model,
      }
    }), [settings, statusById])

  const runRequest = useCallback((content: string, modelId: string, transportContent = content) => {
    if (!session || activeRequest.current) return
    const requestId = `assistant-${crypto.randomUUID()}`
    const userMessage: AssistantMessage = { id: crypto.randomUUID(), role: 'user', content, createdAt: Date.now() }
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
    const transportUserMessage = { ...userMessage, content: transportContent }
    const history = [...messagesRef.current, transportUserMessage]
      .filter((message) => message.role === 'user' || message.role === 'assistant' && message.content)
      .slice(-20)
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }))
    activeRequest.current = { requestId, sessionId: session.id, assistantMessageId }
    setMessages((current) => [...current, userMessage, assistantMessage])
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
    runRequest(request.content, request.modelId, selection ? `${request.content}\n\n当前选中内容：\n${selection}` : request.content)
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

  return (
    <>
      <DocumentAssistant
        models={models}
        selectedModelId={selectedModelId}
        messages={messages}
        document={session ? { id: session.id, name: session.name, format: session.extension, path: session.path, selection: selectedText ? { text: selectedText, label: '当前选区' } : null } : null}
        state={runState}
        error={error}
        disabled={!session}
        onOpenChange={(nextOpen) => {
          if (nextOpen) void probeProviders().catch((reason) => setError(toMessage(reason)))
        }}
        onModelChange={(providerId) => setSettings((current) => {
          if (!current) return current
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
          runRequest(action.prompt, modelId, selection ? `${action.prompt}\n\n当前选中内容：\n${selection}` : action.prompt)
        }}
        onStop={stop}
        onClear={() => { setMessages([]); setError(null); setRunState('idle') }}
        onRetry={() => {
          const last = [...messages].reverse().find((message) => message.role === 'user')
          if (last && selectedModelId) runRequest(last.content, selectedModelId)
        }}
        onOpenSettings={openSettings}
        privacyNote="文档仅在主动发送时交给所选模型；密钥由 Windows 安全存储保护。"
      />

      {settingsOpen && (
        <div className="ai-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
          <section className="ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
            <header>
              <div><p>AI PROVIDER GATEWAY</p><h2 id="ai-settings-title">文档助手模型设置</h2></div>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">×</button>
            </header>
            <div className="ai-settings-dialog__notice">
              <strong>安全边界</strong>
              <span>Claude Code 默认禁用工具与会话持久化；Codex CLI 因无法彻底关闭读取工具，被标为高信任实验模式。第三方 API Key 不会返回到页面。</span>
            </div>
            <div className="ai-settings-dialog__toolbar">
              <label>默认提供器<select value={draftActiveProviderId} onChange={(event) => setDraftActiveProviderId(event.target.value)}>{draftProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
              <label>上下文字符数<input type="number" min={8000} max={500000} step={8000} value={draftContextLimit} onChange={(event) => setDraftContextLimit(Number(event.target.value))} /></label>
              <button type="button" onClick={() => {
                const id = `custom-${crypto.randomUUID().slice(0, 8)}`
                setDraftProviders((current) => [...current, { id, name: '自定义模型', kind: 'openai-compatible', enabled: true, model: '', baseUrl: '', apiKey: '' }])
                setDraftActiveProviderId(id)
              }}>＋ 添加第三方模型</button>
              <button type="button" disabled={probingProviders} onClick={() => void probeProviders(true).catch((reason) => setSettingsError(toMessage(reason)))}>{probingProviders ? '检测中…' : '刷新本地 CLI'}</button>
            </div>
            <div className="ai-settings-dialog__providers">
              {draftProviders.map((provider) => {
                const isCli = provider.kind === 'codex-cli' || provider.kind === 'claude-cli'
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
                      <label>模型<input value={provider.model ?? ''} placeholder={isCli ? '使用本地默认模型' : '必填'} onChange={(event) => updateProvider(provider.id, { model: event.target.value })} /></label>
                      {!isCli && <label>API Key<input type="password" value={provider.apiKey} placeholder={provider.hasApiKey ? '已安全保存；留空保持不变' : '输入后由 Windows 加密'} onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value, removeApiKey: false })} /></label>}
                      {!isCli && <label className="ai-provider-card__network"><input type="checkbox" checked={provider.allowPrivateNetwork === true} onChange={(event) => updateProvider(provider.id, { allowPrivateNetwork: event.target.checked })} />允许访问本机/局域网地址</label>}
                      {!isCli && provider.hasApiKey && <label className="ai-provider-card__network"><input type="checkbox" checked={provider.removeApiKey === true} onChange={(event) => updateProvider(provider.id, { removeApiKey: event.target.checked, apiKey: event.target.checked ? '' : provider.apiKey })} />删除已安全保存的 API Key</label>}
                    </div>
                  </article>
                )
              })}
            </div>
            {settingsError && <div className="ai-settings-dialog__error" role="alert">{settingsError}</div>}
            <footer><span>保存后会重新检测本地 CLI；第三方接口不会自动发送探测请求。</span><button type="button" onClick={() => setSettingsOpen(false)}>取消</button><button type="button" className="is-primary" disabled={saving} onClick={() => void saveSettings()}>{saving ? '保存中…' : '保存并应用'}</button></footer>
          </section>
        </div>
      )}
    </>
  )
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
