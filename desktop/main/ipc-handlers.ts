import { basename, isAbsolute } from 'node:path'
import { join, parse } from 'node:path'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  safeStorage,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import type {
  DesktopFilesOpenedEvent,
  DesktopOpenDialogResult,
} from '../shared/desktop-api'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { FileSessionManager } from './file-session-manager'
import { JavaDecompilerService } from './java-decompiler-service'
import { GitHistoryService } from './git-history-service'
import { DesktopHttpService } from './http-service'
import { HttpSettingsService } from './http-settings-service'
import { MarkdownAiService } from './markdown-ai-service'
import { MarkdownExportService } from './markdown-export-service'
import { saveMarkdownImage } from './markdown-image-service'
import { MarkdownSettingsService } from './markdown-settings-service'
import { AiAssistantSettingsService } from './ai-assistant-settings-service'
import { AiDocumentContextService } from './ai-document-context-service'
import { AiAssistantService } from './ai-assistant-service'
import {
  extractZipArchive,
  inspectZipArchive,
  readArchiveAddSource,
  readZipArchiveEntry,
  rewriteZipArchive,
  supportsZipArchive,
} from './archive-service'
import {
  extractNonZipArchive,
  inspectNonZipArchive,
  readNonZipArchiveEntry,
  supportsNonZipArchive,
} from './nonzip-archive-service'

const MAX_DROPPED_FILES = 100
const MAX_EXTERNAL_URL_LENGTH = 2_048
const MAX_FILE_BYTES = 512 * 1024 * 1024

const OPEN_FILE_FILTERS = [
  {
    name: 'Supported documents',
    extensions: [
      'docx', 'dotx', 'xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv',
      'pptx', 'pptm', 'pdf', 'md', 'markdown', 'html', 'htm', 'xhtml',
      'http', 'rest',
      'yaml', 'yml', 'xml', 'xsd', 'xsl', 'xslt', 'conf', 'nginx',
      'kt', 'kts', 'reg', 'toml', 'csl', 'kql', 'kusto', 'txt', 'text', 'log',
      'epub', 'xmind', 'parquet', 'zip', '7z', 'rar', 'tar', 'tgz',
      'gz', 'jar', 'apk', 'vsix', 'crx', 'jpg', 'jpeg', 'png', 'gif',
      'apng', 'bmp', 'ico', 'cur', 'webp', 'svg', 'psd', 'tif', 'tiff',
      'heif', 'heic', 'ttf', 'woff', 'woff2', 'otf', 'class',
    ],
  },
  { name: 'All files', extensions: ['*'] },
]

