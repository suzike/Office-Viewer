import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  AssistantMark,
  ClearIcon,
  CollapseIcon,
  CopyIcon,
  DocumentIcon,
  DownloadIcon,
  EditIcon,
  RegenerateIcon,
  SendIcon,
  SettingsIcon,
  SparkIcon,
  StopIcon,
  WarningIcon,
} from './icons'
import type {
  AssistantMessage,
  AssistantPromptSnippet,
  AssistantQuickAction,
  DocumentAssistantProps,
} from './types'
import { detectSensitiveContent, type SensitiveMatch } from '../../../desktop/shared/sensitive-data'
import { renderAssistantMarkdown } from './assistantMarkdown'
import './assistant.css'

/**
 * Memoized, deferred Markdown rendering: during streaming the deferred value
 * lets React throttle expensive markdown-it + hljs passes off the critical path.
 */
const AssistantMarkdownContent = memo(function AssistantMarkdownContent({ content }: { content: string }) {
  const deferredContent = useDeferredValue(content)
  const html = useMemo(() => renderAssistantMarkdown(deferredContent), [deferredContent])
  return (
    <div
      className="document-assistant__message-content document-assistant__markdown"
      // markdown-it escapes raw HTML and rejects unsafe link protocols.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

export const DEFAULT_ACTIONS: readonly AssistantQuickAction[] = [
  { id: 'summarize', label: '总结文档', description: '关键结论、依据与待办', prompt: '请总结当前文档，分为关键结论、重要依据、风险和待办。' },
  { id: 'explain-selection', label: '解释选中内容', description: '结合上下文逐句说明', prompt: '请结合文档上下文解释我选中的内容，指出术语、前提和影响。', requiresSelection: true },
  { id: 'outline', label: '提取大纲', description: '识别章节与逻辑层级', prompt: '请提取当前文档的大纲，保留章节层级，并概括每节目的。' },
  { id: 'translate', label: '翻译', description: '保持术语与原始结构', prompt: '请翻译当前文档或选中内容，保持技术术语、编号和原始结构。' },
  { id: 'review', label: '审查文档', description: '发现矛盾、遗漏和风险', prompt: '请审查当前文档，列出矛盾、遗漏、歧义、不可验证项和建议修改。' },
  { id: 'table-insights', label: '表格洞察', description: '趋势、异常与可行动结论', prompt: '请分析当前表格，识别趋势、异常、关键指标和可行动结论。' },
  { id: 'key-facts', label: '提取关键事实', description: '数字、日期、主体与约束', prompt: '请从当前文档提取关键事实，包括数字、日期、主体、约束和原文依据。不要推测。' },
  { id: 'action-items', label: '生成行动项', description: '责任、优先级与验收条件', prompt: '请把当前文档转成行动项清单，标出责任角色、优先级、前置条件和验收标准；缺失信息请标为待确认。' },
  { id: 'risk-register', label: '风险登记', description: '风险、影响、概率与缓解措施', prompt: '请根据当前文档生成风险登记表，包含风险、触发条件、影响、概率、缓解措施和待确认项。' },
  { id: 'questions', label: '生成问题清单', description: '澄清问题与评审问题', prompt: '请根据当前文档生成一份高价值问题清单，区分澄清问题、评审问题和验收问题。' },
  { id: 'rewrite-tone', label: '改写语气', description: '更专业、简洁、友好', prompt: '请将当前文档或选中内容改写为更专业、简洁、友好的语气，保持事实与数据不变。' },
  { id: 'compress-length', label: '压缩篇幅', description: '保留关键信息到 30%', prompt: '请把当前文档压缩到原文 30% 以内，保留关键结论、数据和行动项，用列表呈现。' },
  { id: 'meeting-minutes', label: '生成会议纪要', description: '议题、结论与行动项', prompt: '请将当前文档整理为会议纪要，包含议题、讨论要点、结论、责任人、行动项与截止时间；缺失信息标为待确认。' },
  { id: 'swot', label: 'SWOT 分析', description: '优势、劣势、机会、威胁', prompt: '请基于当前文档做 SWOT 分析（优势、劣势、机会、威胁），用 Markdown 表格呈现，并给出策略建议。' },
  { id: 'compare-selection', label: '对比选段与全文', description: '找出矛盾与重复', prompt: '请对比选中内容与文档其余部分，找出矛盾、重复和不一致之处，并给出统一建议。', requiresSelection: true },
]

const QUICK_ACTION_INDEX: Readonly<Record<string, string>> = {
  summarize: '01',
  'explain-selection': '02',
  outline: '03',
  translate: '04',
  review: '05',
  'table-insights': '06',
  'key-facts': '07',
  'action-items': '08',
  'risk-register': '09',
  questions: '10',
  'rewrite-tone': '11',
  'compress-length': '12',
  'meeting-minutes': '13',
  swot: '14',
  'compare-selection': '15',
}

function formatTime(value: AssistantMessage['createdAt']): string | null {
  if (value === undefined) return null
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatCompact(value: number): string {
  if (value >= 10000) return `${(value / 1000).toFixed(0)}K`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

function formatStats(stats: NonNullable<AssistantMessage['stats']>): string {
  const parts: string[] = []
  if (stats.ttftMs !== undefined) parts.push(`首字 ${(stats.ttftMs / 1000).toFixed(1)}s`)
  if (stats.durationMs !== undefined) parts.push(`共 ${(stats.durationMs / 1000).toFixed(1)}s`)
  if (stats.characters !== undefined) parts.push(`${formatCompact(stats.characters)} 字符`)
  return parts.join(' · ')
}

function getMessageLabel(message: AssistantMessage): string {
  if (message.role === 'user') return '你'
  if (message.role === 'system') return '系统'
  return message.modelLabel || '智能助手'
}

export function DocumentAssistant({
  open,
  initialOpen = false,
  models,
  selectedModelId,
  messages = [],
  document: documentContext,
  state = 'idle',
  error,
  disabled = false,
  placeholder = '询问当前文档，或描述需要完成的任务…',
  privacyNote = '文档内容仅在你主动发送时交给当前模型。使用第三方模型前，请确认其数据处理策略。',
  quickActions = DEFAULT_ACTIONS,
  promptSnippets = [],
  composerInsert = null,
  defaultWidth = 420,
  minWidth = 336,
  maxWidth = 680,
  onOpenChange,
  onModelChange,
  onSend,
  onQuickAction,
  onStop,
  onClear,
  onRetry,
  onRegenerate,
  onEditResend,
  onExportChat,
  onOpenSettings,
  onReferenceActivate,
}: DocumentAssistantProps) {
  const [internalOpen, setInternalOpen] = useState(initialOpen)
  const [internalModelId, setInternalModelId] = useState(selectedModelId ?? models[0]?.id ?? '')
  const [draft, setDraft] = useState('')
  const [panelWidth, setPanelWidth] = useState(() => Math.min(maxWidth, Math.max(minWidth, defaultWidth)))
  const [localError, setLocalError] = useState<string | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [sensitiveHits, setSensitiveHits] = useState<readonly SensitiveMatch[] | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const titleId = useId()
  const panelId = useId()
  const isOpen = open ?? internalOpen
  const isRunning = state === 'loading' || state === 'streaming'
  const modelId = selectedModelId ?? internalModelId
  const currentModel = models.find((model) => model.id === modelId) ?? models[0]
  const hasSelection = Boolean(documentContext?.selection?.text.trim())
  const visibleError = error || localError || (state === 'error' ? '模型请求失败，请重试或切换模型。' : null)

  const updateOpen = useCallback((next: boolean) => {
    if (open === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }, [onOpenChange, open])

  const closePanel = useCallback(() => {
    updateOpen(false)
    window.setTimeout(() => launcherRef.current?.focus(), 0)
  }, [updateOpen])

  useEffect(() => {
    if (!models.length) {
      setInternalModelId('')
      return
    }
    if (!models.some((model) => model.id === modelId)) {
      setInternalModelId(models[0].id)
      onModelChange?.(models[0].id)
    }
  }, [modelId, models, onModelChange])

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i') {
        event.preventDefault()
        updateOpen(!isOpen)
      }
      if (event.key === 'Escape' && isOpen && event.target instanceof Node && panelRef.current?.contains(event.target)) {
        event.preventDefault()
        closePanel()
      }
    }
    window.addEventListener('keydown', onGlobalKeyDown)
    return () => window.removeEventListener('keydown', onGlobalKeyDown)
  }, [closePanel, isOpen, updateOpen])

  useEffect(() => {
    if (isOpen) {
      const timer = window.setTimeout(() => composerRef.current?.focus(), 120)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [isOpen])

  useEffect(() => {
    // Only stick to the bottom while the user is already there — streaming
    // must not yank the view away from someone reading earlier messages.
    if (isOpen && pinnedToBottom.current) messageEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [isOpen, messages, state])

  const modelDescription = useMemo(() => {
    if (!currentModel) return '尚未配置模型'
    return [currentModel.provider, currentModel.description].filter(Boolean).join(' · ')
  }, [currentModel])

  const selectModel = (nextModelId: string) => {
    setInternalModelId(nextModelId)
    onModelChange?.(nextModelId)
  }

  const submit = async (skipSensitiveCheck = false) => {
    const content = draft.trim()
    if (!content || disabled || isRunning || !currentModel || currentModel.available === false) return
    // Pre-send sensitive-content gate: secrets and personal ids need an explicit confirmation.
    if (!skipSensitiveCheck) {
      const hits = detectSensitiveContent(content)
      if (hits.length) {
        setSensitiveHits(hits)
        return
      }
    }
    setSensitiveHits(null)
    pinnedToBottom.current = true
    setLocalError(null)
    try {
      await onSend({ content, modelId: currentModel.id, document: documentContext })
      setDraft('')
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const startEditMessage = (message: AssistantMessage) => {
    setEditingMessageId(message.id)
    setEditDraft(message.content)
  }

  const submitEditMessage = async () => {
    const content = editDraft.trim()
    if (!content || !editingMessageId || !onEditResend) return
    const messageId = editingMessageId
    setEditingMessageId(null)
    setLocalError(null)
    try {
      await onEditResend(messageId, content)
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const runQuickAction = async (action: AssistantQuickAction) => {
    if (disabled || isRunning || !currentModel || currentModel.available === false || action.requiresSelection && !hasSelection) return
    pinnedToBottom.current = true
    setLocalError(null)
    if (!onQuickAction) {
      setDraft(action.prompt)
      composerRef.current?.focus()
      return
    }
    try {
      await onQuickAction({ action, modelId: currentModel.id, document: documentContext })
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const handleBodyScroll = () => {
    const body = bodyRef.current
    if (!body) return
    pinnedToBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48
  }

  // Markdown links in assistant replies open externally; in-window navigation is denied.
  const handleMessagesClick = (event: ReactMouseEvent) => {
    if (!(event.target instanceof Element)) return
    const anchor = event.target.closest('a[href]')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) void window.officeDesktop.openExternal(href)
  }

  // Slash commands: typing '/' opens the quick-action palette above the composer.
  const slashQuery = draft.startsWith('/') && !draft.includes('\n') ? draft.slice(1) : null
  const slashActions = useMemo(() => {
    if (slashQuery === null) return []
    const query = slashQuery.toLowerCase()
    return quickActions.filter((action) => {
      if (action.requiresSelection && !hasSelection) return false
      if (!query) return true
      return action.label.toLowerCase().includes(query) || action.id.toLowerCase().includes(query)
    })
  }, [slashQuery, quickActions, hasSelection])
  const [slashIndex, setSlashIndex] = useState(0)
  useEffect(() => setSlashIndex(0), [slashQuery])

  // Prompt library: one-click insert of saved prompts into the composer draft.
  const [promptMenuOpen, setPromptMenuOpen] = useState(false)
  const insertPromptSnippet = (snippet: AssistantPromptSnippet) => {
    setDraft((current) => current.trim() ? `${current}\n${snippet.content}` : snippet.content)
    setPromptMenuOpen(false)
    composerRef.current?.focus()
  }

  // External inserts (e.g. "引用到助手" from the document selection toolbar).
  const lastInsertToken = useRef(0)
  useEffect(() => {
    if (!composerInsert || composerInsert.token === lastInsertToken.current) return
    lastInsertToken.current = composerInsert.token
    setDraft((current) => current.trim() ? `${current}\n${composerInsert.text}` : composerInsert.text)
    window.setTimeout(() => composerRef.current?.focus(), 60)
  }, [composerInsert])

  const runSlashAction = (action: AssistantQuickAction) => {
    setDraft('')
    void runQuickAction(action)
  }

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashActions.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSlashIndex((index) => (index + 1) % slashActions.length); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex((index) => (index - 1 + slashActions.length) % slashActions.length); return }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        runSlashAction(slashActions[slashIndex] ?? slashActions[0])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDraft('')
        return
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submit()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePanel()
    }
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.matchMedia('(max-width: 720px)').matches) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = panelWidth
    const onMove = (moveEvent: PointerEvent) => {
      setPanelWidth(Math.min(maxWidth, Math.max(minWidth, startWidth + startX - moveEvent.clientX)))
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd, { once: true })
    window.addEventListener('pointercancel', onEnd, { once: true })
  }

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    if (event.key === 'Home') setPanelWidth(minWidth)
    else if (event.key === 'End') setPanelWidth(maxWidth)
    else setPanelWidth((width) => Math.min(maxWidth, Math.max(minWidth, width + (event.key === 'ArrowLeft' ? 24 : -24))))
  }

  const copyMessage = async (message: AssistantMessage) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedMessageId(message.id)
      window.setTimeout(() => setCopiedMessageId((id) => id === message.id ? null : id), 1600)
    } catch {
      setLocalError('无法复制内容，请检查系统剪贴板权限。')
    }
  }

  const panelStyle = { '--assistant-panel-width': `${panelWidth}px` } as CSSProperties

  return (
    <div className={`document-assistant${isOpen ? ' is-open' : ''}`} style={panelStyle}>
      {!isOpen && (
        <button
          ref={launcherRef}
          className="document-assistant__launcher"
          type="button"
          onClick={() => updateOpen(true)}
          aria-label="打开文档交互智能助手"
          aria-keyshortcuts="Control+Shift+I"
          aria-controls={panelId}
          aria-expanded={false}
        >
          <span className="document-assistant__launcher-mark"><AssistantMark /></span>
          <span className="document-assistant__launcher-copy">
            <strong>AI 助手</strong>
            <small>{currentModel ? currentModel.label : '需要配置'}</small>
          </span>
          <kbd>⌃⇧I</kbd>
        </button>
      )}

      {isOpen && (
        <aside ref={panelRef} id={panelId} className="document-assistant__panel" aria-labelledby={titleId}>
          <div
            className="document-assistant__resize"
            role="separator"
            aria-label="调整助手面板宽度"
            aria-orientation="vertical"
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-valuenow={panelWidth}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={resizeWithKeyboard}
          ><span /></div>

          <header className="document-assistant__header">
            <div className="document-assistant__identity">
              <span className="document-assistant__header-mark"><AssistantMark /></span>
              <div>
                <p>DOCUMENT INTELLIGENCE</p>
                <h2 id={titleId}>文档交互助手</h2>
              </div>
            </div>
            <div className="document-assistant__header-actions">
              {onOpenSettings && <button type="button" onClick={onOpenSettings} aria-label="打开模型设置" title="模型设置"><SettingsIcon /></button>}
              {onExportChat && <button type="button" onClick={onExportChat} disabled={!messages.length || isRunning} aria-label="导出对话" title="导出对话为 Markdown"><DownloadIcon /></button>}
              {onClear && <button type="button" onClick={onClear} disabled={!messages.length || isRunning} aria-label="清空会话" title="清空会话"><ClearIcon /></button>}
              <button type="button" onClick={closePanel} aria-label="收起助手" title="收起助手（Esc）"><CollapseIcon /></button>
            </div>
          </header>

          <section className="document-assistant__context" aria-label="当前上下文">
            <DocumentIcon />
            <div>
              <strong>{documentContext?.name || '未打开文档'}</strong>
              <span>
                {documentContext?.format ? documentContext.format.toUpperCase() : '文档上下文'}{hasSelection ? ` · 已选 ${documentContext!.selection!.text.length} 字` : ' · 全文'}
                {documentContext?.extraction && ` · ${documentContext.extraction.strategy} 提取 ${formatCompact(documentContext.extraction.extractedCharacters)}/${formatCompact(documentContext.extraction.sourceCharacters)} 字符${documentContext.extraction.truncated ? '（已截断）' : ''}`}
              </span>
            </div>
            {hasSelection && <span className="document-assistant__selection-badge">SELECTION</span>}
            {documentContext?.extraction?.truncated && <span className="document-assistant__selection-badge" title={documentContext.extraction.warning || '文档过大，已按上下文上限截断'}>已截断</span>}
          </section>

          <section className="document-assistant__model" aria-label="模型选择">
            <label htmlFor={`${titleId}-model`}>执行模型</label>
            <div className="document-assistant__model-select">
              <select
                id={`${titleId}-model`}
                value={currentModel?.id || ''}
                onChange={(event) => selectModel(event.target.value)}
                disabled={disabled || isRunning || !models.length}
              >
                {!models.length && <option value="">尚未配置模型</option>}
                {models.map((model) => <option key={model.id} value={model.id} disabled={model.available === false}>{model.label} · {model.provider}{model.available === false ? '（不可用）' : ''}</option>)}
              </select>
              <span className={`document-assistant__model-led${!currentModel || currentModel.available === false ? ' is-offline' : ''}`} />
            </div>
            <span title={modelDescription}>{currentModel?.available === false ? (currentModel.description || '不可用') : currentModel?.badge || modelDescription}</span>
          </section>

          <div className="document-assistant__body" ref={bodyRef} onScroll={handleBodyScroll}>
            {!messages.length ? (
              <section className="document-assistant__empty">
                <div className="document-assistant__empty-heading">
                  <span><SparkIcon /></span>
                  <div><p>从文档开始，而不是从空白聊天开始</p><small>选择一个分析任务，助手会自动携带当前文档上下文。</small></div>
                </div>
                {isRunning && (
                  <div className="document-assistant__thinking document-assistant__thinking--empty" role="status"><span /><span /><span /><p>正在读取文档上下文</p></div>
                )}
                <div className="document-assistant__quick-actions" aria-label="文档快捷动作">
                  {quickActions.map((action, index) => {
                    const unavailable = disabled || isRunning || !currentModel || currentModel.available === false || Boolean(action.requiresSelection && !hasSelection)
                    return (
                      <button
                        key={action.id}
                        type="button"
                        disabled={unavailable}
                        onClick={() => void runQuickAction(action)}
                        title={action.requiresSelection && !hasSelection ? '请先在文档中选择内容' : action.description}
                      >
                        <span>{QUICK_ACTION_INDEX[action.id] || String(index + 1).padStart(2, '0')}</span>
                        <strong>{action.label}</strong>
                        <small>{action.description}</small>
                      </button>
                    )
                  })}
                </div>
              </section>
            ) : (
              <section className="document-assistant__messages" aria-label="助手会话" aria-live="polite" onClick={handleMessagesClick}>
                {messages.map((message, messageIndex) => (
                  <article key={message.id} className={`document-assistant__message is-${message.role}${message.pending ? ' is-pending' : ''}`}>
                    <header>
                      <span>{getMessageLabel(message)}</span>
                      <time>{formatTime(message.createdAt)}</time>
                      {message.stats && !message.pending && <time className="document-assistant__message-stats" title="首字延迟 · 总耗时 · 回答字符数">{formatStats(message.stats)}</time>}
                      {message.role === 'assistant' && onRegenerate && messageIndex === messages.length - 1 && !isRunning && (
                        <button type="button" onClick={onRegenerate} aria-label="重新生成" title="重新生成">
                          <RegenerateIcon />重新生成
                        </button>
                      )}
                      {message.role === 'user' && onEditResend && !isRunning && editingMessageId !== message.id && (
                        <button type="button" onClick={() => startEditMessage(message)} aria-label="编辑消息" title="编辑并重发（截断后续对话）">
                          <EditIcon />编辑
                        </button>
                      )}
                      {message.role !== 'system' && (
                        <button type="button" onClick={() => void copyMessage(message)} aria-label="复制此消息">
                          <CopyIcon />{copiedMessageId === message.id ? '已复制' : '复制'}
                        </button>
                      )}
                    </header>
                    {message.role === 'assistant' ? (
                      <AssistantMarkdownContent content={message.content || (message.pending ? '正在整理文档信息…' : '')} />
                    ) : editingMessageId === message.id ? (
                      <div className="document-assistant__message-edit">
                        <textarea
                          value={editDraft}
                          rows={3}
                          maxLength={16000}
                          aria-label="编辑消息内容"
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submitEditMessage() } }}
                        />
                        <div>
                          <button type="button" onClick={() => setEditingMessageId(null)}>取消</button>
                          <button type="button" className="is-primary" disabled={!editDraft.trim() || isRunning} onClick={() => void submitEditMessage()}>保存并重发</button>
                        </div>
                      </div>
                    ) : (
                      <div className="document-assistant__message-content">{message.content || (message.pending ? '正在整理文档信息…' : '')}</div>
                    )}
                    <span className="document-assistant__stream-caret" />
                    {message.references && message.references.length > 0 && (
                      <footer>
                        {message.references.map((reference) => (
                          <button key={reference.id} type="button" title={reference.detail} onClick={() => onReferenceActivate?.(message.id, reference)}>
                            <span>§</span>{reference.label}
                          </button>
                        ))}
                      </footer>
                    )}
                  </article>
                ))}
                {state === 'loading' && (
                  <div className="document-assistant__thinking" role="status"><span /><span /><span /><p>正在读取文档上下文</p></div>
                )}
                <div ref={messageEndRef} />
              </section>
            )}
          </div>

          {visibleError && (
            <div className="document-assistant__error" role="alert">
              <WarningIcon /><span><strong>请求未完成</strong>{visibleError}</span>
              {onRetry && <button type="button" onClick={onRetry}>重试</button>}
            </div>
          )}

          <footer className="document-assistant__composer">
            {sensitiveHits && sensitiveHits.length > 0 && (
              <div className="document-assistant__sensitive" role="alert">
                <WarningIcon />
                <span>
                  <strong>检测到可能的敏感信息</strong>
                  {sensitiveHits.map((hit) => `${hit.label}（${hit.sample}）`).join('、')}
                </span>
                <button type="button" onClick={() => setSensitiveHits(null)}>取消</button>
                <button type="button" className="is-primary" onClick={() => void submit(true)}>仍要发送</button>
              </div>
            )}
            <div className="document-assistant__input-wrap">
              {promptMenuOpen && promptSnippets.length > 0 && (
                <div className="document-assistant__slash-menu" role="listbox" aria-label="提示词库">
                  {promptSnippets.map((snippet) => (
                    <button
                      key={snippet.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(event) => { event.preventDefault(); insertPromptSnippet(snippet) }}
                    >
                      <strong>{snippet.title}</strong>
                      <small>{snippet.content.slice(0, 60)}{snippet.content.length > 60 ? '…' : ''}</small>
                    </button>
                  ))}
                </div>
              )}
              {slashActions.length > 0 && (
                <div className="document-assistant__slash-menu" role="listbox" aria-label="快捷动作">
                  {slashActions.map((action, index) => (
                    <button
                      key={action.id}
                      type="button"
                      role="option"
                      aria-selected={index === slashIndex}
                      className={index === slashIndex ? 'is-active' : ''}
                      onMouseDown={(event) => { event.preventDefault(); runSlashAction(action) }}
                      onMouseEnter={() => setSlashIndex(index)}
                    >
                      <strong>{action.label}</strong>
                      <small>{action.description}</small>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                rows={3}
                maxLength={16000}
                placeholder={models.length ? placeholder : '请先配置 Codex、Claude Code 或第三方模型'}
                disabled={disabled || !models.length}
                aria-label="发送给文档助手的消息"
              />
              <span className="document-assistant__char-count">{draft.length.toLocaleString('zh-CN')} / 16K</span>
              {isRunning ? (
                <button className="document-assistant__send is-stop" type="button" onClick={onStop} disabled={!onStop} aria-label="停止生成"><StopIcon />停止</button>
              ) : (
                <button className="document-assistant__send" type="button" onClick={() => void submit()} disabled={disabled || !draft.trim() || !currentModel || currentModel.available === false} aria-label="发送消息"><SendIcon />发送</button>
              )}
            </div>
            <div className="document-assistant__composer-meta">
              <span><span className="document-assistant__privacy-led" />{privacyNote}</span>
              {promptSnippets.length > 0 && (
                <button
                  type="button"
                  className="document-assistant__prompt-library"
                  aria-expanded={promptMenuOpen}
                  onClick={() => setPromptMenuOpen((open) => !open)}
                >提示词库</button>
              )}
              <kbd>Ctrl ↵</kbd>
            </div>
          </footer>
        </aside>
      )}
    </div>
  )
}

export default DocumentAssistant
