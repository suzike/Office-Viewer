import SevenZip, { type SevenZipModule } from '7z-wasm'
import { createExtractorFromData, type FileHeader } from 'node-unrar-js'
import { basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Parser, type ReadEntry } from 'tar'
import type {
  DesktopArchiveEntry,
  DesktopArchiveExtractResult,
  DesktopArchiveInfo,
} from '../shared/desktop-api'
import {
  ARCHIVE_LIMITS,
  normalizeArchiveEntryName,
  prettyBytes,
  writeArchiveFiles,
} from './archive-service'

type NonZipKind = '7z' | 'rar' | 'tar' | 'tar.gz'

interface ArchiveItem {
  readonly path: string
  readonly size: number
  readonly compressedSize: number
  readonly isDirectory: boolean
  readonly modified?: string | null
  readonly encrypted?: boolean
  readonly isLink?: boolean
}

interface ParsedItems {
  readonly items: readonly ArchiveItem[]
  readonly files: readonly DesktopArchiveEntry[]
  readonly folderMap: Readonly<Record<string, DesktopArchiveEntry>>
  readonly fileNames: readonly string[]
  readonly encrypted: boolean
}

interface SevenZipEntry extends ArchiveItem {
  readonly attributes: string
}

interface SevenZipResult {
  readonly module: SevenZipModule
  readonly stdout: string
  readonly stderr: string
}

const TAR_OUTPUT_OVERHEAD = ARCHIVE_LIMITS.entries * 1024 + 1024 * 1024

export function supportsNonZipArchive(filePath: string): boolean {
  return detectArchiveKind(filePath) !== undefined
}

export async function inspectNonZipArchive(
  data: ArrayBuffer | Uint8Array,
  filePath: string,
  encoding = 'utf8',
  password?: string,
): Promise<DesktopArchiveInfo> {
  const bytes = toUint8Array(data)
  const kind = requireArchiveKind(filePath)
  const parsed = await inspectItems(bytes, kind, encoding, password)
  return {
    fileName: basename(filePath),
    files: parsed.files,
    folderMap: parsed.folderMap,
    encrypted: parsed.encrypted,
    encoding,
    extension: kind,
    size: prettyBytes(bytes.byteLength),
  }
}

export async function readNonZipArchiveEntry(
  data: ArrayBuffer | Uint8Array,
  filePath: string,
  entryName: string,
  password?: string,
  encoding = 'utf8',
): Promise<Uint8Array> {
  const bytes = toUint8Array(data)
  const kind = requireArchiveKind(filePath)
  const safeName = normalizeArchiveEntryName(entryName)
  if (kind === '7z') return readSevenZipEntry(bytes, safeName, password, encoding)
  if (kind === 'rar') return readRarEntry(bytes, safeName, password)
  const parsed = await parseTar(bytes, kind === 'tar.gz', safeName)
  const contents = parsed.contents.get(safeName)
  if (!contents) throw new Error(`Archive entry not found: ${safeName}`)
  return contents
}

export async function extractNonZipArchive(
  data: ArrayBuffer | Uint8Array,
  filePath: string,
  destination: string,
  password?: string,
  encoding = 'utf8',
): Promise<DesktopArchiveExtractResult> {
  const bytes = toUint8Array(data)
  const kind = requireArchiveKind(filePath)
  let files: readonly { entryName: string; contents: Uint8Array }[]
  if (kind === '7z') files = await extractSevenZipInMemory(bytes, password, encoding)
  else if (kind === 'rar') files = await extractRarInMemory(bytes, password)
  else {
    const parsed = await parseTar(bytes, kind === 'tar.gz', true)
    files = [...parsed.contents].map(([entryName, contents]) => ({ entryName, contents }))
  }
  return writeArchiveFiles(destination, files)
}

async function inspectItems(
  data: Uint8Array,
  kind: NonZipKind,
  encoding: string,
  password?: string,
): Promise<ParsedItems> {
  if (kind === '7z') return buildArchiveTree(await listSevenZip(data, password, encoding))
  if (kind === 'rar') return buildArchiveTree(await listRar(data, password))
  const parsed = await parseTar(data, kind === 'tar.gz')
  return buildArchiveTree(parsed.items)
}