interface RegisterIpcHandlersOptions {
  readonly getWindow: () => BrowserWindow | null
  readonly sessions: FileSessionManager
  readonly isTrustedSender: (event: IpcMainInvokeEvent | IpcMainEvent) => boolean
  readonly publishFilesOpened: (event: DesktopFilesOpenedEvent) => void
  readonly markRendererReady: () => void
  readonly setRendererDirtyState: (dirty: boolean) => void
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): () => void {
  const {
    getWindow,
    sessions,
    isTrustedSender,
    publishFilesOpened,
    markRendererReady,
    setRendererDirtyState,
  } = options
  const javaDecompiler = new JavaDecompilerService(resolveJavaDecompilerJarPath())
  const gitHistory = new GitHistoryService((repos) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.gitHistoryChanged, { repos })
    }
  })
  const httpService = new DesktopHttpService((sessionId) => sessions.getPath(sessionId))
  const httpSettings = new HttpSettingsService(app.getPath('userData'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  })
  const markdownSettings = new MarkdownSettingsService(app.getPath('userData'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value)),
  })
  const markdownExport = new MarkdownExportService(resolveApplicationRoot())
  const markdownAi = new MarkdownAiService()
  const aiAssistantSettings = new AiAssistantSettingsService(app.getPath('userData'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value)),
  })
  const aiDocumentContext = new AiDocumentContextService(sessions)
  const aiAssistant = new AiAssistantService(
    aiAssistantSettings,
    aiDocumentContext,
    join(app.getPath('userData'), 'ai-sandbox'),
  )
  const archiveEncodingBySession = new Map<string, string>()

  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event, isTrustedSender)
      return listener(event, ...args)
    })
  }

  handle(IPC_CHANNELS.openFiles, async () => {
    const window = requireWindow(getWindow)
    const result = await dialog.showOpenDialog(window, {
      title: 'Open document',
      properties: ['openFile', 'multiSelections'],
      filters: OPEN_FILE_FILTERS,
    })

    if (result.canceled) {
      return { canceled: true, files: [] } satisfies DesktopOpenDialogResult
    }

    const files = await sessions.registerPaths(result.filePaths)
    publishFilesOpened({ reason: 'dialog', files })
    return { canceled: false, files } satisfies DesktopOpenDialogResult
  })

  handle(IPC_CHANNELS.openDroppedFiles, async (_event, rawPaths) => {
    const paths = validateDroppedPaths(rawPaths)
    const files = await sessions.registerPaths(paths)
    publishFilesOpened({ reason: 'drop', files })
    return { canceled: false, files } satisfies DesktopOpenDialogResult
  })

  handle(IPC_CHANNELS.readFile, (_event, sessionId) =>
    sessions.read(requireSessionId(sessionId)))

  handle(IPC_CHANNELS.saveFile, (_event, sessionId, data) =>
    sessions.write(requireSessionId(sessionId), requireFileData(data)))

  handle(IPC_CHANNELS.saveFileAs, async (_event, sessionId, data, suggestedName) => {
    const window = requireWindow(getWindow)
    const sourcePath = sessionId === null
      ? undefined
      : sessions.getPath(requireSessionId(sessionId))
    const defaultName = sanitizeSuggestedName(suggestedName, sourcePath)
    const result = await dialog.showSaveDialog(window, {
      title: 'Save document as',
      defaultPath: defaultName,
    })

    if (result.canceled || !result.filePath) {
      return null
    }

    return sessions.writeAs(result.filePath, requireFileData(data))
  })

  handle(IPC_CHANNELS.closeFile, (_event, sessionId) => {
    sessions.suspend(requireSessionId(sessionId))
  })

  handle(IPC_CHANNELS.openMarkdownLink, async (_event, sessionId, link) => {
    const session = await sessions.resolveMarkdownLink(
      requireSessionId(sessionId),
      requireMarkdownLink(link),
    )
    if (session) {
      publishFilesOpened({ reason: 'open-file', files: [session] })
    }
    return session
  })

  handle(IPC_CHANNELS.listSiblingImages, (_event, sessionId) =>
    sessions.listSiblingImages(requireSessionId(sessionId)))

  handle(IPC_CHANNELS.inspectArchive, async (_event, sessionId, encoding) => {
    const id = requireSessionId(sessionId)
    const sourcePath = sessions.getPath(id)
    requireArchivePath(sourcePath)
    const requestedEncoding = requireEncoding(encoding)
    archiveEncodingBySession.set(id, requestedEncoding)
    const data = await sessions.read(id)
    return supportsZipArchive(sourcePath)
      ? inspectZipArchive(data, sourcePath, requestedEncoding)
      : inspectNonZipArchive(data, sourcePath, requestedEncoding)
  })

  handle(IPC_CHANNELS.openArchiveEntry, async (_event, sessionId, entryName, password) => {
    const id = requireSessionId(sessionId)
    const sourcePath = sessions.getPath(id)
    requireArchivePath(sourcePath)
    const name = requireArchiveEntryName(entryName)
    const data = await sessions.read(id)
    const archivePassword = requirePassword(password)
    const contents = supportsZipArchive(sourcePath)
      ? await readZipArchiveEntry(data, name, archivePassword)
      : await readNonZipArchiveEntry(data, sourcePath, name, archivePassword, archiveEncodingBySession.get(id))
    const previewDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-archive-entry-'))
    const target = join(previewDirectory, sanitizeSuggestedName(basename(name)))
    await writeFile(target, contents, { flag: 'wx' })
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  handle(IPC_CHANNELS.extractArchive, async (_event, sessionId, password) => {
    const id = requireSessionId(sessionId)
    const sourcePath = sessions.getPath(id)
    requireArchivePath(sourcePath)
    const window = requireWindow(getWindow)
    const result = await dialog.showOpenDialog(window, {
      title: 'Extract archive to folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const archiveName = sanitizeSuggestedName(parse(sourcePath).name)
    const target = join(result.filePaths[0], archiveName)
    await mkdir(target, { recursive: false })
    const data = await sessions.read(id)
    const archivePassword = requirePassword(password)
    const extracted = supportsZipArchive(sourcePath)
      ? await extractZipArchive(data, target, archivePassword)
      : await extractNonZipArchive(data, sourcePath, target, archivePassword, archiveEncodingBySession.get(id))
    shell.showItemInFolder(extracted.targetPath)
    return extracted
  })

  handle(IPC_CHANNELS.addArchiveFile, async (_event, sessionId, currentDir, encoding) => {
    const id = requireSessionId(sessionId)
    const sourcePath = sessions.getPath(id)
    requireZipArchivePath(sourcePath)
    if (sourcePath.toLowerCase().endsWith('.crx')) throw new Error('CRX archives cannot be edited safely.')
    const result = await dialog.showOpenDialog(requireWindow(getWindow), {
      title: 'Add file to archive',
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const prefix = requireArchiveDirectory(currentDir)
    const entryName = prefix ? `${prefix}/${basename(result.filePaths[0])}` : basename(result.filePaths[0])
    const contents = await readArchiveAddSource(result.filePaths[0])
    const rewritten = await rewriteZipArchive(await sessions.read(id), {
      add: { entryName, contents },
      encoding: requireEncoding(encoding),
    })
    return sessions.write(id, rewritten)
  })

  handle(IPC_CHANNELS.removeArchiveEntry, async (_event, sessionId, entryName, encoding) => {
    const id = requireSessionId(sessionId)
    const sourcePath = sessions.getPath(id)
    requireZipArchivePath(sourcePath)
    if (sourcePath.toLowerCase().endsWith('.crx')) throw new Error('CRX archives cannot be edited safely.')
    const rewritten = await rewriteZipArchive(await sessions.read(id), {
      exclude: requireArchiveEntryName(entryName),
      encoding: requireEncoding(encoding),
    })
    return sessions.write(id, rewritten)
  })

  handle(IPC_CHANNELS.decompileClass, (_event, sessionId) => {
    const classPath = sessions.getPath(requireSessionId(sessionId))
    return javaDecompiler.decompile(classPath)
  })

  handle(IPC_CHANNELS.selectGitRepositories, () =>
    gitHistory.selectRepositories(requireWindow(getWindow)))

  handle(IPC_CHANNELS.selectGitFileHistory, () =>
    gitHistory.selectFileHistory(requireWindow(getWindow)))

  handle(IPC_CHANNELS.openGitFileHistory, (_event, sessionId) =>
    gitHistory.openFileHistory(sessions.getPath(requireSessionId(sessionId))))

  handle(IPC_CHANNELS.gitHistoryRequest, (_event, type, content) =>
    gitHistory.request(requireWindow(getWindow), type, content))

  handle(IPC_CHANNELS.sendHttpRequest, (_event, sessionId, source, requestIndex, requestId, requestOptions) =>
    httpService.send(
      requireSessionId(sessionId),
      requireHttpDocument(source),
      requireHttpRequestIndex(requestIndex),
      requireHttpRequestId(requestId),
      requireHttpRequestOptions(requestOptions),
    ))

  handle(IPC_CHANNELS.cancelHttpRequest, (_event, requestId) =>
    httpService.cancel(requireHttpRequestId(requestId)))

  handle(IPC_CHANNELS.loadHttpSettings, () => httpSettings.load())

  handle(IPC_CHANNELS.saveHttpSettings, (_event, settings) => httpSettings.save(settings))

  handle(IPC_CHANNELS.loadMarkdownPreferences, () => markdownSettings.load())

  handle(IPC_CHANNELS.updateMarkdownPreferences, (_event, patch) =>
    markdownSettings.update(requireObject(patch, 'Markdown preference patch')))

  handle(IPC_CHANNELS.saveMarkdownViewerSettings, (_event, settings) =>
    markdownSettings.saveViewerSettings(requireObject(settings, 'Markdown viewer settings') as unknown as import('../shared/desktop-api').DesktopMarkdownViewerSettings))

  handle(IPC_CHANNELS.saveMarkdownImage, async (_event, sessionId, data, extension) => {
    const path = requireMarkdownPath(sessions.getPath(requireSessionId(sessionId)))
    return saveMarkdownImage(path, requireFileData(data), requireImageExtension(extension), await markdownSettings.load())
  })

  handle(IPC_CHANNELS.pasteMarkdownImage, async (_event, sessionId) => {
    const path = requireMarkdownPath(sessions.getPath(requireSessionId(sessionId)))
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    return saveMarkdownImage(path, image.toPNG(), 'png', await markdownSettings.load())
  })

  handle(IPC_CHANNELS.selectMarkdownImage, async (_event, sessionId) => {
    const path = requireMarkdownPath(sessions.getPath(requireSessionId(sessionId)))
    const selected = await dialog.showOpenDialog(requireWindow(getWindow), {
      title: 'Select image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'] }],
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    const source = selected.filePaths[0]
    const data = await readFile(source)
    return saveMarkdownImage(path, data, parse(source).ext, await markdownSettings.load())
  })

  handle(IPC_CHANNELS.exportMarkdown, async (_event, sessionId, markdown, option) => {
    const path = requireMarkdownPath(sessions.getPath(requireSessionId(sessionId)))
    const result = await markdownExport.export(path, requireMarkdownExportText(markdown), requireMarkdownExportOption(option), await markdownSettings.load())
    shell.showItemInFolder(result.path)
    return result
  })

  handle(IPC_CHANNELS.startMarkdownAiPolish, async (_event, sessionId, requestId, markdown, aiOptions) => {
    const id = requireSessionId(sessionId)
    requireMarkdownPath(sessions.getPath(id))
    const aiRequestId = requireMarkdownAiRequestId(requestId)
    const window = requireWindow(getWindow)
    try {
      await markdownAi.stream(
        aiRequestId,
        requireMarkdownAiText(markdown),
        requireObject(aiOptions ?? {}, 'Markdown AI options') as import('../shared/desktop-api').DesktopMarkdownAiOptions,
        (content) => window.webContents.send(IPC_CHANNELS.markdownAiEvent, { sessionId: id, requestId: aiRequestId, type: 'chunk', content }),
      )
      window.webContents.send(IPC_CHANNELS.markdownAiEvent, { sessionId: id, requestId: aiRequestId, type: 'end' })
    } catch (reason) {
      if ((reason as { name?: string })?.name === 'AbortError') return
      const content = reason instanceof Error ? reason.message : String(reason)
      window.webContents.send(IPC_CHANNELS.markdownAiEvent, { sessionId: id, requestId: aiRequestId, type: 'error', content })
      throw reason
    }
  })

  handle(IPC_CHANNELS.cancelMarkdownAiPolish, (_event, requestId) =>
    markdownAi.cancel(requireMarkdownAiRequestId(requestId)))

  handle(IPC_CHANNELS.loadAiAssistantSettings, () => aiAssistantSettings.load())

  handle(IPC_CHANNELS.saveAiAssistantSettings, async (_event, settings) => {
    const saved = await aiAssistantSettings.save(requireObject(settings, 'AI assistant settings') as unknown as import('../shared/desktop-api').DesktopAiAssistantSettingsInput)
    aiAssistant.invalidateProviderProbe()
    return saved
  })

  handle(IPC_CHANNELS.probeAiAssistantProviders, (_event, forceRefresh) =>
    aiAssistant.probeProviders(forceRefresh === true))

  handle(IPC_CHANNELS.getAiDocumentContext, async (_event, sessionId) => {
    const settings = await aiAssistantSettings.load()
    return aiDocumentContext.extract(requireSessionId(sessionId), settings.contextCharacterLimit)
  })

  handle(IPC_CHANNELS.startAiAssistantRequest, async (_event, rawRequest) => {
    const request = requireObject(rawRequest, 'AI assistant request') as unknown as import('../shared/desktop-api').DesktopAiAssistantRequest
    const window = requireWindow(getWindow)
    const eventBase = { requestId: request.requestId, sessionId: request.sessionId }
    window.webContents.send(IPC_CHANNELS.aiAssistantEvent, { ...eventBase, type: 'start' })
    try {
      await aiAssistant.stream(request, (payload) => {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.aiAssistantEvent, payload)
      })
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.aiAssistantEvent, { ...eventBase, type: 'end' })
    } catch (reason) {
      if ((reason as { name?: string })?.name === 'AbortError') return
      const content = reason instanceof Error ? reason.message : String(reason)
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.aiAssistantEvent, { ...eventBase, type: 'error', content })
      throw reason
    }
  })

  handle(IPC_CHANNELS.cancelAiAssistantRequest, (_event, requestId) =>
    aiAssistant.cancel(requireMarkdownAiRequestId(requestId)))

  handle(IPC_CHANNELS.showInFolder, (_event, sessionId) => {
    shell.showItemInFolder(sessions.getPath(requireSessionId(sessionId)))
  })

  handle(IPC_CHANNELS.openWithSystem, async (_event, sessionId) => {
    const error = await shell.openPath(sessions.getPath(requireSessionId(sessionId)))
    if (error) throw new Error(error)
  })

  handle(IPC_CHANNELS.openExternal, async (_event, rawUrl) => {
    const url = validateExternalUrl(rawUrl)
    await shell.openExternal(url.href, { activate: true })
  })

  handle(IPC_CHANNELS.toggleDevTools, () => {
    if (app.isPackaged) {
      return false
    }

    const window = requireWindow(getWindow)
    window.webContents.toggleDevTools()
    return true
  })

  const onRendererReady = (event: IpcMainEvent) => {
    assertTrustedSender(event, isTrustedSender)
    markRendererReady()
  }
  ipcMain.on(IPC_CHANNELS.rendererReady, onRendererReady)

  const onDirtyState = (event: IpcMainEvent, dirty: unknown) => {
    assertTrustedSender(event, isTrustedSender)
    if (typeof dirty !== 'boolean') {
      throw new TypeError('Dirty state must be a boolean.')
    }
    setRendererDirtyState(dirty)
  }
  ipcMain.on(IPC_CHANNELS.dirtyState, onDirtyState)

  return () => {
    gitHistory.dispose()
    aiAssistant.dispose()
    for (const channel of [
      IPC_CHANNELS.openFiles,
      IPC_CHANNELS.openDroppedFiles,
      IPC_CHANNELS.readFile,
      IPC_CHANNELS.saveFile,
      IPC_CHANNELS.saveFileAs,
      IPC_CHANNELS.closeFile,
      IPC_CHANNELS.openMarkdownLink,
      IPC_CHANNELS.listSiblingImages,
      IPC_CHANNELS.inspectArchive,
      IPC_CHANNELS.openArchiveEntry,
      IPC_CHANNELS.extractArchive,
      IPC_CHANNELS.addArchiveFile,
      IPC_CHANNELS.removeArchiveEntry,
      IPC_CHANNELS.decompileClass,
      IPC_CHANNELS.selectGitRepositories,
      IPC_CHANNELS.selectGitFileHistory,
      IPC_CHANNELS.openGitFileHistory,
      IPC_CHANNELS.gitHistoryRequest,
      IPC_CHANNELS.sendHttpRequest,
      IPC_CHANNELS.cancelHttpRequest,
      IPC_CHANNELS.loadHttpSettings,
      IPC_CHANNELS.saveHttpSettings,
      IPC_CHANNELS.loadMarkdownPreferences,
      IPC_CHANNELS.updateMarkdownPreferences,
      IPC_CHANNELS.saveMarkdownViewerSettings,
      IPC_CHANNELS.saveMarkdownImage,
      IPC_CHANNELS.pasteMarkdownImage,
      IPC_CHANNELS.selectMarkdownImage,
      IPC_CHANNELS.exportMarkdown,
      IPC_CHANNELS.startMarkdownAiPolish,
      IPC_CHANNELS.cancelMarkdownAiPolish,
      IPC_CHANNELS.loadAiAssistantSettings,
      IPC_CHANNELS.saveAiAssistantSettings,
      IPC_CHANNELS.probeAiAssistantProviders,
      IPC_CHANNELS.getAiDocumentContext,
      IPC_CHANNELS.startAiAssistantRequest,
      IPC_CHANNELS.cancelAiAssistantRequest,
      IPC_CHANNELS.showInFolder,
      IPC_CHANNELS.openWithSystem,
      IPC_CHANNELS.openExternal,
      IPC_CHANNELS.toggleDevTools,
    ]) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.removeListener(IPC_CHANNELS.rendererReady, onRendererReady)
    ipcMain.removeListener(IPC_CHANNELS.dirtyState, onDirtyState)
  }
}

function resolveJavaDecompilerJarPath(): string {
  if (!app.isPackaged) {
    return join(__dirname, '..', '..', '..', 'resource', 'java-decompiler.jar')
  }
  const applicationPath = app.getAppPath()
  const unpackedApplicationPath = app.isPackaged && applicationPath.toLowerCase().endsWith('app.asar')
    ? `${applicationPath.slice(0, -'app.asar'.length)}app.asar.unpacked`
    : applicationPath
  return join(unpackedApplicationPath, 'resource', 'java-decompiler.jar')
}

function resolveApplicationRoot(): string {
  return app.isPackaged ? app.getAppPath() : join(__dirname, '..', '..', '..')
}

function assertTrustedSender(
  event: IpcMainInvokeEvent | IpcMainEvent,
  isTrustedSender: RegisterIpcHandlersOptions['isTrustedSender'],
): void {
  if (!isTrustedSender(event)) {
    throw new Error('Rejected IPC request from an untrusted renderer.')
  }
}

function requireWindow(getWindow: () => BrowserWindow | null): BrowserWindow {
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    throw new Error('The desktop window is not available.')
  }
  return window
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new TypeError('A valid file session id is required.')
  }
  return value
}

