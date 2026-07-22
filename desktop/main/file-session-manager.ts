import { randomUUID } from 'node:crypto'
import { access, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { constants } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import type {
  DesktopFileChangedEvent,
  DesktopFileSession,
  DesktopImageCollection,
  DesktopWriteResult,
} from '../shared/desktop-api'

const WATCH_DEBOUNCE_MS = 150
const INTERNAL_WRITE_SUPPRESSION_MS = 750
const MAX_SESSION_ID_LENGTH = 128
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_IMAGE_COLLECTION_BYTES = 512 * 1024 * 1024
const MAX_SIBLING_IMAGES = 500
const ATOMIC_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

const IMAGE_MIME = new Map<string, string>([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.pjpeg', 'image/jpeg'], ['.pjp', 'image/jpeg'],
  ['.png', 'image/png'], ['.gif', 'image/gif'], ['.apng', 'image/apng'], ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'], ['.cur', 'image/x-icon'], ['.webp', 'image/webp'],
  ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],
])

interface FileSessionEntry {
  session: DesktopFileSession
  watcher?: FSWatcher
  debounceTimer?: NodeJS.Timeout
  suppressChangesUntil: number
}

export class FileSessionManager {
  private readonly entries = new Map<string, FileSessionEntry>()
  private readonly pathToSessionId = new Map<string, string>()
  private readonly changeListeners = new Set<(event: DesktopFileChangedEvent) => void>()

  async registerPaths(paths: readonly string[]): Promise<DesktopFileSession[]> {
    const sessions: DesktopFileSession[] = []

    for (const candidate of paths) {
      sessions.push(await this.registerPath(candidate))
    }

    return sessions
  }

  async read(sessionId: string): Promise<ArrayBuffer> {
    const entry = this.requireEntry(sessionId)
    const fileStat = await stat(entry.session.path)
    assertFileSize(fileStat.size)
    this.attachWatcher(entry)
    const contents = await readFile(entry.session.path)
    return Uint8Array.from(contents).buffer
  }

  async write(sessionId: string, data: ArrayBuffer | Uint8Array): Promise<DesktopWriteResult> {
    const entry = this.requireEntry(sessionId)
    const contents = toBuffer(data)
    assertFileSize(contents.byteLength)
    this.attachWatcher(entry)

    entry.suppressChangesUntil = Date.now() + INTERNAL_WRITE_SUPPRESSION_MS
    await atomicWriteFile(entry.session.path, contents)
    await this.refreshEntry(entry, false)

    return {
      session: entry.session,
      bytesWritten: contents.byteLength,
    }
  }

  async writeAs(path: string, data: ArrayBuffer | Uint8Array): Promise<DesktopWriteResult> {
    const target = resolve(path)
    const contents = toBuffer(data)
    assertFileSize(contents.byteLength)

    await atomicWriteFile(target, contents)
    const session = await this.registerPath(target)
    const entry = this.requireEntry(session.id)
    entry.suppressChangesUntil = Date.now() + INTERNAL_WRITE_SUPPRESSION_MS
    await this.refreshEntry(entry, false)

    return {
      session: entry.session,
      bytesWritten: contents.byteLength,
    }
  }

  getPath(sessionId: string): string {
    return this.requireEntry(sessionId).session.path
  }

  async resolveDocumentResource(sessionId: string, resourcePath: string): Promise<string> {
    const sourcePath = this.requireEntry(sessionId).session.path
    if (
      typeof resourcePath !== 'string' ||
      resourcePath.length === 0 ||
      resourcePath.length > 4_096 ||
      resourcePath.includes('\0') ||
      isAbsolute(resourcePath)
    ) {
      throw new TypeError('A valid document-relative resource path is required.')
    }

    const documentDirectory = await realpath(dirname(sourcePath))
    const candidate = await realpath(resolve(documentDirectory, resourcePath))
    const pathFromDocument = relative(documentDirectory, candidate)
    if (
      pathFromDocument === '' ||
      pathFromDocument.startsWith('..') ||
      isAbsolute(pathFromDocument)
    ) {
      throw new Error('The requested resource is outside the current document directory.')
    }

    const resourceStat = await stat(candidate)
    if (!resourceStat.isFile()) {
      throw new Error('Only regular document resources can be loaded.')
    }
    assertFileSize(resourceStat.size)
    return candidate
  }

