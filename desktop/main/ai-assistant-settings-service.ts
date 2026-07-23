import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  DesktopAiAssistantSettings,
  DesktopAiAssistantSettingsInput,
  DesktopAiCustomAction,
  DesktopAiModelParameters,
  DesktopAiPromptProfile,
  DesktopAiPromptSnippet,
  DesktopAiProvider,
  DesktopAiProviderInput,
  DesktopAiProviderKind,
} from '../shared/desktop-api'

const SETTINGS_FILE = 'ai-assistant-settings.json'
const SECRETS_FILE = 'ai-assistant-secrets.bin'
const MAX_SETTINGS_BYTES = 1024 * 1024
const MIN_CONTEXT_CHARACTERS = 8_000
const MAX_CONTEXT_CHARACTERS = 500_000
const DEFAULT_CONTEXT_CHARACTERS = 160_000
const MAX_CUSTOM_ACTIONS = 50
const MAX_PROMPT_SNIPPETS = 100

export interface AiAssistantSecretProtector {
  isAvailable(): boolean
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}

export interface ResolvedAiProvider extends DesktopAiProvider {
  readonly apiKey?: string
}

interface PersistedProvider extends Omit<DesktopAiProvider, 'hasApiKey'> {}

interface PersistedSettings {
  readonly version: 1
  readonly activeProviderId: string
  readonly contextCharacterLimit: number
  readonly providers: readonly PersistedProvider[]
  readonly customActions: readonly DesktopAiCustomAction[]
  readonly promptLibrary: readonly DesktopAiPromptSnippet[]
  readonly promptProfile: DesktopAiPromptProfile
  readonly globalShortcutEnabled: boolean
  readonly modelParameters: DesktopAiModelParameters
}

const DEFAULT_PROVIDERS: readonly PersistedProvider[] = [
  { id: 'codex-local', name: 'Codex（本地）', kind: 'codex-cli', enabled: true, executable: 'codex', builtIn: true },
  { id: 'claude-local', name: 'Claude Code（本地）', kind: 'claude-cli', enabled: true, executable: 'claude', builtIn: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', enabled: false, model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', builtIn: true },
  { id: 'kimi', name: 'Kimi', kind: 'openai-compatible', enabled: false, model: 'kimi-k2.6', baseUrl: 'https://api.moonshot.cn/v1', builtIn: true },
  { id: 'ollama-local', name: 'Ollama（本地）', kind: 'ollama', enabled: false, model: 'qwen3', baseUrl: 'http://127.0.0.1:11434', allowPrivateNetwork: true, builtIn: true },
]

export class AiAssistantSettingsService {
  private readonly settingsPath: string
  private readonly secretsPath: string

  public constructor(directory: string, private readonly protector: AiAssistantSecretProtector) {
    this.settingsPath = join(directory, SETTINGS_FILE)
    this.secretsPath = join(directory, SECRETS_FILE)
  }

  public async load(): Promise<DesktopAiAssistantSettings> {
    const persisted = await this.readPersisted()
    const providers = mergeDefaults(persisted?.providers ?? [])
    const secrets = await this.readSecrets()
    const activeProviderId = providers.some((provider) => provider.id === persisted?.activeProviderId)
      ? persisted!.activeProviderId
      : providers.find((provider) => provider.enabled)?.id ?? providers[0].id
    return {
      activeProviderId,
      contextCharacterLimit: persisted?.contextCharacterLimit ?? DEFAULT_CONTEXT_CHARACTERS,
      customActions: persisted?.customActions ?? [],
      promptLibrary: persisted?.promptLibrary ?? [],
      promptProfile: persisted?.promptProfile ?? {},
      globalShortcutEnabled: persisted?.globalShortcutEnabled === true,
      modelParameters: persisted?.modelParameters ?? {},
      providers: providers.map((provider) => ({
        ...provider,
        hasApiKey: Boolean(secrets[provider.id]),
      })),
    }
  }