function requireFileData(value: unknown): ArrayBuffer | Uint8Array {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const data = value as ArrayBuffer | Uint8Array
    if (data.byteLength > MAX_FILE_BYTES) {
      throw new RangeError(`Document payload exceeds the ${MAX_FILE_BYTES} byte limit.`)
    }
    return data
  }
  throw new TypeError('File contents must be an ArrayBuffer or Uint8Array.')
}

function requireMarkdownLink(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) {
    throw new TypeError('A valid Markdown link is required.')
  }
  return value
}

function requireMarkdownPath(value: string): string {
  if (!/\.(?:md|markdown)$/i.test(value)) throw new Error('A Markdown document session is required.')
  return value
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function requireImageExtension(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !/^\.?[a-z\d]{1,10}$/i.test(value)) throw new TypeError('A valid image extension is required.')
  return value
}

function requireMarkdownExportText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8 * 1024 * 1024) throw new RangeError('Markdown export input exceeds the 8 MB limit.')
  return value
}

function requireMarkdownExportOption(value: unknown): { type: 'pdf' | 'html' | 'docx'; withoutOutline?: boolean } {
  const record = requireObject(value, 'Markdown export option')
  if (record.type !== 'pdf' && record.type !== 'html' && record.type !== 'docx') throw new Error('Unsupported Markdown export type.')
  if (record.withoutOutline !== undefined && typeof record.withoutOutline !== 'boolean') throw new TypeError('Markdown outline option must be a boolean.')
  return { type: record.type, withoutOutline: record.withoutOutline as boolean | undefined }
}

function requireMarkdownAiRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{8,128}$/.test(value)) throw new TypeError('A valid Markdown AI request id is required.')
  return value
}

function requireMarkdownAiText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2 * 1024 * 1024) throw new RangeError('Markdown AI input must contain between 1 character and 2 MB.')
  return value
}

function requireHttpDocument(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) {
    throw new RangeError('HTTP document exceeds the 2 MB limit.')
  }
  return value
}

function requireHttpRequestIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new TypeError('A valid HTTP request block index is required.')
  }
  return value as number
}

function requireHttpRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{8,128}$/.test(value)) {
    throw new TypeError('A valid HTTP request id is required.')
  }
  return value
}

function requireHttpRequestOptions(value: unknown): import('../shared/desktop-api').DesktopHttpRequestOptions {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('HTTP request options must be an object.')
  }
  return value as import('../shared/desktop-api').DesktopHttpRequestOptions
}

function validateDroppedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DROPPED_FILES) {
    throw new TypeError(`Between 1 and ${MAX_DROPPED_FILES} dropped files are required.`)
  }

  return value.map((path) => {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.includes('\0') ||
      !isAbsolute(path)
    ) {
      throw new TypeError('Dropped files must resolve to absolute local paths.')
    }
    return path
  })
}

function validateExternalUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new TypeError('A valid external URL is required.')
  }

  const url = new URL(value)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('Only credential-free HTTP(S) links can be opened externally.')
  }

  return url
}