  async resolveMarkdownLink(sessionId: string, rawLink: string): Promise<DesktopFileSession | null> {
    const source = this.requireEntry(sessionId).session
    if (
      typeof rawLink !== 'string' ||
      rawLink.length === 0 ||
      rawLink.length > 4_096 ||
      rawLink.includes('\0')
    ) {
      throw new TypeError('A valid Markdown link is required.')
    }

    const withoutPrefix = rawLink.startsWith('wiki:') ? rawLink.slice(5) : rawLink
    const page = withoutPrefix.split('#', 1)[0]
      .split('|', 1)[0]
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
    if (!page) return source

    let decodedPage: string
    try {
      decodedPage = decodeURIComponent(page)
    } catch {
      throw new TypeError('The Markdown link contains invalid URL encoding.')
    }
    if (
      decodedPage.length === 0 ||
      isAbsolute(decodedPage) ||
      decodedPage.split('/').some((segment) => segment === '..' || segment === '')
    ) {
      throw new Error('Markdown links must remain inside the current document directory.')
    }

    const extension = extname(decodedPage).toLowerCase()
    const candidates = extension === '.md' || extension === '.markdown'
      ? [decodedPage]
      : [decodedPage, `${decodedPage}.md`, `${decodedPage}.markdown`]
    for (const candidate of candidates) {
      try {
        const targetPath = await this.resolveDocumentResource(sessionId, candidate)
        const [target] = await this.registerPaths([targetPath])
        return target ?? null
      } catch {
        // Try the next Markdown filename variant without widening the authorized root.
      }
    }
    return null
  }

  async listSiblingImages(sessionId: string): Promise<DesktopImageCollection> {
    const source = this.requireEntry(sessionId).session
    const sourceKey = normalizePathKey(source.path)
    const directoryEntries = await readdir(dirname(source.path), { withFileTypes: true })
    const candidates = directoryEntries
      .filter((entry) => entry.isFile() && IMAGE_MIME.has(extname(entry.name).toLowerCase()))
      .map((entry) => resolve(dirname(source.path), entry.name))
      .sort((left, right) => basename(left).localeCompare(basename(right), undefined, {
        numeric: true,
        sensitivity: 'base',
      }))

    const sourceIndex = candidates.findIndex((path) => normalizePathKey(path) === sourceKey)
    if (sourceIndex > 0) {
      candidates.unshift(candidates.splice(sourceIndex, 1)[0])
    }

    const images: DesktopImageCollection['images'][number][] = []
    let totalBytes = 0
    for (const candidate of candidates) {
      if (images.length >= MAX_SIBLING_IMAGES) break
      try {
        const session = await this.registerPath(candidate)
        if (totalBytes + session.byteLength > MAX_IMAGE_COLLECTION_BYTES && session.id !== source.id) {
          continue
        }
        totalBytes += session.byteLength
        images.push({
          session,
          mime: IMAGE_MIME.get(session.extension) ?? 'application/octet-stream',
        })
      } catch {
        // Skip unreadable, deleted, or oversized sibling images without hiding the rest.
      }
    }

    images.sort((left, right) => left.session.name.localeCompare(right.session.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    }))
    return {
      images,
      current: Math.max(0, images.findIndex((image) => image.session.id === source.id)),
    }
  }

  suspend(sessionId: string): void {
    const entry = this.requireEntry(sessionId)
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = undefined
    }
    entry.watcher?.close()
    entry.watcher = undefined
  }

  onDidChange(listener: (event: DesktopFileChangedEvent) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer)
      }
      entry.watcher?.close()
    }

    this.entries.clear()
    this.pathToSessionId.clear()
    this.changeListeners.clear()
  }

  private async registerPath(candidate: string): Promise<DesktopFileSession> {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new TypeError('A non-empty file path is required.')
    }

    const canonicalPath = await realpath(resolve(candidate))
    const fileStat = await stat(canonicalPath)
    if (!fileStat.isFile()) {
      throw new Error('Only regular files can be opened.')
    }
    assertFileSize(fileStat.size)

    const pathKey = normalizePathKey(canonicalPath)
    const existingSessionId = this.pathToSessionId.get(pathKey)
    if (existingSessionId) {
      const existingEntry = this.requireEntry(existingSessionId)
      await this.refreshEntry(existingEntry, false)
      this.attachWatcher(existingEntry)
      return existingEntry.session
    }

    const session = await createSession(canonicalPath, fileStat.size, fileStat.mtimeMs)
    const entry: FileSessionEntry = {
      session,
      suppressChangesUntil: 0,
    }

    this.entries.set(session.id, entry)
    this.pathToSessionId.set(pathKey, session.id)
    this.attachWatcher(entry)

    return session
  }

  private attachWatcher(entry: FileSessionEntry): void {
    if (entry.watcher) {
      return
    }
    const parentDirectory = dirname(entry.session.path)
    const targetName = normalizeFileName(basename(entry.session.path))

    try {
      entry.watcher = watch(parentDirectory, (_eventType, changedName) => {
        if (!changedName || normalizeFileName(changedName.toString()) !== targetName) {
          return
        }

        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer)
        }

        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = undefined
          void this.refreshEntry(entry, true)
        }, WATCH_DEBOUNCE_MS)
      })

      entry.watcher.on('error', () => {
        entry.watcher?.close()
        entry.watcher = undefined
      })
    } catch {
      // File operations remain available if the OS cannot create a watcher.
      entry.watcher = undefined
    }
  }

  private async refreshEntry(entry: FileSessionEntry, notify: boolean): Promise<void> {
    try {
      const fileStat = await stat(entry.session.path)
      if (!fileStat.isFile()) {
        return
      }

      const changed =
        fileStat.size !== entry.session.byteLength ||
        fileStat.mtimeMs !== entry.session.lastModified

      entry.session = await createSession(
        entry.session.path,
        fileStat.size,
        fileStat.mtimeMs,
        entry.session.id,
      )

      if (!notify || !changed || Date.now() <= entry.suppressChangesUntil) {
        return
      }

      const event: DesktopFileChangedEvent = {
        sessionId: entry.session.id,
        lastModified: entry.session.lastModified,
        byteLength: entry.session.byteLength,
      }
      for (const listener of this.changeListeners) {
        listener(event)
      }
    } catch {
      // A transient rename during an atomic save is handled by the next watcher event.
    }
  }

  private requireEntry(sessionId: string): FileSessionEntry {
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > MAX_SESSION_ID_LENGTH
    ) {
      throw new TypeError('A valid file session id is required.')
    }

    const entry = this.entries.get(sessionId)
    if (!entry) {
      throw new Error('The file session is unknown or has expired.')
    }

    return entry
  }
}