function detectArchiveKind(filePath: string): NonZipKind | undefined {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  if (lower.endsWith('.7z')) return '7z'
  if (lower.endsWith('.rar')) return 'rar'
  if (lower.endsWith('.tar')) return 'tar'
  return undefined
}

function requireArchiveKind(filePath: string): NonZipKind {
  const kind = detectArchiveKind(filePath)
  if (!kind) throw new Error('This archive format is not supported by the desktop archive backend.')
  return kind
}

function buildArchiveTree(rawItems: readonly ArchiveItem[]): ParsedItems {
  if (rawItems.length > ARCHIVE_LIMITS.entries) {
    throw new RangeError(`Archive contains more than ${ARCHIVE_LIMITS.entries} entries.`)
  }

  const items: ArchiveItem[] = []
  const names = new Map<string, { readonly name: string; readonly directory: boolean }>()
  let totalBytes = 0
  let encrypted = false
  for (const raw of rawItems) {
    const path = normalizeArchiveEntryName(raw.path)
    if (raw.isLink) throw new Error(`Symbolic-link archive entries are not supported: ${path}`)
    if (!Number.isSafeInteger(raw.size) || raw.size < 0 || !Number.isSafeInteger(raw.compressedSize) || raw.compressedSize < 0) {
      throw new Error(`Archive entry has an invalid size: ${path}`)
    }
    if (raw.size > ARCHIVE_LIMITS.entryBytes) throw new RangeError(`Archive entry is too large: ${path}`)
    if (raw.size > 1024 * 1024 && raw.size / Math.max(1, raw.compressedSize) > ARCHIVE_LIMITS.compressionRatio) {
      throw new RangeError(`Suspicious compression ratio for archive entry: ${path}`)
    }
    const folded = path.toLocaleLowerCase('en-US')
    if (names.has(folded)) throw new Error(`Archive contains a duplicate Windows path: ${path}`)
    names.set(folded, { name: path, directory: raw.isDirectory })
    if (!raw.isDirectory) {
      totalBytes += raw.size
      if (totalBytes > ARCHIVE_LIMITS.totalBytes) throw new RangeError('Archive expands beyond the total size limit.')
    }
    encrypted ||= Boolean(raw.encrypted)
    items.push({ ...raw, path })
  }

  for (const item of items) {
    const parts = item.path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join('/').toLocaleLowerCase('en-US')
      const declared = names.get(ancestor)
      if (declared && !declared.directory) {
        throw new Error(`Archive path uses a file as a directory: ${item.path}`)
      }
    }
  }

  const files: DesktopArchiveEntry[] = []
  const folderMap: Record<string, DesktopArchiveEntry> = {}
  const emitted = new Set<string>()
  const pushEntry = (entry: DesktopArchiveEntry) => {
    const entryName = entry.entryName!
    if (emitted.has(entryName)) return
    const separator = entryName.lastIndexOf('/')
    if (separator < 0) files.push(entry)
    else {
      const parentPath = entryName.slice(0, separator)
      if (!folderMap[parentPath]) {
        const parent: DesktopArchiveEntry = {
          name: parentPath.slice(parentPath.lastIndexOf('/') + 1),
          entryName: parentPath,
          isDirectory: true,
          children: [],
        }
        folderMap[parentPath] = parent
        pushEntry(parent)
      }
      ;(folderMap[parentPath].children as DesktopArchiveEntry[]).push(entry)
    }
    emitted.add(entryName)
  }

  for (const item of items) {
    const entry: DesktopArchiveEntry = {
      name: item.path.slice(item.path.lastIndexOf('/') + 1),
      entryName: item.path,
      isDirectory: item.isDirectory,
      fileSize: prettyBytes(item.size),
      fileSizeOrigin: item.size,
      compressedSize: prettyBytes(item.compressedSize),
      compressedSizeOrigin: item.compressedSize,
      modifyDateTime: item.modified ?? null,
      encrypted: item.encrypted,
      ...(item.isDirectory ? { children: folderMap[item.path]?.children ?? [] } : {}),
    }
    if (item.isDirectory && folderMap[item.path]) {
      const existing = folderMap[item.path]
      folderMap[item.path] = { ...entry, children: existing.children }
      if (emitted.has(item.path)) continue
    } else if (item.isDirectory) folderMap[item.path] = entry
    pushEntry(folderMap[item.path] ?? entry)
  }

  const sort = (a: DesktopArchiveEntry, b: DesktopArchiveEntry) => {
    if (Boolean(a.isDirectory) !== Boolean(b.isDirectory)) return a.isDirectory ? -1 : 1
    return (a.name ?? '').localeCompare(b.name ?? '')
  }
  files.sort(sort)
  for (const folder of Object.values(folderMap)) (folder.children as DesktopArchiveEntry[]).sort(sort)
  return {
    items,
    files,
    folderMap,
    fileNames: items.filter((item) => !item.isDirectory).map((item) => item.path),
    encrypted,
  }
}

