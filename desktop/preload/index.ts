import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  DesktopApi,
  DesktopArchiveExtractResult,
  DesktopArchiveInfo,
  DesktopFileChangedEvent,
  DesktopFilesOpenedEvent,
  DesktopImageCollection,
  DesktopHttpRequestOptions,
  DesktopHttpResponse,
  DesktopHttpSettings,
  DesktopMarkdownAiEvent,
  DesktopMarkdownAiOptions,
  DesktopMarkdownExportResult,
  DesktopMarkdownImageExportResult,
  DesktopMarkdownTextExportResult,
  DesktopMarkdownDeadLink,
  DesktopMarkdownTemplate,
  DesktopHtmlExportResult,
  DesktopMarkdownImageResult,
  DesktopMarkdownPreferencePatch,
  DesktopMarkdownPreferences,
  DesktopMarkdownViewerSettings,
  DesktopJavaDecompileResult,
  DesktopGitHistoryInit,
  DesktopGitHistoryResponse,
  DesktopGitHistoryChangedEvent,
  DesktopOpenDialogResult,
  DesktopPlatform,
  DesktopWriteResult,
  DesktopAiAssistantEvent,
  DesktopAiAssistantRequest,
  DesktopAiAssistantSettings,
  DesktopAiAssistantSettingsInput,
  DesktopAiDocumentContext,
  DesktopAiProviderStatus,
} from '../shared/desktop-api'

type IpcChannels = typeof import('../shared/ipc-channels').IPC_CHANNELS

// Sandboxed preload scripts cannot load arbitrary local modules at runtime. Keep this
// value local while checking its shape and literals against the shared contract.
const IPC_CHANNELS = {
  openFiles: 'office-desktop:files:open',
  openDroppedFiles: 'office-desktop:files:open-dropped',
  openPaths: 'office-desktop:files:open-paths',
  readFile: 'office-desktop:files:read',
  saveFile: 'office-desktop:files:save',
  saveFileAs: 'office-desktop:files:save-as',
  closeFile: 'office-desktop:files:close',
  openMarkdownLink: 'office-desktop:markdown:open-link',
  listSiblingImages: 'office-desktop:images:list-siblings',
  inspectArchive: 'office-desktop:archive:inspect',
  openArchiveEntry: 'office-desktop:archive:open-entry',
  extractArchive: 'office-desktop:archive:extract',
  addArchiveFile: 'office-desktop:archive:add-file',
  removeArchiveEntry: 'office-desktop:archive:remove-entry',
  decompileClass: 'office-desktop:java:decompile-class',
  selectGitRepositories: 'office-desktop:git:select-repositories',
  selectGitFileHistory: 'office-desktop:git:select-file-history',
  openGitFileHistory: 'office-desktop:git:open-file-history',
  gitHistoryRequest: 'office-desktop:git:request',
  sendHttpRequest: 'office-desktop:http:send',
  cancelHttpRequest: 'office-desktop:http:cancel',
  loadHttpSettings: 'office-desktop:http:settings:load',
  saveHttpSettings: 'office-desktop:http:settings:save',
  loadMarkdownPreferences: 'office-desktop:markdown:preferences:load',
  updateMarkdownPreferences: 'office-desktop:markdown:preferences:update',
  saveMarkdownViewerSettings: 'office-desktop:markdown:viewer-settings:save',
  saveMarkdownImage: 'office-desktop:markdown:image:save',
  pasteMarkdownImage: 'office-desktop:markdown:image:paste',
  selectMarkdownImage: 'office-desktop:markdown:image:select',
  exportMarkdown: 'office-desktop:markdown:export',
  printMarkdown: 'office-desktop:markdown:print',
  exportMarkdownImage: 'office-desktop:markdown:export-image',
  exportMarkdownText: 'office-desktop:markdown:export-text',
  markdownDropFileLinks: 'office-desktop:markdown:drop-file-links',
  scanMarkdownDeadLinks: 'office-desktop:markdown:dead-links:scan',
  loadMarkdownTemplates: 'office-desktop:markdown:templates:load',
  exportHtmlPdf: 'office-desktop:html:export-pdf',
  exportHtmlImage: 'office-desktop:html:export-image',
  startMarkdownAiPolish: 'office-desktop:markdown:ai:start',
  cancelMarkdownAiPolish: 'office-desktop:markdown:ai:cancel',
  loadAiAssistantSettings: 'office-desktop:assistant:settings:load',
  saveAiAssistantSettings: 'office-desktop:assistant:settings:save',
  probeAiAssistantProviders: 'office-desktop:assistant:providers:probe',
  getAiDocumentContext: 'office-desktop:assistant:context:get',
  startAiAssistantRequest: 'office-desktop:assistant:request:start',
  cancelAiAssistantRequest: 'office-desktop:assistant:request:cancel',
  showInFolder: 'office-desktop:files:show-in-folder',
  openWithSystem: 'office-desktop:files:open-with-system',
  openExternal: 'office-desktop:shell:open-external',
  toggleDevTools: 'office-desktop:window:toggle-devtools',
  windowMinimize: 'office-desktop:window:minimize',
  windowToggleMaximize: 'office-desktop:window:toggle-maximize',
  windowClose: 'office-desktop:window:close',
  filesOpened: 'office-desktop:event:files-opened',
  fileChanged: 'office-desktop:event:file-changed',
  gitHistoryChanged: 'office-desktop:event:git-history-changed',
  markdownAiEvent: 'office-desktop:event:markdown-ai',
  aiAssistantEvent: 'office-desktop:event:ai-assistant',
  aiAssistantFocus: 'office-desktop:event:assistant-focus',
  rendererReady: 'office-desktop:lifecycle:renderer-ready',
  dirtyState: 'office-desktop:lifecycle:dirty-state',
} as const satisfies IpcChannels

