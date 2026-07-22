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
  onOpenSettings?: () => void
  onReferenceActivate?: (messageId: string, reference: AssistantReference) => void
}
