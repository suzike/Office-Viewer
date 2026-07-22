import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  net,
  protocol,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import type {
  DesktopFileSession,
  DesktopFilesOpenedEvent,
  DesktopOpenReason,
} from '../shared/desktop-api'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { FileSessionManager } from './file-session-manager'
import { registerIpcHandlers } from './ipc-handlers'
import { resolveMarkdownWorkspaceResource } from './markdown-resource-service'

const APP_USER_MODEL_ID = 'com.officeviewer.desktop'
const MAX_PENDING_OPEN_EVENTS = 100
const PDF_VIEWER_SCHEME = 'office-pdf'
const HTML_VIEWER_SCHEME = 'office-html'
const MARKDOWN_VIEWER_SCHEME = 'office-markdown'
const FONT_DECODER_SCHEME = 'office-font'
const IMAGE_DECODER_SCHEME = 'office-image'

protocol.registerSchemesAsPrivileged([
  {
    scheme: PDF_VIEWER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: HTML_VIEWER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: MARKDOWN_VIEWER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: FONT_DECODER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: IMAGE_DECODER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

const sessions = new FileSessionManager()
const pendingOpenEvents: DesktopFilesOpenedEvent[] = []
const pendingOpenFilePaths: string[] = []
const rendererDirectory = resolve(__dirname, '../../desktop-renderer')
const runtimeEntryPath = resolve(__dirname, 'index.js')
const developmentUrl = getDevelopmentUrl()

let mainWindow: BrowserWindow | null = null
let rendererReady = false
let rendererDirty = false
let forceWindowClose = false
let removeIpcHandlers: (() => void) | undefined

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  configureApplicationLifecycle()
}

function configureApplicationLifecycle(): void {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    focusMainWindow()
    void openCommandLineFiles(commandLine, workingDirectory, 'second-instance')
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (app.isReady()) {
      void openPaths([path], 'open-file')
    } else {
      pendingOpenFilePaths.push(path)
    }
  })

  app.on('before-quit', () => {
    removeIpcHandlers?.()
    removeIpcHandlers = undefined
    sessions.dispose()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('activate', () => {
    if (!mainWindow) {
      createMainWindow()
    }
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID)
    configurePdfViewerProtocol()
    configureHtmlViewerProtocol()
    configureMarkdownViewerProtocol()
    configureFontDecoderProtocol()
    configureImageDecoderProtocol()
    configureIpc()
    createMainWindow()

    const initialArguments = process.argv.slice(app.isPackaged ? 1 : 2)
    await openCommandLineFiles(initialArguments, process.cwd(), 'startup')
    if (pendingOpenFilePaths.length > 0) {
      const paths = pendingOpenFilePaths.splice(0)
      await openPaths(paths, 'open-file')
    }
  })
}

function configureImageDecoderProtocol(): void {
  const decoderFiles = new Map([
    ['image-decoder.html', 'text/html; charset=utf-8'],
    ['image-decoder-bootstrap.js', 'text/javascript; charset=utf-8'],
    ['heic2any.min.js', 'text/javascript; charset=utf-8'],
  ])
  void protocol.handle(IMAGE_DECODER_SCHEME, async (request) => {
    const url = new URL(request.url)
    const requestedPath = url.pathname.replace(/^\/+/, '') || 'image-decoder.html'
    const contentType = decoderFiles.get(requestedPath)
    if (url.hostname !== 'decoder' || request.method !== 'GET' || !contentType) {
      return new Response('Not found', { status: 404 })
    }

    try {
      const response = await net.fetch(pathToFileURL(resolve(rendererDirectory, requestedPath)).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Type', contentType)
      headers.set('Content-Security-Policy', [
        "default-src 'none'",
        "script-src office-image: 'unsafe-eval' 'wasm-unsafe-eval' blob:",
        "connect-src 'none'",
        "img-src 'none'",
        "style-src 'none'",
        "font-src 'none'",
        "worker-src blob:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '))
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Cache-Control', 'no-store')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return new Response('Decoder resource unavailable', { status: 404 })
    }
  })
}

function configureFontDecoderProtocol(): void {
  const decoderFiles = new Map([
    ['font-decoder.html', 'text/html; charset=utf-8'],
    ['font-decoder-bootstrap.js', 'text/javascript; charset=utf-8'],
    ['woff2_decompress_binding.js', 'text/javascript; charset=utf-8'],
  ])
  void protocol.handle(FONT_DECODER_SCHEME, async (request) => {
    const url = new URL(request.url)
    const requestedPath = url.pathname.replace(/^\/+/, '') || 'font-decoder.html'
    const contentType = decoderFiles.get(requestedPath)
    if (url.hostname !== 'decoder' || request.method !== 'GET' || !contentType) {
      return new Response('Not found', { status: 404 })
    }

    try {
      const response = await net.fetch(pathToFileURL(resolve(rendererDirectory, requestedPath)).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Type', contentType)
      headers.set('Content-Security-Policy', [
        "default-src 'none'",
        "script-src office-font: 'unsafe-eval' 'wasm-unsafe-eval'",
        "connect-src 'none'",
        "img-src 'none'",
        "style-src 'none'",
        "font-src 'none'",
        "worker-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '))
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Cache-Control', 'no-store')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return new Response('Decoder resource unavailable', { status: 404 })
    }
  })
}

function configureHtmlViewerProtocol(): void {
  void protocol.handle(HTML_VIEWER_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'viewer' || request.method !== 'GET') {
      return new Response('Not found', { status: 404 })
    }

    let requestedPath: string
    try {
      requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    const match = /^document\/([0-9a-f-]{36})(?:\/(.*))?$/i.exec(requestedPath)
    if (!match) {
      return new Response('Bad document token', { status: 400 })
    }

    try {
      const sourcePath = sessions.getPath(match[1])
      const sourceDirectory = dirname(sourcePath)
      const relativeResourcePath = match[2] || basename(sourcePath)
      if (relativeResourcePath.includes('\0')) {
        return new Response('Bad request', { status: 400 })
      }

      const candidate = resolve(sourceDirectory, relativeResourcePath)
      const realSourceDirectory = await realpath(sourceDirectory)
      const realCandidate = await realpath(candidate)
      const pathFromSourceDirectory = relative(realSourceDirectory, realCandidate)
      if (
        pathFromSourceDirectory.startsWith('..') ||
        isAbsolute(pathFromSourceDirectory)
      ) {
        return new Response('Forbidden', { status: 403 })
      }

      const fileStat = await stat(realCandidate)
      if (!fileStat.isFile() || fileStat.size > 64 * 1024 * 1024) {
        return new Response('Resource unavailable', { status: 404 })
      }

      const response = await net.fetch(pathToFileURL(realCandidate).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', [
        "default-src office-html: data: blob:",
        "script-src office-html: 'unsafe-inline' 'unsafe-eval' blob:",
        "style-src office-html: 'unsafe-inline' data: blob:",
        'img-src office-html: data: blob:',
        'font-src office-html: data:',
        'media-src office-html: data: blob:',
        'connect-src office-html:',
        "worker-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '))
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return new Response('Resource unavailable', { status: 404 })
    }
  })
}

function configurePdfViewerProtocol(): void {
  const viewerRoot = resolve(rendererDirectory, 'pdf')
  void protocol.handle(PDF_VIEWER_SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'viewer') {
      return new Response('Not found', { status: 404 })
    }

    let requestedPath: string
    try {
      requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (requestedPath.startsWith('document/')) {
      const sessionId = requestedPath.slice('document/'.length)
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
        return new Response('Bad document token', { status: 400 })
      }
      try {
        return net.fetch(pathToFileURL(sessions.getPath(sessionId)).href)
      } catch {
        return new Response('Document unavailable', { status: 404 })
      }
    }
    const candidate = resolve(viewerRoot, requestedPath || 'viewer.html')
    const pathFromViewerRoot = relative(viewerRoot, candidate)
    if (pathFromViewerRoot.startsWith('..') || isAbsolute(pathFromViewerRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(candidate).href)
  })
}

function configureMarkdownViewerProtocol(): void {
  const markdownRoot = resolve(rendererDirectory, 'markdown')
  void protocol.handle(MARKDOWN_VIEWER_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'viewer' || request.method !== 'GET') {
      return new Response('Not found', { status: 404 })
    }

    let requestedPath: string
    try {
      requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    if (requestedPath === 'assets/index.html') {
      const sessionId = url.searchParams.get('session') ?? ''
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
        return new Response('Bad document token', { status: 400 })
      }
      try {
        sessions.getPath(sessionId)
        const template = await readFile(resolve(markdownRoot, 'index.html'), 'utf8')
        const useWorkspaceBase = url.searchParams.get('imageBase') === 'workspace'
        const resourceScope = useWorkspaceBase ? 'workspace' : 'document'
        const documentBase = `${MARKDOWN_VIEWER_SCHEME}://viewer/${resourceScope}/${sessionId}`
        const csp = [
          "default-src 'self' data: blob:",
          "script-src 'self' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "worker-src 'self' blob:",
          "frame-src 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join('; ')
        const html = template
          .replace('{{baseUrl}}', documentBase)
          .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`)
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': csp,
            'X-Content-Type-Options': 'nosniff',
          },
        })
      } catch {
        return new Response('Document unavailable', { status: 404 })
      }
    }

    if (requestedPath.startsWith('document/')) {
      const match = /^document\/([0-9a-f-]{36})\/(.+)$/i.exec(requestedPath)
      if (!match) return new Response('Bad document resource', { status: 400 })
      try {
        const resourcePath = await sessions.resolveDocumentResource(match[1], match[2])
        return net.fetch(pathToFileURL(resourcePath).href)
      } catch {
        return new Response('Document resource unavailable', { status: 404 })
      }
    }

    if (requestedPath.startsWith('workspace/')) {
      const match = /^workspace\/([0-9a-f-]{36})\/(.+)$/i.exec(requestedPath)
      if (!match) return new Response('Bad workspace resource', { status: 400 })
      try {
        const resourcePath = await resolveMarkdownWorkspaceResource(sessions, match[1], match[2])
        return net.fetch(pathToFileURL(resourcePath).href)
      } catch {
        return new Response('Markdown workspace resource unavailable', { status: 404 })
      }
    }

    if (!requestedPath.startsWith('assets/')) {
      return new Response('Not found', { status: 404 })
    }
    const candidate = resolve(markdownRoot, requestedPath.slice('assets/'.length))
    const pathFromRoot = relative(markdownRoot, candidate)
    if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(candidate).href)
  })
}

function configureIpc(): void {
  removeIpcHandlers = registerIpcHandlers({
    getWindow: () => mainWindow,
    sessions,
    isTrustedSender,
    publishFilesOpened,
    markRendererReady,
    setRendererDirtyState: (dirty) => {
      rendererDirty = dirty
    },
  })

  sessions.onDidChange((event) => {
    if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.fileChanged, event)
    }
  })
}

function createMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return
  }

  rendererReady = false
  rendererDirty = false
  forceWindowClose = false
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Office Viewer',
    icon: resolve(app.getAppPath(), 'image/logo.png'),
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  })
  mainWindow = window

  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url)) {
      event.preventDefault()
    }
  })
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) rendererReady = false
  })
  window.on('close', (event) => {
    if (!rendererDirty || forceWindowClose) {
      return
    }

    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: '存在未保存的更改',
      message: '仍有文档包含未保存的更改。',
      detail: '关闭 Office Viewer 将放弃这些更改。',
      buttons: ['取消', '放弃更改并退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (choice === 0) {
      event.preventDefault()
      return
    }
    forceWindowClose = true
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
      rendererReady = false
    }
  })

  if (developmentUrl) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadFile(resolve(rendererDirectory, 'index.desktop.html'))
  }
}

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const window = mainWindow
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    return false
  }

  if (event.senderFrame !== event.sender.mainFrame) {
    return false
  }

  return isAllowedRendererUrl(event.senderFrame.url)
}

function isAllowedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (developmentUrl) {
      return url.origin === new URL(developmentUrl).origin
    }

    if (url.protocol !== 'file:') {
      return false
    }

    const candidate = fileURLToPath(url)
    const pathFromRendererRoot = relative(rendererDirectory, candidate)
    return pathFromRendererRoot === '' || (
      !pathFromRendererRoot.startsWith('..') &&
      !isAbsolute(pathFromRendererRoot)
    )
  } catch {
    return false
  }
}

function publishFilesOpened(event: DesktopFilesOpenedEvent): void {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) {
    pendingOpenEvents.push(event)
    if (pendingOpenEvents.length > MAX_PENDING_OPEN_EVENTS) {
      pendingOpenEvents.shift()
    }
    return
  }

  mainWindow.webContents.send(IPC_CHANNELS.filesOpened, event)
}

function markRendererReady(): void {
  rendererReady = true
  const events = pendingOpenEvents.splice(0)
  for (const event of events) {
    mainWindow?.webContents.send(IPC_CHANNELS.filesOpened, event)
  }
}

async function openCommandLineFiles(
  commandLine: readonly string[],
  workingDirectory: string,
  reason: DesktopOpenReason,
): Promise<void> {
  const paths = await collectFileArguments(commandLine, workingDirectory)
  await openPaths(paths, reason)
}

async function openPaths(paths: readonly string[], reason: DesktopOpenReason): Promise<void> {
  const opened: DesktopFileSession[] = []
  const seenSessionIds = new Set<string>()

  for (const path of paths) {
    try {
      const [session] = await sessions.registerPaths([path])
      if (session && !seenSessionIds.has(session.id)) {
        seenSessionIds.add(session.id)
        opened.push(session)
      }
    } catch {
      // Ignore stale shell/command-line paths while opening all remaining files.
    }
  }

  if (opened.length > 0) {
    publishFilesOpened({ reason, files: opened })
  }
}

async function collectFileArguments(
  commandLine: readonly string[],
  workingDirectory: string,
): Promise<string[]> {
  const paths: string[] = []
  const seen = new Set<string>()
  const excludedPaths = new Set(
    [process.execPath, runtimeEntryPath, process.argv[1]]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value) => normalizePathKey(resolve(value))),
  )

  for (const argument of commandLine) {
    if (typeof argument !== 'string' || argument.length === 0 || argument.includes('\0')) {
      continue
    }
    if (argument.startsWith('-') && !isAbsolute(argument)) {
      continue
    }

    const candidate = isAbsolute(argument) ? resolve(argument) : resolve(workingDirectory, argument)
    const key = normalizePathKey(candidate)
    if (excludedPaths.has(key) || seen.has(key)) {
      continue
    }

    try {
      const fileStat = await stat(candidate)
      if (fileStat.isFile()) {
        seen.add(key)
        paths.push(candidate)
      }
    } catch {
      // Ignore Electron switches and paths that no longer exist.
    }
  }

  return paths
}

function normalizePathKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function getDevelopmentUrl(): string | null {
  if (app.isPackaged) {
    return null
  }

  const value = process.env.OFFICE_DESKTOP_DEV_URL
  if (!value) {
    return null
  }

  try {
    const url = new URL(value)
    if (
      url.protocol !== 'http:' ||
      (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}