  public async save(input: DesktopAiAssistantSettingsInput): Promise<DesktopAiAssistantSettings> {
    const current = await this.load()
    const currentSecrets = await this.readSecrets()
    const providers = validateProviderInputs(input.providers, current.providers)
    const nextSecrets = { ...currentSecrets }
    for (const provider of input.providers) {
      if (provider.removeApiKey === true) delete nextSecrets[provider.id]
      if (typeof provider.apiKey === 'string' && provider.apiKey.trim()) {
        if (provider.apiKey.length > 64 * 1024) throw new RangeError('AI provider API key exceeds the 64 KB limit.')
        nextSecrets[provider.id] = provider.apiKey.trim()
      }
    }
    const providerIds = new Set(providers.map((provider) => provider.id))
    for (const id of Object.keys(nextSecrets)) if (!providerIds.has(id)) delete nextSecrets[id]
    const activeProviderId = requireIdentifier(input.activeProviderId, 'Active AI provider id')
    if (!providers.some((provider) => provider.id === activeProviderId)) {
      throw new Error('The selected AI provider no longer exists.')
    }
    const contextCharacterLimit = normalizeContextLimit(input.contextCharacterLimit)
    const customActions = input.customActions === undefined
      ? current.customActions
      : validateCustomActionInputs(input.customActions)
    const promptLibrary = input.promptLibrary === undefined
      ? current.promptLibrary
      : validatePromptSnippetInputs(input.promptLibrary)
    const promptProfile = input.promptProfile === undefined
      ? current.promptProfile
      : validatePromptProfile(input.promptProfile)
    const globalShortcutEnabled = input.globalShortcutEnabled ?? current.globalShortcutEnabled
    const modelParameters = input.modelParameters === undefined
      ? current.modelParameters
      : validateModelParameters(input.modelParameters)
    await this.writeSecrets(nextSecrets)
    const payload: PersistedSettings = {
      version: 1,
      activeProviderId,
      contextCharacterLimit,
      customActions,
      promptLibrary,
      promptProfile,
      globalShortcutEnabled,
      modelParameters,
      providers: providers.map(({ hasApiKey: _hasApiKey, ...provider }) => provider),
    }
    await writeJsonAtomically(this.settingsPath, payload)
    return this.load()
  }

  public async resolve(providerId: string): Promise<ResolvedAiProvider> {
    const id = requireIdentifier(providerId, 'AI provider id')
    const settings = await this.load()
    const provider = settings.providers.find((entry) => entry.id === id)
    if (!provider) throw new Error('The selected AI provider is not configured.')
    if (!provider.enabled) throw new Error(`AI provider “${provider.name}” is disabled.`)
    const secrets = await this.readSecrets()
    return { ...provider, apiKey: secrets[id] }
  }

  private async readPersisted(): Promise<PersistedSettings | undefined> {
    try {
      const data = await readFile(this.settingsPath)
      if (data.byteLength > MAX_SETTINGS_BYTES) return undefined
      const parsed = JSON.parse(data.toString('utf8')) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return undefined
      const rawProviders = Array.isArray(parsed.providers) ? parsed.providers : []
      const providers = validatePersistedProviders(rawProviders)
      return {
        version: 1,
        activeProviderId: typeof parsed.activeProviderId === 'string' ? parsed.activeProviderId : 'codex-local',
        contextCharacterLimit: normalizeContextLimit(parsed.contextCharacterLimit),
        customActions: readPersistedArray(parsed.customActions, MAX_CUSTOM_ACTIONS, validateCustomAction),
        promptLibrary: readPersistedArray(parsed.promptLibrary, MAX_PROMPT_SNIPPETS, validatePromptSnippet),
        promptProfile: readPersistedPromptProfile(parsed.promptProfile),
        globalShortcutEnabled: parsed.globalShortcutEnabled === true,
        modelParameters: readPersistedModelParameters(parsed.modelParameters),
        providers,
      }
    } catch {
      return undefined
    }
  }

  private async readSecrets(): Promise<Record<string, string>> {
    if (!this.protector.isAvailable()) return {}
    try {
      const encrypted = await readFile(this.secretsPath)
      if (encrypted.byteLength > MAX_SETTINGS_BYTES) return {}
      const parsed = JSON.parse(this.protector.decrypt(encrypted)) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => (
        isIdentifier(key) && typeof value === 'string' && value.length <= 64 * 1024
      )))
    } catch {
      return {}
    }
  }

  private async writeSecrets(secrets: Record<string, string>): Promise<void> {
    if (!this.protector.isAvailable()) {
      if (Object.keys(secrets).length) throw new Error('Windows secure storage is unavailable; API keys were not saved.')
      return
    }
    const encrypted = this.protector.encrypt(JSON.stringify(secrets))
    await atomicWrite(this.secretsPath, encrypted)
  }
}