async function createSession(
  path: string,
  byteLength: number,
  lastModified: number,
  id: string = randomUUID(),
): Promise<DesktopFileSession> {
  let readOnly = false
  try {
    await access(path, constants.W_OK)
  } catch {
    readOnly = true
  }

  return Object.freeze({
    id,
    name: basename(path),
    path,
    extension: extname(path).toLowerCase(),
    byteLength,
    lastModified,
    readOnly,
  })
}

function toBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }

  throw new TypeError('File contents must be an ArrayBuffer or Uint8Array.')
}

function assertFileSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_FILE_BYTES) {
    throw new RangeError(`Documents larger than ${MAX_FILE_BYTES} bytes are not supported.`)
  }
}

async function atomicWriteFile(target: string, contents: Buffer): Promise<void> {
  const temporaryPath = `${target}.office-viewer-${randomUUID()}.tmp`
  let temporaryCreated = false

  try {
    const handle = await open(temporaryPath, 'wx')
    temporaryCreated = true
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }

    // The temporary file lives beside the target, so rename is an atomic replace
    // on the supported Windows filesystem path and the original remains intact
    // until every byte of the replacement has been flushed.
    await replaceFileWithRetry(temporaryPath, target)
    temporaryCreated = false
  } finally {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

async function replaceFileWithRetry(temporaryPath: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, target)
      return
    } catch (reason) {
      const retryDelay = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]
      if (retryDelay === undefined || !isTransientRenameError(reason)) {
        throw reason
      }

      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryDelay))
    }
  }
}

function isTransientRenameError(reason: unknown): reason is NodeJS.ErrnoException {
  if (!(reason instanceof Error) || !('code' in reason)) {
    return false
  }

  return reason.code === 'EPERM' || reason.code === 'EACCES' || reason.code === 'EBUSY'
}

function normalizePathKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

function normalizeFileName(name: string): string {
  return process.platform === 'win32' ? name.toLocaleLowerCase('en-US') : name
}
