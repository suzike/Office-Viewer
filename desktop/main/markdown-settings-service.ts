import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  DesktopMarkdownPreferencePatch,
  DesktopMarkdownPreferences,
  DesktopMarkdownViewerSettings,
} from '../shared/desktop-api'

const SETTINGS_FILE = 'markdown-settings.json'
const SECRETS_FILE = 'markdown-ai-secrets.bin'
const MAX_SETTINGS_BYTES = 1024 * 1024

export interface MarkdownSecretProtector {
  isAvailable(): boolean
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}

interface PersistedMarkdownSettings {
  readonly version: 1
  readonly preferences: Omit<DesktopMarkdownPreferences, 'viewerSettings'>
  readonly viewerSettings: {
    readonly enabled: boolean
    readonly settings?: DesktopMarkdownViewerSettings
  }
}

const DEFAULT_PREFERENCES: DesktopMarkdownPreferences = {
  editMode: 'wysiwyg',
  editorTheme: 'Auto',
  codeMirrorTheme: 'Auto',
  mermaidTheme: 'Auto',
  workspacePathAsImageBasePath: false,
  pasterImgPath: 'image/${fileName}/${now}.${ext}',
  pdfMarginTop: 25,
  viewerSettings: { enabled: false },
}

export class MarkdownSettingsService {
  private readonly settingsPath: string
  private readonly secretsPath: string
  private mutationQueue: Promise<void> = Promise.resolve()

  public constructor(directory: string, private readonly protector: MarkdownSecretProtector) {
    this.settingsPath = join(directory, SETTINGS_FILE)
    this.secretsPath = join(directory, SECRETS_FILE)
  }

  public async load(): Promise<DesktopMarkdownPreferences> {
    await this.mutationQueue
    return this.loadUnqueued()
  }

  private async loadUnqueued(): Promise<DesktopMarkdownPreferences> {
    const persisted = await this.readPersisted()
    const settings = persisted?.viewerSettings.settings
    return {
      ...DEFAULT_PREFERENCES,
      ...(persisted?.preferences ?? {}),
      viewerSettings: {
        enabled: persisted?.viewerSettings.enabled === true,
        settings: settings ? await this.injectSecrets(settings) : undefined,
      },
    }
  }

  public update(patch: DesktopMarkdownPreferencePatch): Promise<DesktopMarkdownPreferences> {
    return this.enqueueMutation(async () => {
      const current = await this.loadUnqueued()
      const next: DesktopMarkdownPreferences = {
        ...current,
        ...validatePreferencePatch(patch),
      }
      await this.persist(next)
      return next
    })
  }

  public saveViewerSettings(settings: DesktopMarkdownViewerSettings): Promise<DesktopMarkdownPreferences> {
    return this.enqueueMutation(async () => {
      const current = await this.loadUnqueued()
      const normalized = validateViewerSettings(settings)
      const secrets = extractAiModelSecrets(normalized)
      if (Object.keys(secrets).length > 0) await this.writeSecrets(secrets)
      const next: DesktopMarkdownPreferences = {
        ...current,
        viewerSettings: {
          enabled: true,
          settings: normalized,
        },
      }
      await this.persist(next)
      return this.loadUnqueued()
    })
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(settings: DesktopMarkdownPreferences): Promise<void> {
    const viewerSettings = settings.viewerSettings.settings
      ? stripAiModelSecrets(validateViewerSettings(settings.viewerSettings.settings))
      : undefined
    const payload: PersistedMarkdownSettings = {
      version: 1,
      preferences: {
        editMode: settings.editMode,
        editorTheme: settings.editorTheme,
        codeMirrorTheme: settings.codeMirrorTheme,
        mermaidTheme: settings.mermaidTheme,
        workspacePathAsImageBasePath: settings.workspacePathAsImageBasePath,
        pasterImgPath: settings.pasterImgPath,
        pdfMarginTop: settings.pdfMarginTop,
      },
      viewerSettings: {
        enabled: settings.viewerSettings.enabled,
        settings: viewerSettings,
      },
    }
    const json = JSON.stringify(payload, null, 2)
    if (Buffer.byteLength(json) > MAX_SETTINGS_BYTES) throw new RangeError('Markdown settings exceed the 1 MB limit.')
    await atomicWrite(this.settingsPath, Buffer.from(json, 'utf8'))
  }

  private async readPersisted(): Promise<PersistedMarkdownSettings | undefined> {
    try {
      const data = await readFile(this.settingsPath)
      if (data.byteLength > MAX_SETTINGS_BYTES) return undefined
      const parsed = JSON.parse(data.toString('utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      const record = parsed as Record<string, unknown>
      if (record.version !== 1) return undefined
      const preferences = validatePreferencePatch(record.preferences)
      const rawViewer = record.viewerSettings
      const viewer = rawViewer && typeof rawViewer === 'object' && !Array.isArray(rawViewer)
        ? rawViewer as Record<string, unknown>
        : {}
      return {
        version: 1,
        preferences: {
          ...DEFAULT_PREFERENCES,
          ...preferences,
        },
        viewerSettings: {
          enabled: viewer.enabled === true,
          settings: viewer.settings ? validateViewerSettings(viewer.settings) : undefined,
        },
      }
    } catch {
      return undefined
    }
  }

  private async writeSecrets(secrets: Record<string, string>): Promise<void> {
    if (!this.protector.isAvailable()) return
    const encrypted = this.protector.encrypt(JSON.stringify(secrets))
    await atomicWrite(this.secretsPath, Buffer.from(encrypted))
  }

  private async readSecrets(): Promise<Record<string, string>> {
    if (!this.protector.isAvailable()) return {}
    try {
      const encrypted = await readFile(this.secretsPath)
      if (encrypted.byteLength > MAX_SETTINGS_BYTES) return {}
      const parsed = JSON.parse(this.protector.decrypt(encrypted)) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => (
        /^[\w.-]{1,256}$/.test(key) && typeof value === 'string' && value.length <= 64 * 1024
      ))) as Record<string, string>
    } catch {
      return {}
    }
  }

  private async injectSecrets(settings: DesktopMarkdownViewerSettings): Promise<DesktopMarkdownViewerSettings> {
    const secrets = await this.readSecrets()
    if (Object.keys(secrets).length === 0) return settings
    const globalSettings = { ...settings.globalSettings }
    const models = parseAiModels(globalSettings.aiModels).map((model) => {
      const id = modelIdentity(model)
      return id && secrets[id] ? { ...model, key: secrets[id] } : model
    })
    if (models.length > 0) globalSettings.aiModels = JSON.stringify(models)
    return { globalSettings, aiPreferences: { ...(settings.aiPreferences ?? {}) } }
  }
}

function validatePreferencePatch(value: unknown): DesktopMarkdownPreferencePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (record.editMode === 'wysiwyg' || record.editMode === 'ir') patch.editMode = record.editMode
  for (const key of ['editorTheme', 'codeMirrorTheme', 'mermaidTheme'] as const) {
    if (typeof record[key] === 'string' && record[key].length > 0 && record[key].length <= 64) patch[key] = record[key]
  }
  if (typeof record.workspacePathAsImageBasePath === 'boolean') patch.workspacePathAsImageBasePath = record.workspacePathAsImageBasePath
  if (typeof record.pasterImgPath === 'string' && record.pasterImgPath.length > 0 && record.pasterImgPath.length <= 1024 && !record.pasterImgPath.includes('\0')) {
    patch.pasterImgPath = record.pasterImgPath
  }
  if (Number.isInteger(record.pdfMarginTop) && (record.pdfMarginTop as number) >= 0 && (record.pdfMarginTop as number) <= 500) patch.pdfMarginTop = record.pdfMarginTop
  return patch as DesktopMarkdownPreferencePatch
}