async function listSevenZip(data: Uint8Array, password?: string, encoding = 'utf8'): Promise<SevenZipEntry[]> {
  const result = await runSevenZip(data, [
    'l', '-slt', '-ba', ...sevenZipCharsetArgs(encoding), ...(password ? [`-p${password}`] : []), 'archive.7z',
  ], encoding)
  const entries: SevenZipEntry[] = []
  for (const block of result.stdout.split(/\r?\n(?=Path = )/)) {
    const info: Record<string, string> = {}
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^([^=]+) = (.*)$/)
      if (match) info[match[1].trim()] = match[2].trim()
    }
    if (!info.Path) continue
    const path = info.Path.replace(/\\/g, '/')
    const attributes = info.Attributes ?? ''
    const isDirectory = info.Folder === '+' || path.endsWith('/') || /^D(?:\s|$)/.test(attributes)
    if (!isDirectory && info.Size === undefined) continue
    const size = Number(info.Size ?? 0)
    const compressedSize = Number(info['Packed Size'] ?? info.Size ?? 0)
    entries.push({
      path,
      size,
      compressedSize,
      isDirectory,
      modified: info.Modified ?? null,
      encrypted: info.Encrypted === '+',
      attributes,
      isLink: Boolean(info['Symbolic Link'] || info['Hard Link']) || /^l/i.test(attributes) || /reparse/i.test(attributes),
    })
  }
  if (entries.length === 0) throw new Error('Invalid or damaged 7z archive: no archive entries were found.')
  return entries
}

async function readSevenZipEntry(
  data: Uint8Array,
  entryName: string,
  password?: string,
  encoding = 'utf8',
): Promise<Uint8Array> {
  const entries = buildArchiveTree(await listSevenZip(data, password, encoding))
  if (!entries.fileNames.includes(entryName)) throw new Error(`Archive entry not found: ${entryName}`)
  const files = await extractSevenZipInMemory(data, password, encoding, [entryName])
  return files[0].contents
}

async function extractSevenZipInMemory(
  data: Uint8Array,
  password?: string,
  encoding = 'utf8',
  selected?: readonly string[],
): Promise<readonly { entryName: string; contents: Uint8Array }[]> {
  const parsed = buildArchiveTree(await listSevenZip(data, password, encoding))
  const names = selected?.map(normalizeArchiveEntryName) ?? parsed.fileNames
  for (const name of names) if (!parsed.fileNames.includes(name)) throw new Error(`Archive entry not found: ${name}`)
  const result = await runSevenZip(data, [
    'x', '-y', '-aoa', ...sevenZipCharsetArgs(encoding), ...(password ? [`-p${password}`] : []), '-oout', 'archive.7z', ...names,
  ], encoding, true)
  let totalBytes = 0
  return names.map((entryName) => {
    const virtualPath = `out/${entryName}`
    const stat = result.module.FS.lstat(virtualPath)
    if (!result.module.FS.isFile(stat.mode) || result.module.FS.isLink(stat.mode)) {
      throw new Error(`Archive entry did not extract as a regular file: ${entryName}`)
    }
    const contents = result.module.FS.readFile(virtualPath)
    if (contents.byteLength > ARCHIVE_LIMITS.entryBytes) throw new RangeError(`Archive entry is too large: ${entryName}`)
    totalBytes += contents.byteLength
    if (totalBytes > ARCHIVE_LIMITS.totalBytes) throw new RangeError('Archive expands beyond the total size limit.')
    return { entryName, contents }
  })
}