let rendererReadySent = false
const MAX_FILE_BYTES = 512 * 1024 * 1024

const officeDesktop: DesktopApi = {
  platform: process.platform as DesktopPlatform,
  windowMaterial: process.env.OFFICE_WINDOW_MATERIAL,

  openFiles: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openFiles) as Promise<DesktopOpenDialogResult>,

  openDroppedFiles: (files) => {
    if (!Array.isArray(files) || files.length === 0) {
      return Promise.reject(new TypeError('At least one dropped file is required.'))
    }

    const paths = files.map((file) => webUtils.getPathForFile(file))
    if (paths.some((path) => path.length === 0)) {
      return Promise.reject(new Error('One or more dropped files have no local path.'))
    }

    return ipcRenderer.invoke(
      IPC_CHANNELS.openDroppedFiles,
      paths,
    ) as Promise<DesktopOpenDialogResult>
  },

  openPaths: (paths) => {
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== 'string' || !path)) {
      return Promise.reject(new TypeError('At least one valid file path is required.'))
    }
    return ipcRenderer.invoke(
      IPC_CHANNELS.openPaths,
      [...paths],
    ) as Promise<DesktopOpenDialogResult>
  },

  readFile: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.readFile, sessionId) as Promise<ArrayBuffer>,

  saveFile: (sessionId, data) => {
    assertFilePayload(data)
    return ipcRenderer.invoke(
      IPC_CHANNELS.saveFile,
      sessionId,
      data,
    ) as Promise<DesktopWriteResult>
  },

  saveFileAs: (sessionId, data, suggestedName) => {
    assertFilePayload(data)
    return ipcRenderer.invoke(
      IPC_CHANNELS.saveFileAs,
      sessionId,
      data,
      suggestedName,
    ) as Promise<DesktopWriteResult | null>
  },

  closeFile: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeFile, sessionId) as Promise<void>,

  openMarkdownLink: (sessionId, link) =>
    ipcRenderer.invoke(IPC_CHANNELS.openMarkdownLink, sessionId, link) as Promise<import('../shared/desktop-api').DesktopFileSession | null>,

  listSiblingImages: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.listSiblingImages, sessionId) as Promise<DesktopImageCollection>,

  inspectArchive: (sessionId, encoding) =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectArchive, sessionId, encoding) as Promise<DesktopArchiveInfo>,

  openArchiveEntry: (sessionId, entryName, password) =>
    ipcRenderer.invoke(IPC_CHANNELS.openArchiveEntry, sessionId, entryName, password) as Promise<void>,

  extractArchive: (sessionId, password) =>
    ipcRenderer.invoke(IPC_CHANNELS.extractArchive, sessionId, password) as Promise<DesktopArchiveExtractResult | null>,

  addArchiveFile: (sessionId, currentDir, encoding) =>
    ipcRenderer.invoke(IPC_CHANNELS.addArchiveFile, sessionId, currentDir, encoding) as Promise<DesktopWriteResult | null>,

  removeArchiveEntry: (sessionId, entryName, encoding) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeArchiveEntry, sessionId, entryName, encoding) as Promise<DesktopWriteResult>,

  decompileClass: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.decompileClass, sessionId) as Promise<DesktopJavaDecompileResult>,

  selectGitRepositories: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectGitRepositories) as Promise<DesktopGitHistoryInit | null>,

  selectGitFileHistory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectGitFileHistory) as Promise<DesktopGitHistoryInit | null>,

  openGitFileHistory: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.openGitFileHistory, sessionId) as Promise<DesktopGitHistoryInit>,

  gitHistoryRequest: (type, content) => {
    if (typeof type !== 'string' || type.length === 0 || type.length > 64) {
      return Promise.reject(new TypeError('Invalid Git History request type.'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.gitHistoryRequest, type, content) as Promise<DesktopGitHistoryResponse>
  },

  sendHttpRequest: (sessionId, source, requestIndex, requestId, options) => {
    if (typeof source !== 'string' || source.length > 2 * 1024 * 1024) {
      return Promise.reject(new RangeError('HTTP document exceeds the 2 MB limit.'))
    }
    return ipcRenderer.invoke(
      IPC_CHANNELS.sendHttpRequest,
      sessionId,
      source,
      requestIndex,
      requestId,
      options,
    ) as Promise<DesktopHttpResponse>
  },

  cancelHttpRequest: (requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelHttpRequest, requestId) as Promise<boolean>,

  loadHttpSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.loadHttpSettings) as Promise<DesktopHttpSettings>,

  saveHttpSettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveHttpSettings, settings) as Promise<DesktopHttpSettings>,

  loadMarkdownPreferences: () =>
    ipcRenderer.invoke(IPC_CHANNELS.loadMarkdownPreferences) as Promise<DesktopMarkdownPreferences>,

  updateMarkdownPreferences: (patch: DesktopMarkdownPreferencePatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateMarkdownPreferences, patch) as Promise<DesktopMarkdownPreferences>,

  saveMarkdownViewerSettings: (settings: DesktopMarkdownViewerSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveMarkdownViewerSettings, settings) as Promise<DesktopMarkdownPreferences>,

  saveMarkdownImage: (sessionId, data, extension) => {
    assertFilePayload(data)
    return ipcRenderer.invoke(IPC_CHANNELS.saveMarkdownImage, sessionId, data, extension) as Promise<DesktopMarkdownImageResult>
  },

  pasteMarkdownImage: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.pasteMarkdownImage, sessionId) as Promise<DesktopMarkdownImageResult | null>,

  selectMarkdownImage: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectMarkdownImage, sessionId) as Promise<DesktopMarkdownImageResult | null>,

  exportMarkdown: (sessionId, markdown, option) => {
    if (typeof markdown !== 'string' || markdown.length > 8 * 1024 * 1024) {
      return Promise.reject(new RangeError('Markdown export input exceeds the 8 MB limit.'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.exportMarkdown, sessionId, markdown, option) as Promise<DesktopMarkdownExportResult>
  },

  printMarkdown: (sessionId, markdown) => {
    if (typeof markdown !== 'string' || markdown.length > 8 * 1024 * 1024) {
      return Promise.reject(new RangeError('Markdown print input exceeds the 8 MB limit.'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.printMarkdown, sessionId, markdown) as Promise<void>
  },

  exportMarkdownImage: (sessionId, markdown) => {
    if (typeof markdown !== 'string' || markdown.length > 8 * 1024 * 1024) {
      return Promise.reject(new RangeError('Markdown export input exceeds the 8 MB limit.'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.exportMarkdownImage, sessionId, markdown) as Promise<DesktopMarkdownImageExportResult>
  },

  exportMarkdownText: (sessionId, markdown) => {
    if (typeof markdown !== 'string' || markdown.length > 8 * 1024 * 1024) {
      return Promise.reject(new RangeError('Markdown export input exceeds the 8 MB limit.'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.exportMarkdownText, sessionId, markdown) as Promise<DesktopMarkdownTextExportResult>
  },

  markdownDropFileLinks: (sessionId, files) => {
    if (!Array.isArray(files) || files.length === 0 || files.length > 32) {
      return Promise.reject(new TypeError('Between 1 and 32 dropped files are required.'))
    }
    const paths = files.map((file) => webUtils.getPathForFile(file))
    if (paths.some((path) => path.length === 0)) {
      return Promise.reject(new Error('One or more dropped files have no local path.'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.markdownDropFileLinks, sessionId, paths) as Promise<string>
  },

  scanMarkdownDeadLinks: (sessionId, markdown) => {
    if (typeof markdown !== 'string' || markdown.length > 8 * 1024 * 1024) {
      return Promise.reject(new RangeError('Markdown scan input exceeds the 8 MB limit.'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.scanMarkdownDeadLinks, sessionId, markdown) as Promise<readonly DesktopMarkdownDeadLink[]>
  },

  loadMarkdownTemplates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.loadMarkdownTemplates) as Promise<readonly DesktopMarkdownTemplate[]>,

  exportHtmlPdf: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportHtmlPdf, sessionId) as Promise<DesktopHtmlExportResult>,

  exportHtmlImage: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportHtmlImage, sessionId) as Promise<DesktopHtmlExportResult>,

  startMarkdownAiPolish: (sessionId, requestId, markdown, options?: DesktopMarkdownAiOptions) => {
    if (typeof markdown !== 'string' || markdown.length > 2 * 1024 * 1024) {
      return Promise.reject(new RangeError('Markdown AI input exceeds the 2 MB limit.'))
    }
    return ipcRenderer.invoke(IPC_CHANNELS.startMarkdownAiPolish, sessionId, requestId, markdown, options) as Promise<void>
  },

  cancelMarkdownAiPolish: (requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelMarkdownAiPolish, requestId) as Promise<boolean>,

  loadAiAssistantSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.loadAiAssistantSettings) as Promise<DesktopAiAssistantSettings>,

  saveAiAssistantSettings: (settings: DesktopAiAssistantSettingsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveAiAssistantSettings, settings) as Promise<DesktopAiAssistantSettings>,

  probeAiAssistantProviders: (forceRefresh = false) =>
    ipcRenderer.invoke(IPC_CHANNELS.probeAiAssistantProviders, forceRefresh === true) as Promise<readonly DesktopAiProviderStatus[]>,

  getAiDocumentContext: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getAiDocumentContext, sessionId) as Promise<DesktopAiDocumentContext>,

  startAiAssistantRequest: (request: DesktopAiAssistantRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.startAiAssistantRequest, request) as Promise<void>,

  cancelAiAssistantRequest: (requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelAiAssistantRequest, requestId) as Promise<boolean>,

  showInFolder: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.showInFolder, sessionId) as Promise<void>,

  openWithSystem: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.openWithSystem, sessionId) as Promise<void>,

  openExternal: (url) =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternal, url) as Promise<void>,

  toggleDevTools: () =>
    ipcRenderer.invoke(IPC_CHANNELS.toggleDevTools) as Promise<boolean>,

  windowMinimize: () =>
    ipcRenderer.invoke(IPC_CHANNELS.windowMinimize) as Promise<void>,

  windowToggleMaximize: () =>
    ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize) as Promise<boolean>,

  windowClose: () =>
    ipcRenderer.invoke(IPC_CHANNELS.windowClose) as Promise<void>,

  setDirtyState: (dirty) => {
    if (typeof dirty !== 'boolean') {
      throw new TypeError('Dirty state must be a boolean.')
    }
    ipcRenderer.send(IPC_CHANNELS.dirtyState, dirty)
  },

  onFilesOpened: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopFilesOpenedEvent) => {
      listener(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.filesOpened, wrapped)
    announceRendererReady()
    return () => ipcRenderer.removeListener(IPC_CHANNELS.filesOpened, wrapped)
  },

  onFileChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopFileChangedEvent) => {
      listener(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.fileChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.fileChanged, wrapped)
  },

  onGitHistoryChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopGitHistoryChangedEvent) => {
      listener(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.gitHistoryChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.gitHistoryChanged, wrapped)
  },

  onMarkdownAiEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopMarkdownAiEvent) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.markdownAiEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.markdownAiEvent, wrapped)
  },

  onAiAssistantEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopAiAssistantEvent) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.aiAssistantEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.aiAssistantEvent, wrapped)
  },

  onAiAssistantFocus: (listener) => {
    const wrapped = () => listener()
    ipcRenderer.on(IPC_CHANNELS.aiAssistantFocus, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.aiAssistantFocus, wrapped)
  },

}

contextBridge.exposeInMainWorld('officeDesktop', Object.freeze(officeDesktop))

function announceRendererReady(): void {
  if (rendererReadySent) {
    return
  }
  rendererReadySent = true
  ipcRenderer.send(IPC_CHANNELS.rendererReady)
}

function assertFilePayload(data: ArrayBuffer | Uint8Array): void {
  if (
    !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) ||
    data.byteLength > MAX_FILE_BYTES
  ) {
    throw new RangeError(`Document payload exceeds the ${MAX_FILE_BYTES} byte limit.`)
  }
}