function validateViewerSettings(value: unknown): DesktopMarkdownViewerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Markdown viewer settings must be an object.')
  const record = value as Record<string, unknown>
  const globalSettings = sanitizeJsonRecord(record.globalSettings, 0)
  const aiPreferences = sanitizeStringRecord(record.aiPreferences)
  const result = { globalSettings, aiPreferences }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_SETTINGS_BYTES) throw new RangeError('Markdown viewer settings exceed the 1 MB limit.')
  return result
}

function sanitizeJsonRecord(value: unknown, depth: number): Record<string, unknown> {
  if (depth > 8 || !value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[\w.-]{1,128}$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) continue
    if (typeof entry === 'string') result[key] = entry.slice(0, 256 * 1024)
    else if (typeof entry === 'number' && Number.isFinite(entry) || typeof entry === 'boolean' || entry === null) result[key] = entry
    else if (Array.isArray(entry)) result[key] = entry.slice(0, 1000).map((item) => sanitizeJsonValue(item, depth + 1))
    else if (entry && typeof entry === 'object') result[key] = sanitizeJsonRecord(entry, depth + 1)
  }
  return result
}

function sanitizeJsonValue(value: unknown, depth: number): unknown {
  if (depth > 8) return null
  if (typeof value === 'string') return value.slice(0, 256 * 1024)
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => sanitizeJsonValue(item, depth + 1))
  if (value && typeof value === 'object') return sanitizeJsonRecord(value, depth + 1)
  return null
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => (
    /^[\w.-]{1,128}$/.test(key) && typeof entry === 'string' && entry.length <= 64 * 1024
  ))) as Record<string, string>
}

function parseAiModels(value: unknown): Record<string, unknown>[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)).slice(0, 100)
      : []
  } catch {
    return []
  }
}

function modelIdentity(model: Record<string, unknown>): string | undefined {
  if (typeof model.id === 'string' && /^[\w.-]{1,256}$/.test(model.id)) return model.id
  if (typeof model.url === 'string' && model.url.length <= 2048) return model.url
  return undefined
}

function extractAiModelSecrets(settings: DesktopMarkdownViewerSettings): Record<string, string> {
  const result: Record<string, string> = {}
  for (const model of parseAiModels(settings.globalSettings.aiModels)) {
    const id = modelIdentity(model)
    if (id && typeof model.key === 'string' && model.key.length > 0 && model.key.length <= 64 * 1024) result[id] = model.key
  }
  return result
}

function stripAiModelSecrets(settings: DesktopMarkdownViewerSettings): DesktopMarkdownViewerSettings {
  const globalSettings = { ...settings.globalSettings }
  const models = parseAiModels(globalSettings.aiModels)
  if (models.length > 0) {
    globalSettings.aiModels = JSON.stringify(models.map(({ key: _key, ...model }) => model))
  }
  return { globalSettings, aiPreferences: { ...(settings.aiPreferences ?? {}) } }
}

async function atomicWrite(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  let temporaryCreated = false
  try {
    const handle = await open(temporary, 'wx')
    temporaryCreated = true
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    temporaryCreated = false
  } finally {
    if (temporaryCreated) await rm(temporary, { force: true }).catch(() => undefined)
  }
}