function mergeDefaults(persisted: readonly PersistedProvider[]): PersistedProvider[] {
  const byId = new Map(persisted.map((provider) => [provider.id, provider]))
  const result: PersistedProvider[] = DEFAULT_PROVIDERS.map((provider) => ({ ...provider, ...(byId.get(provider.id) ?? {}), builtIn: true }))
  const defaultIds = new Set(DEFAULT_PROVIDERS.map((provider) => provider.id))
  result.push(...persisted.filter((provider) => !defaultIds.has(provider.id)))
  return result
}

function validateProviderInputs(
  inputs: readonly DesktopAiProviderInput[],
  current: readonly DesktopAiProvider[],
): DesktopAiProvider[] {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 50) {
    throw new RangeError('Configure between 1 and 50 AI providers.')
  }
  const currentById = new Map(current.map((provider) => [provider.id, provider]))
  const seen = new Set<string>()
  return inputs.map((input) => {
    if (!input || typeof input !== 'object') throw new TypeError('AI provider configuration must be an object.')
    const id = requireIdentifier(input.id, 'AI provider id')
    if (seen.has(id)) throw new Error(`Duplicate AI provider id: ${id}`)
    seen.add(id)
    const kind = requireProviderKind(input.kind)
    const name = requireText(input.name, 'AI provider name', 80)
    const previous = currentById.get(id)
    const provider: DesktopAiProvider = {
      id,
      name,
      kind,
      enabled: input.enabled !== false,
      model: optionalText(input.model, 'AI model', 160),
      baseUrl: optionalProviderUrl(input.baseUrl),
      executable: optionalExecutable(input.executable),
      allowPrivateNetwork: input.allowPrivateNetwork === true,
      hasApiKey: previous?.hasApiKey === true || Boolean(input.apiKey?.trim()),
      builtIn: previous?.builtIn === true,
    }
    if (kind.endsWith('-cli') && !provider.executable) {
      return { ...provider, executable: kind === 'codex-cli' ? 'codex' : 'claude' }
    }
    if (!kind.endsWith('-cli') && !provider.baseUrl) throw new Error(`AI provider “${name}” requires a base URL.`)
    if (!kind.endsWith('-cli') && !provider.model) throw new Error(`AI provider “${name}” requires a model name.`)
    return provider
  })
}

function validatePersistedProviders(values: readonly unknown[]): PersistedProvider[] {
  const result: PersistedProvider[] = []
  for (const value of values.slice(0, 50)) {
    try {
      const provider = validateProviderInputs([value as DesktopAiProviderInput], [])[0]
      const { hasApiKey: _hasApiKey, ...persisted } = provider
      result.push(persisted)
    } catch {
      // Ignore one malformed provider without discarding the rest of the settings file.
    }
  }
  return result
}

function validateCustomActionInputs(inputs: readonly DesktopAiCustomAction[]): DesktopAiCustomAction[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_CUSTOM_ACTIONS) {
    throw new RangeError(`Configure at most ${MAX_CUSTOM_ACTIONS} custom quick actions.`)
  }
  const seen = new Set<string>()
  return inputs.map((input) => {
    const action = validateCustomAction(input)
    if (seen.has(action.id)) throw new Error(`Duplicate custom quick action id: ${action.id}`)
    seen.add(action.id)
    return action
  })
}

function validateCustomAction(value: unknown): DesktopAiCustomAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Custom quick action must be an object.')
  const input = value as Record<string, unknown>
  return {
    id: requireIdentifier(input.id, 'Custom quick action id'),
    label: requireText(input.label, 'Custom quick action label', 80),
    description: optionalText(input.description, 'Custom quick action description', 160),
    prompt: requireText(input.prompt, 'Custom quick action prompt', 4_000),
    requiresSelection: input.requiresSelection === true,
  }
}

function validatePromptSnippetInputs(inputs: readonly DesktopAiPromptSnippet[]): DesktopAiPromptSnippet[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_PROMPT_SNIPPETS) {
    throw new RangeError(`Configure at most ${MAX_PROMPT_SNIPPETS} prompt library entries.`)
  }
  const seen = new Set<string>()
  return inputs.map((input) => {
    const snippet = validatePromptSnippet(input)
    if (seen.has(snippet.id)) throw new Error(`Duplicate prompt library entry id: ${snippet.id}`)
    seen.add(snippet.id)
    return snippet
  })
}