function sanitizeSuggestedName(value: unknown, sourcePath?: string): string {
  const candidate = typeof value === 'string' && value.length > 0
    ? value
    : sourcePath
      ? basename(sourcePath)
      : 'Untitled'

  const safeName = basename(candidate)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 240)

  return safeName || 'Untitled'
}

function requireZipArchivePath(value: string): void {
  if (!supportsZipArchive(value)) throw new Error('This archive format is not implemented by the desktop ZIP backend.')
}

function requireArchivePath(value: string): void {
  if (!supportsZipArchive(value) && !supportsNonZipArchive(value)) {
    throw new Error('This archive format is not implemented by the desktop archive backend.')
  }
}

function requireArchiveEntryName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || value.includes('\0')) {
    throw new TypeError('A valid archive entry name is required.')
  }
  return value
}

function requireArchiveDirectory(value: unknown): string {
  if (value === undefined || value === '') return ''
  return requireArchiveEntryName(value)
}

function requireEncoding(value: unknown): string {
  if (value === undefined || value === '') return 'utf8'
  if (typeof value !== 'string' || value.length > 32 || !/^[a-z\d._-]+$/i.test(value)) {
    throw new TypeError('A valid archive filename encoding is required.')
  }
  return value
}

function requirePassword(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 1_024 || value.includes('\0')) {
    throw new TypeError('A valid archive password is required.')
  }
  return value
}
