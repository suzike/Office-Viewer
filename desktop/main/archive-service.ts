import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js'
import iconv from 'iconv-lite'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  DesktopArchiveEntry,
  DesktopArchiveInfo,
  DesktopArchiveExtractResult,
} from '../shared/desktop-api'

export const ARCHIVE_LIMITS = Object.freeze({
  entries: 10_000,
  entryBytes: 128 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  compressionRatio: 1_000,
})
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const ZIP_EXTENSIONS = new Set(['.apk', '.crx', '.jar', '.vsix', '.zip'])

interface ArchiveSource {
  readonly payload: Uint8Array
  readonly prefix?: Uint8Array
}

interface ParsedArchive {
  readonly source: ArchiveSource
  readonly entries: readonly Entry[]
  readonly files: DesktopArchiveEntry[]
  readonly folderMap: Record<string, DesktopArchiveEntry>
  readonly fileMap: Map<string, FileEntry>
  readonly encrypted: boolean
  readonly encoding: string
}

export function supportsZipArchive(filePath: string): boolean {
  return ZIP_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export async function inspectZipArchive(
  data: ArrayBuffer | Uint8Array,
  filePath: string,
  encoding = 'utf8',
): Promise<DesktopArchiveInfo> {
  const parsed = await parseArchive(data, encoding)
  const jarInfo = filePath.toLowerCase().endsWith('.jar')
    ? await readJarInfo(parsed.fileMap)
    : undefined
  return {
    fileName: basename(filePath),
    files: parsed.files,
    folderMap: parsed.folderMap,
    encrypted: parsed.encrypted,
    encoding,
    extension: extname(filePath).slice(1).toLowerCase(),
    size: prettyBytes(parsed.source.payload.byteLength + (parsed.source.prefix?.byteLength ?? 0)),
    jarInfo,
  }
}

export async function readZipArchiveEntry(
  data: ArrayBuffer | Uint8Array,
  entryName: string,
  password?: string,
): Promise<Uint8Array> {
  const parsed = await parseArchive(data, 'utf8')
  const safeName = normalizeArchiveEntryName(entryName)
  const entry = parsed.fileMap.get(safeName)
  if (!entry) throw new Error(`Archive entry not found: ${safeName}`)
  return readEntry(entry, password)
}

export async function extractZipArchive(
  data: ArrayBuffer | Uint8Array,
  destination: string,
  password?: string,
): Promise<DesktopArchiveExtractResult> {
  const parsed = await parseArchive(data, 'utf8')
  await ensureSafeExtractionRoot(destination)
  let fileCount = 0
  for (const [entryName, entry] of parsed.fileMap) {
    const target = await resolveSafeExtractionTarget(destination, entryName)
    await ensureSafeParentDirectories(destination, dirname(target))
    const contents = await readEntry(entry, password)
    const handle = await open(target, 'wx')
    try {
      await handle.writeFile(contents)
    } finally {
      await handle.close()
    }
    fileCount += 1
  }
  return { targetPath: resolve(destination), fileCount }
}

export async function rewriteZipArchive(
  data: ArrayBuffer | Uint8Array,
  options: {
    readonly exclude?: string
    readonly add?: { readonly entryName: string; readonly contents: Uint8Array }
    readonly encoding?: string
  },
): Promise<Uint8Array> {
  const encoding = options.encoding || 'utf8'
  const parsed = await parseArchive(data, encoding)
  const exclude = options.exclude ? normalizeArchiveEntryName(options.exclude) : undefined
  const add = options.add
    ? { ...options.add, entryName: normalizeArchiveEntryName(options.add.entryName) }
    : undefined
  if (add && add.contents.byteLength > ARCHIVE_LIMITS.entryBytes) {
    throw new RangeError(`Archive entries larger than ${prettyBytes(ARCHIVE_LIMITS.entryBytes)} are not supported.`)
  }

  const writer = new ZipWriter(new Uint8ArrayWriter(), getWriterOptions(encoding))
  for (const entry of parsed.entries) {
    const entryName = normalizeArchiveEntryName(entry.filename)
    if (entryName === exclude || entryName === add?.entryName) continue
    if (entry.directory) {
      await writer.add(`${entryName}/`, undefined, { directory: true })
      continue
    }
    const raw = await (entry as FileEntry).getData(new Uint8ArrayWriter(), { passThrough: true })
    await writer.add(entryName, new Uint8ArrayReader(raw), {
      passThrough: true,
      encrypted: entry.encrypted,
      zipCrypto: entry.zipCrypto,
      compressionMethod: entry.compressionMethod,
      uncompressedSize: entry.uncompressedSize,
      lastModDate: entry.lastModDate,
    })
  }
  if (add) {
    await writer.add(add.entryName, new Uint8ArrayReader(add.contents), getWriterOptions(encoding))
  }
  const payload = await writer.close()
  if (!parsed.source.prefix) return payload
  const output = new Uint8Array(parsed.source.prefix.byteLength + payload.byteLength)
  output.set(parsed.source.prefix)
  output.set(payload, parsed.source.prefix.byteLength)
  return output
}

export async function readArchiveAddSource(filePath: string): Promise<Uint8Array> {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARCHIVE_LIMITS.entryBytes) {
    throw new Error('Only regular files within the archive entry size limit can be added.')
  }
  return readFile(filePath)
}