async function runSevenZip(
  data: Uint8Array,
  args: string[],
  encoding: string,
  createOutput = false,
): Promise<SevenZipResult> {
  const stdoutBytes: number[] = []
  const stderrBytes: number[] = []
  const module = await SevenZip({
    stdout: (charCode) => stdoutBytes.push(charCode),
    stderr: (charCode) => stderrBytes.push(charCode),
    quit: (_code, status) => { throw status },
  })
  module.FS.writeFile('archive.7z', data)
  if (createOutput) module.FS.mkdir('out')
  const previousExitCode = process.exitCode
  try {
    module.callMain(args)
  } catch (error) {
    const stderr = decodeSevenZipOutput(stderrBytes, encoding).trim()
    const stdout = decodeSevenZipOutput(stdoutBytes, encoding).trim()
    const message = stderr || stdout || (error instanceof Error ? error.message : String(error))
    if (/password|encrypted|headers error/i.test(message)) throw new Error('Incorrect archive password.')
    throw new Error(`Invalid or damaged 7z archive: ${message}`)
  } finally {
    process.exitCode = previousExitCode
  }
  const stdout = decodeSevenZipOutput(stdoutBytes, encoding)
  const stderr = decodeSevenZipOutput(stderrBytes, encoding)
  if (/\bERROR\b|Can not open|Unexpected end/i.test(stderr)) throw new Error(`Invalid or damaged 7z archive: ${stderr.trim()}`)
  return { module, stdout, stderr }
}

function sevenZipCharsetArgs(encoding: string): string[] {
  return !encoding || encoding.toLowerCase() === 'utf8'
    ? ['-sccUTF-8', '-scsUTF-8']
    : ['-sccUTF-8', '-scsWIN']
}

function decodeSevenZipOutput(bytes: readonly number[], encoding: string): string {
  const buffer = Buffer.from(bytes)
  return !encoding || encoding.toLowerCase() === 'utf8' ? buffer.toString('utf8') : buffer.toString('latin1')
}

async function listRar(data: Uint8Array, password?: string): Promise<ArchiveItem[]> {
  try {
    const extractor = await createExtractorFromData({ data: exactArrayBuffer(data), password })
    const list = extractor.getFileList()
    const headers = [...list.fileHeaders]
    if (headers.length === 0) throw new Error('no archive entries were found')
    return headers.map(rarHeaderToItem)
  } catch (error) {
    throw normalizeRarError(error)
  }
}

function rarHeaderToItem(header: FileHeader): ArchiveItem {
  return {
    path: header.name.replace(/\\/g, '/'),
    size: header.unpSize,
    compressedSize: header.packSize,
    isDirectory: header.flags.directory,
    modified: header.time || null,
    encrypted: header.flags.encrypted,
  }
}

async function readRarEntry(data: Uint8Array, entryName: string, password?: string): Promise<Uint8Array> {
  const files = await extractRarInMemory(data, password, [entryName])
  if (!files[0]) throw new Error(`Archive entry not found: ${entryName}`)
  return files[0].contents
}