function validatePromptSnippet(value: unknown): DesktopAiPromptSnippet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Prompt library entry must be an object.')
  const input = value as Record<string, unknown>
  return {
    id: requireIdentifier(input.id, 'Prompt library entry id'),
    title: requireText(input.title, 'Prompt library entry title', 80),
    content: requireText(input.content, 'Prompt library entry content', 16_000),
  }
}

function validatePromptProfile(value: unknown): DesktopAiPromptProfile {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Assistant prompt profile must be an object.')
  const input = value as Record<string, unknown>
  return {
    persona: optionalText(input.persona, 'Assistant persona', 1_000),
    outputLanguage: optionalText(input.outputLanguage, 'Assistant output language', 80),
    style: optionalText(input.style, 'Assistant response style', 500),
  }
}

function readPersistedArray<T>(value: unknown, maximum: number, validate: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) return []
  const result: T[] = []
  for (const entry of value.slice(0, maximum)) {
    try {
      result.push(validate(entry))
    } catch {
      // Ignore one malformed entry without discarding the rest of the settings file.
    }
  }
  return result
}

function readPersistedPromptProfile(value: unknown): DesktopAiPromptProfile {
  try {
    return validatePromptProfile(value)
  } catch {
    return {}
  }
}

const MIN_MAX_TOKENS = 1
const MAX_MAX_TOKENS = 1_000_000

function validateModelParameters(value: unknown): DesktopAiModelParameters {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('AI model parameters must be an object.')
  const input = value as Record<string, unknown>
  const parameters: { temperature?: number; maxTokens?: number } = {}
  if (input.temperature !== undefined && input.temperature !== null && input.temperature !== '') {
    const temperature = Number(input.temperature)
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new RangeError('AI temperature must be between 0 and 2.')
    }
    parameters.temperature = temperature
  }
  if (input.maxTokens !== undefined && input.maxTokens !== null && input.maxTokens !== '') {
    const maxTokens = Number(input.maxTokens)
    if (!Number.isInteger(maxTokens) || maxTokens < MIN_MAX_TOKENS || maxTokens > MAX_MAX_TOKENS) {
      throw new RangeError(`AI max tokens must be an integer between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}.`)
    }
    parameters.maxTokens = maxTokens
  }
  return parameters
}

function readPersistedModelParameters(value: unknown): DesktopAiModelParameters {
  try {
    return validateModelParameters(value)
  } catch {
    return {}
  }
}

function requireProviderKind(value: unknown): DesktopAiProviderKind {
  const kinds: readonly DesktopAiProviderKind[] = ['codex-cli', 'claude-cli', 'openai-compatible', 'anthropic', 'gemini', 'ollama']
  if (!kinds.includes(value as DesktopAiProviderKind)) throw new TypeError('Unsupported AI provider kind.')
  return value as DesktopAiProviderKind
}

function optionalProviderUrl(value: unknown): string | undefined {
  const text = optionalText(value, 'AI provider URL', 2048)
  if (!text) return undefined
  const url = new URL(text)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('AI provider URL must use HTTP(S) and cannot contain credentials.')
  }
  return url.href.replace(/\/$/, '')
}

function optionalExecutable(value: unknown): string | undefined {
  const text = optionalText(value, 'AI provider executable', 1024)
  if (!text) return undefined
  if (text.includes('\0') || /[\r\n]/.test(text)) throw new TypeError('AI provider executable contains invalid characters.')
  return text
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requireText(value, label, maximum)
}

function requireText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${label} must contain between 1 and ${maximum} characters.`)
  }
  return value.trim()
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isIdentifier(value)) throw new TypeError(`${label} is invalid.`)
  return value
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function normalizeContextLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_CONTEXT_CHARACTERS
  if (!Number.isInteger(value) || (value as number) < MIN_CONTEXT_CHARACTERS || (value as number) > MAX_CONTEXT_CHARACTERS) {
    throw new RangeError(`AI document context must be between ${MIN_CONTEXT_CHARACTERS} and ${MAX_CONTEXT_CHARACTERS} characters.`)
  }
  return value as number
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(json) > MAX_SETTINGS_BYTES) throw new RangeError('AI assistant settings exceed the 1 MB limit.')
  await atomicWrite(path, Buffer.from(json, 'utf8'))
}

async function atomicWrite(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  let created = false
  try {
    const handle = await open(temporary, 'wx')
    created = true
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    created = false
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => undefined)
  }
}