function getReaderOptions(encoding: string) {
  if (!encoding || encoding.toLowerCase() === 'utf8') return {}
  if (!iconv.encodingExists(encoding)) throw new Error(`Unsupported ZIP filename encoding: ${encoding}`)
  return {
    filenameEncoding: encoding,
    decodeText: (value: Uint8Array) => iconv.decode(Buffer.from(value), encoding),
  }
}

function getWriterOptions(encoding: string) {
  if (!encoding || encoding.toLowerCase() === 'utf8') return {}
  if (!iconv.encodingExists(encoding)) throw new Error(`Unsupported ZIP filename encoding: ${encoding}`)
  return {
    useUnicodeFileNames: false,
    encodeText: (value: string) => new Uint8Array(iconv.encode(value, encoding)),
  }
}

async function parseArchive(data: ArrayBuffer | Uint8Array, encoding: string): Promise<ParsedArchive> {
  const source = unwrapCrx(toUint8Array(data))
  const reader = new ZipReader(new Uint8ArrayReader(source.payload), getReaderOptions(encoding))
  let entries: Entry[]
  try {
    entries = await reader.getEntries()
  } catch (error) {
    throw new Error(`Invalid or damaged ZIP archive: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await reader.close().catch(() => undefined)
  }
  if (entries.length > ARCHIVE_LIMITS.entries) {
    throw new RangeError(`Archive contains more than ${ARCHIVE_LIMITS.entries} entries.`)
  }

  const files: DesktopArchiveEntry[] = []
  const folderMap: Record<string, DesktopArchiveEntry> = {}
  const fileMap = new Map<string, FileEntry>()
  const pathMap = new Set<string>()
  const caseFoldedPaths = new Set<string>()
  let totalBytes = 0
  let encrypted = false

  const pushEntry = (entry: DesktopArchiveEntry) => {
    if (!entry.entryName || pathMap.has(entry.entryName)) return
    pathMap.add(entry.entryName)
    const separator = entry.entryName.lastIndexOf('/')
    if (separator < 0) {
      files.push(entry)
      return
    }
    const parentPath = entry.entryName.slice(0, separator)
    const parent = folderMap[parentPath]
    if (parent) {
      ;(parent.children as DesktopArchiveEntry[]).push(entry)
      return
    }
    const parentEntry: DesktopArchiveEntry = {
      name: parentPath.slice(parentPath.lastIndexOf('/') + 1),
      entryName: parentPath,
      isDirectory: true,
      children: [entry],
    }
    folderMap[parentPath] = parentEntry
    pushEntry(parentEntry)
  }

  for (const entry of entries) {
    const entryName = normalizeArchiveEntryName(entry.filename)
    assertNotLink(entry, entryName)
    const folded = entryName.toLocaleLowerCase('en-US')
    if (caseFoldedPaths.has(folded)) throw new Error(`Archive contains a duplicate Windows path: ${entryName}`)
    caseFoldedPaths.add(folded)
    const size = entry.uncompressedSize ?? 0
    const compressed = entry.compressedSize ?? 0
    if (size > ARCHIVE_LIMITS.entryBytes) throw new RangeError(`Archive entry is too large: ${entryName}`)
    if (size > 1024 * 1024 && size / Math.max(1, compressed) > ARCHIVE_LIMITS.compressionRatio) {
      throw new RangeError(`Suspicious compression ratio for archive entry: ${entryName}`)
    }
    totalBytes += size
    if (totalBytes > ARCHIVE_LIMITS.totalBytes) throw new RangeError('Archive expands beyond the total size limit.')
    if (entry.encrypted) encrypted = true
    if (!entry.directory) fileMap.set(entryName, entry as FileEntry)
    pushEntry({
      name: entryName.slice(entryName.lastIndexOf('/') + 1),
      entryName,
      isDirectory: entry.directory,
      fileSize: prettyBytes(size),
      fileSizeOrigin: size,
      compressedSize: prettyBytes(compressed),
      compressedSizeOrigin: compressed,
      modifyDateTime: entry.lastModDate ? formatArchiveDate(entry.lastModDate) : null,
      encrypted: entry.encrypted,
    })
  }

  const sort = (a: DesktopArchiveEntry, b: DesktopArchiveEntry) => {
    if (Boolean(a.isDirectory) !== Boolean(b.isDirectory)) return a.isDirectory ? -1 : 1
    return (a.name ?? '').localeCompare(b.name ?? '')
  }
  files.sort(sort)
  for (const folder of Object.values(folderMap)) {
    ;(folder.children as DesktopArchiveEntry[]).sort(sort)
  }
  return { source, entries, files, folderMap, fileMap, encrypted, encoding }
}

async function readEntry(entry: FileEntry, password?: string): Promise<Uint8Array> {
  if (entry.encrypted && !password) throw new Error('Archive password is required.')
  try {
    const contents = await entry.getData(new Uint8ArrayWriter(), { password })
    if (contents.byteLength > ARCHIVE_LIMITS.entryBytes) throw new RangeError('Expanded archive entry exceeds the size limit.')
    return contents
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/password|encrypted/i.test(message)) throw new Error('Incorrect archive password.')
    throw error
  }
}

export function normalizeArchiveEntryName(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Archive entry has an invalid path.')
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/g, '')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[a-z]:/i.test(normalized) ||
    /^(?:\\\\|\/\/)[?.]\//.test(value)
  ) {
    throw new Error(`Unsafe archive entry path: ${value}`)
  }
  const parts = normalized.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes(':') || /[. ]$/.test(part) || WINDOWS_DEVICE_NAME.test(part)) {
      throw new Error(`Unsafe archive entry path: ${value}`)
    }
  }
  return parts.join('/')
}

function assertNotLink(entry: Entry, entryName: string): void {
  const attributes = Number(entry.externalFileAttributes ?? 0)
  const unixMode = attributes >>> 16
  if ((unixMode & 0o170000) === 0o120000) {
    throw new Error(`Symbolic-link archive entries are not supported: ${entryName}`)
  }
}

async function ensureSafeExtractionRoot(destination: string): Promise<void> {
  if (!isAbsolute(destination) || destination.includes('\0')) throw new Error('Extraction target must be an absolute path.')
  await mkdir(destination, { recursive: true })
  const stat = await lstat(destination)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Extraction target must be a regular directory.')
}

async function resolveSafeExtractionTarget(baseDir: string, entryName: string): Promise<string> {
  const base = await realpath(baseDir)
  const target = resolve(base, ...normalizeArchiveEntryName(entryName).split('/'))
  const rel = relative(base, target)
  if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error(`Unsafe archive entry path: ${entryName}`)
  return target
}

export async function writeArchiveFiles(
  destination: string,
  files: Iterable<{ readonly entryName: string; readonly contents: Uint8Array }>,
): Promise<DesktopArchiveExtractResult> {
  await ensureSafeExtractionRoot(destination)
  let fileCount = 0
  let totalBytes = 0
  for (const file of files) {
    const entryName = normalizeArchiveEntryName(file.entryName)
    if (file.contents.byteLength > ARCHIVE_LIMITS.entryBytes) {
      throw new RangeError(`Expanded archive entry exceeds the size limit: ${entryName}`)
    }
    totalBytes += file.contents.byteLength
    if (totalBytes > ARCHIVE_LIMITS.totalBytes) throw new RangeError('Archive expands beyond the total size limit.')
    const target = await resolveSafeExtractionTarget(destination, entryName)
    await ensureSafeParentDirectories(destination, dirname(target))
    const handle = await open(target, 'wx')
    try {
      await handle.writeFile(file.contents)
    } finally {
      await handle.close()
    }
    fileCount += 1
  }
  return { targetPath: resolve(destination), fileCount }
}

async function ensureSafeParentDirectories(baseDir: string, targetDir: string): Promise<void> {
  const base = await realpath(baseDir)
  const rel = relative(base, resolve(targetDir))
  let current = base
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Archive extraction encountered a link or non-directory ancestor.')
    const actual = await realpath(current)
    const actualRel = relative(base, actual)
    if (isAbsolute(actualRel) || actualRel.split(sep).includes('..')) throw new Error('Archive extraction escaped its destination.')
  }
}

function unwrapCrx(data: Uint8Array): ArchiveSource {
  if (data.byteLength < 12 || new TextDecoder('ascii').decode(data.subarray(0, 4)) !== 'Cr24') return { payload: data }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const version = view.getUint32(4, true)
  let end = 0
  if (version === 2 && data.byteLength >= 16) end = 16 + view.getUint32(8, true) + view.getUint32(12, true)
  if (version === 3) end = 12 + view.getUint32(8, true)
  if (end <= 0 || end >= data.byteLength) throw new Error('Invalid CRX header.')
  return { prefix: data.slice(0, end), payload: data.slice(end) }
}

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

export function prettyBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** order
  return `${value >= 10 || order === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[order]}`
}

export function formatArchiveDate(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

async function readJarInfo(fileMap: Map<string, FileEntry>): Promise<{ mainClass?: string; javaMinVersion?: string }> {
  const names = [...fileMap.keys()]
  const manifestName = names.find((name) => name.toUpperCase() === 'META-INF/MANIFEST.MF')
  let manifest: Record<string, string> = {}
  if (manifestName) {
    try {
      manifest = parseManifest(new TextDecoder().decode(await readEntry(fileMap.get(manifestName)!)))
    } catch {
      // Encrypted or malformed manifests should not prevent JAR browsing.
    }
  }

  let maxJava = 0
  for (const name of names) {
    const versioned = name.match(/^META-INF\/versions\/(\d+)\//i)
    if (versioned) maxJava = Math.max(maxJava, Number(versioned[1]))
  }
  const declared = manifest['Build-Jdk-Spec'] ?? manifest['Build-Jdk']
  const declaredMatch = declared?.match(/^(?:1\.)?(\d+)/)
  if (declaredMatch) maxJava = Math.max(maxJava, Number(declaredMatch[1]))

  if (!maxJava) {
    const classNames = names.filter((name) => name.endsWith('.class')).slice(0, 300)
    for (const name of classNames) {
      try {
        const bytes = await readEntry(fileMap.get(name)!)
        if (bytes.byteLength < 8) continue
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        if (view.getUint32(0) === 0xcafebabe) maxJava = Math.max(maxJava, view.getUint16(6) - 44)
      } catch {
        // Ignore malformed or encrypted class entries while deriving metadata.
      }
    }
  }
  return {
    mainClass: manifest['Main-Class'],
    javaMinVersion: maxJava > 0 ? `Java ${maxJava}` : undefined,
  }
}

function parseManifest(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  let current: string | undefined
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith(' ') && current) {
      result[current] += line.slice(1)
      continue
    }
    const separator = line.indexOf(':')
    if (separator <= 0) {
      current = undefined
      continue
    }
    current = line.slice(0, separator).trim()
    result[current] = line.slice(separator + 1).trim()
  }
  return result
}
