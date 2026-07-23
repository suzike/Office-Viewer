export type AssistantRunState = 'idle' | 'loading' | 'streaming' | 'error'

export type AssistantMessageRole = 'user' | 'assistant' | 'system'

export interface AssistantModelOption {
  id: string
  label: string
  provider: string
  description?: string
  available?: boolean
  badge?: string
}

export interface AssistantSelectionContext {
  text: string
  label?: string
}

export interface AssistantDocumentContext {
  id?: string
  name: string
  format?: string
  path?: string
  selection?: AssistantSelectionContext | null
  metadata?: Readonly<Record<string, string | number | boolean | null>>
  /** How the document text was extracted for the model (shown after the first request). */
  extraction?: {
    strategy: string
    extractedCharacters: number
    sourceCharacters: number
    truncated: boolean
    warning?: string
  } | null
}

export interface AssistantReference {
  id: string
  label: string
  detail?: string
}

export interface AssistantMessage {
  id: string
  role: AssistantMessageRole
  content: string
  createdAt?: number | string
  modelLabel?: string
  pending?: boolean
  references?: readonly AssistantReference[]
  /** Filled when the request completes: client-measured latency and answer size. */
  stats?: {
    durationMs?: number
    ttftMs?: number
    characters?: number
  }
  /** Selection text attached when the user message was sent; reused by edit-and-resend. */
  selectionSnapshot?: string
}

export type AssistantQuickActionId =
  | 'summarize'
  | 'explain-selection'
  | 'outline'
  | 'translate'
  | 'review'
  | 'table-insights'
  | (string & {})

export interface AssistantQuickAction {
  id: AssistantQuickActionId
  label: string
  description: string
  prompt: string
  requiresSelection?: boolean
}

/** Saved prompt shown in the composer prompt library. */
export interface AssistantPromptSnippet {
  id: string
  title: string
  content: string
}

/** External request to insert text into the composer (token changes trigger the insert). */
export interface AssistantComposerInsert {
  text: string
  token: number
}

export interface AssistantRequestContext {
  modelId: string
  document?: AssistantDocumentContext | null
}

export interface AssistantSendRequest extends AssistantRequestContext {
  content: string
}

export interface AssistantQuickActionRequest extends AssistantRequestContext {
  action: AssistantQuickAction
}

export interface DocumentAssistantProps {
  /** 传入时组件进入受控开关模式。 */
  open?: boolean
  initialOpen?: boolean
  models: readonly AssistantModelOption[]
  selectedModelId?: string
  messages?: readonly AssistantMessage[]
  document?: AssistantDocumentContext | null
  state?: AssistantRunState
  error?: string | null
  disabled?: boolean
  placeholder?: string
  privacyNote?: string
  quickActions?: readonly AssistantQuickAction[]
  /** Prompt library entries shown above the composer for one-click insert. */
  promptSnippets?: readonly AssistantPromptSnippet[]
  /** When the token changes, the text is appended to the composer draft. */
  composerInsert?: AssistantComposerInsert | null
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  onOpenChange?: (open: boolean) => void
  onModelChange?: (modelId: string) => void
  onSend: (request: AssistantSendRequest) => void | Promise<void>
  onQuickAction?: (request: AssistantQuickActionRequest) => void | Promise<void>
  onStop?: () => void
  onClear?: () => void
  onRetry?: () => void
  /** Regenerate the last assistant answer (same mechanics as retry). */
  onRegenerate?: () => void
  /** Edit a user message and resend it, truncating everything that followed it. */
  onEditResend?: (messageId: string, content: string) => void | Promise<void>
  /** Export the current conversation as a Markdown file. */
  onExportChat?: () => void
  onOpenSettings?: () => void
  onReferenceActivate?: (messageId: string, reference: AssistantReference) => void
}
