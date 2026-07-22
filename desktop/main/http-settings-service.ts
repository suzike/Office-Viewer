import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DesktopHttpSettings } from '../shared/desktop-api'

const SETTINGS_FILE = 'http-settings.json'
const MAX_SETTINGS_BYTES = 1024 * 1024
const DEFAULT_ENVIRONMENTS = '{\n  "$shared": {},\n  "local": {}\n}'

const DEFAULT_SETTINGS: DesktopHttpSettings = {
  followRedirect: true,
  environmentSource: DEFAULT_ENVIRONMENTS,
  previewOption: 'body',
  previewColumn: 'beside',
  formParamEncodingStrategy: 'automatic',
  addRequestBodyLineIndentationAroundBrackets: true,
  decodeEscapedUnicodeCharacters: false,
  logLevel: 'error',
  enableCustomVariableReferencesCodeLens: true,
  timeoutSeconds: 30,
  allowPrivateNetwork: false,
  activeEnvironment: 'local',
}

interface SecretStorage {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface PersistedHttpSettings extends Omit<DesktopHttpSettings, 'environmentSource'> {
  readonly encryptedEnvironmentSource?: string
}

export class HttpSettingsService {
  private readonly settingsPath: string

  public constructor(directory: string, private readonly secretStorage: SecretStorage) {
    this.settingsPath = join(directory, SETTINGS_FILE)
  }

  public async load(): Promise<DesktopHttpSettings> {
    try {
      const bytes = await readFile(this.settingsPath)
      if (bytes.byteLength > MAX_SETTINGS_BYTES) throw new RangeError('HTTP settings exceed the 1 MB limit.')
      const value = JSON.parse(bytes.toString('utf8')) as PersistedHttpSettings
      let environmentSource = DEFAULT_ENVIRONMENTS
      if (typeof value.encryptedEnvironmentSource === 'string') {
        if (!this.secretStorage.isAvailable()) throw new Error('Encrypted HTTP environments are unavailable on this system.')
        environmentSource = this.secretStorage.decrypt(Buffer.from(value.encryptedEnvironmentSource, 'base64'))
      }
      return validateHttpSettings({ ...value, environmentSource })
    } catch (reason) {
      if (isMissingFile(reason)) return { ...DEFAULT_SETTINGS }
      throw reason
    }
  }

  public async save(value: unknown): Promise<DesktopHttpSettings> {
    const settings = validateHttpSettings(value)
    const { environmentSource, ...rest } = settings
    const payload: PersistedHttpSettings = this.secretStorage.isAvailable()
      ? { ...rest, encryptedEnvironmentSource: this.secretStorage.encrypt(environmentSource).toString('base64') }
      : rest
    const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    if (bytes.byteLength > MAX_SETTINGS_BYTES) throw new RangeError('HTTP settings exceed the 1 MB limit.')
    await atomicWrite(this.settingsPath, bytes)
    return settings
  }
}

export function validateHttpSettings(value: unknown): DesktopHttpSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('HTTP settings must be an object.')
  const source = value as Record<string, unknown>
  const environmentSource = requireString(source.environmentSource, 'environmentSource', 512 * 1024)
  const parsedEnvironment = JSON.parse(environmentSource) as unknown
  if (!parsedEnvironment || typeof parsedEnvironment !== 'object' || Array.isArray(parsedEnvironment)) {
    throw new TypeError('HTTP environmentSource must contain a JSON object.')
  }
  return {
    followRedirect: requireBoolean(source.followRedirect, 'followRedirect'),
    environmentSource,
    previewOption: requireEnum(source.previewOption, ['full', 'headers', 'body', 'exchange'], 'previewOption'),
    previewColumn: requireEnum(source.previewColumn, ['current', 'beside'], 'previewColumn'),
    formParamEncodingStrategy: requireEnum(source.formParamEncodingStrategy, ['automatic', 'never', 'always'], 'formParamEncodingStrategy'),
    addRequestBodyLineIndentationAroundBrackets: requireBoolean(source.addRequestBodyLineIndentationAroundBrackets, 'addRequestBodyLineIndentationAroundBrackets'),
    decodeEscapedUnicodeCharacters: requireBoolean(source.decodeEscapedUnicodeCharacters, 'decodeEscapedUnicodeCharacters'),
    logLevel: requireEnum(source.logLevel, ['error', 'warn', 'info', 'verbose'], 'logLevel'),
    enableCustomVariableReferencesCodeLens: requireBoolean(source.enableCustomVariableReferencesCodeLens, 'enableCustomVariableReferencesCodeLens'),
    timeoutSeconds: requireNumber(source.timeoutSeconds, 'timeoutSeconds', 1, 120),
    allowPrivateNetwork: requireBoolean(source.allowPrivateNetwork, 'allowPrivateNetwork'),
    activeEnvironment: requireString(source.activeEnvironment, 'activeEnvironment', 128),
  }
}

function requireString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) throw new TypeError(`HTTP setting ${name} is invalid.`)
  return value
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`HTTP setting ${name} is invalid.`)
  return value
}

function requireNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`HTTP setting ${name} is invalid.`)
  }
  return value
}

function requireEnum<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`HTTP setting ${name} is invalid.`)
  return value as T
}

function isMissingFile(reason: unknown): reason is NodeJS.ErrnoException {
  return reason instanceof Error && 'code' in reason && reason.code === 'ENOENT'
}

async function atomicWrite(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const file = await open(temporaryPath, 'wx', 0o600)
  try {
    await file.writeFile(data)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await rename(temporaryPath, path)
  } catch (reason) {
    await rm(temporaryPath, { force: true })
    throw reason
  }
}