async function extractRarInMemory(
  data: Uint8Array,
  password?: string,
  selected?: readonly string[],
): Promise<readonly { entryName: string; contents: Uint8Array }[]> {
  try {
    const listed = buildArchiveTree(await listRar(data, password))
    const names = selected?.map(normalizeArchiveEntryName) ?? listed.fileNames
    for (const name of names) if (!listed.fileNames.includes(name)) throw new Error(`Archive entry not found: ${name}`)
    const extractor = await createExtractorFromData({ data: exactArrayBuffer(data), password })
    const extracted = extractor.extract({ files: [...names], password })
    const result: { entryName: string; contents: Uint8Array }[] = []
    let totalBytes = 0
    for (const file of extracted.files) {
      if (!file.extraction || file.fileHeader.flags.directory) continue
      const entryName = normalizeArchiveEntryName(file.fileHeader.name)
      if (!names.includes(entryName)) continue
      if (file.extraction.byteLength > ARCHIVE_LIMITS.entryBytes) throw new RangeError(`Archive entry is too large: ${entryName}`)
      totalBytes += file.extraction.byteLength
      if (totalBytes > ARCHIVE_LIMITS.totalBytes) throw new RangeError('Archive expands beyond the total size limit.')
      result.push({ entryName, contents: file.extraction })
    }
    if (result.length !== names.length) throw new Error('One or more RAR entries could not be extracted.')
    return result
  } catch (error) {
    throw normalizeRarError(error)
  }
}

function normalizeRarError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/password/i.test(message)) return new Error('Incorrect archive password.')
  if (/Archive entry not found|too large|could not be extracted/.test(message)) return error as Error
  return new Error(`Invalid or damaged RAR archive: ${message}`)
}

async function parseTar(
  source: Uint8Array,
  gzip: boolean,
  capture?: string | true,
): Promise<{ readonly items: readonly ArchiveItem[]; readonly contents: ReadonlyMap<string, Uint8Array> }> {
  let data: Buffer
  try {
    data = gzip
      ? gunzipSync(source, { maxOutputLength: ARCHIVE_LIMITS.totalBytes + TAR_OUTPUT_OVERHEAD })
      : Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  } catch (error) {
    throw new Error(`Invalid or damaged compressed TAR archive: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (gzip && data.byteLength > 1024 * 1024 && data.byteLength / Math.max(1, source.byteLength) > ARCHIVE_LIMITS.compressionRatio) {
    throw new RangeError('Suspicious compression ratio for compressed TAR archive.')
  }

  return new Promise((resolve, reject) => {
    const items: ArchiveItem[] = []
    const contents = new Map<string, Uint8Array>()
    let failed = false
    const fail = (reason: unknown) => {
      if (failed) return
      failed = true
      reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
    const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024 })
    parser.on('entry', (entry: ReadEntry) => {
      try {
        const entryName = normalizeArchiveEntryName(entry.path)
        const isDirectory = entry.type === 'Directory' || entry.type === 'GNUDumpDir'
        const isFile = entry.type === 'File' || entry.type === 'OldFile' || entry.type === 'ContiguousFile'
        if (!isFile && !isDirectory) {
          entry.resume()
          fail(new Error(`Unsupported TAR entry type ${entry.type}: ${entryName}`))
          parser.abort(new Error(`Unsupported TAR entry type ${entry.type}: ${entryName}`))
          return
        }
        const size = Number(entry.size ?? 0)
        items.push({
          path: entryName,
          size,
          compressedSize: size,
          isDirectory,
          modified: entry.mtime ? formatTarDate(entry.mtime) : null,
          isLink: Boolean(entry.linkpath),
        })
        const shouldCapture = isFile && (capture === true || capture === entryName)
        if (!shouldCapture) {
          entry.resume()
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        entry.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > ARCHIVE_LIMITS.entryBytes) {
            fail(new RangeError(`Archive entry is too large: ${entryName}`))
            parser.abort(new RangeError(`Archive entry is too large: ${entryName}`))
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        entry.on('end', () => contents.set(entryName, Buffer.concat(chunks)))
      } catch (error) {
        entry.resume()
        fail(error)
        parser.abort(error as Error)
      }
    })
    parser.on('error', fail)
    parser.on('end', () => {
      if (failed) return
      try {
        if (items.length === 0) throw new Error('Invalid or damaged TAR archive: no archive entries were found.')
        const validated = buildArchiveTree(items)
        if (typeof capture === 'string' && !validated.fileNames.includes(capture)) {
          throw new Error(`Archive entry not found: ${capture}`)
        }
        resolve({ items: validated.items, contents })
      } catch (error) {
        fail(error)
      }
    })
    try {
      parser.end(data)
    } catch (error) {
      fail(new Error(`Invalid or damaged TAR archive: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
}

function formatTarDate(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}
