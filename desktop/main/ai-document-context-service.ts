import { stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import type { DesktopAiDocumentContext } from '../shared/desktop-api'
import { isDesktopTextFile } from '../shared/text-language-routing'
import type { FileSessionManager } from './file-session-manager'

const MAX_EXTRACTION_CHARACTERS = 1_000_000
const MAX_CACHED_DOCUMENTS = 12
const MAX_CACHED_CHARACTERS = 2 * MAX_EXTRACTION_CHARACTERS
const DIRECT_TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'html', 'htm', 'xhtml', 'http', 'rest', 'csv', 'tsv',
  'json', 'jsonc', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'sql',
  'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'sh', 'ps1',
  'ini', 'properties', 'env', 'gitignore', 'dockerfile',
])

export class AiDocumentContextService {
  private readonly cache = new Map<string, CachedExtraction>()

  public constructor(private readonly sessions: FileSessionManager) {}

  public async extract(sessionId: string, characterLimit: number): Promise<DesktopAiDocumentContext> {
    const filePath = this.sessions.getPath(sessionId)
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath
    const extension = extname(filePath).slice(1).toLowerCase()
    const cacheKey = normalizeCachePath(filePath)
    const extracted = await this.getCachedExtraction(cacheKey, sessionId, filePath, fileName, extension)
    const clipped = clipContext(extracted.normalized, characterLimit)
    return {
      sessionId,
      fileName,
      filePath,
      format: extension || 'unknown',
      text: clipped.text,
      extractedCharacters: clipped.text.length,
      sourceCharacters: extracted.normalized.length,
      truncated: clipped.truncated || extracted.sourceWasClipped,
      strategy: extracted.strategy,
      warning: extracted.warning,
    }
  }

  private async getCachedExtraction(
    cacheKey: string,
    sessionId: string,
    filePath: string,
    fileName: string,
    extension: string,
  ): Promise<CachedDocument> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await stat(filePath)
      const fingerprint = fileFingerprint(before.mtimeMs, before.size)
      let cached = this.cache.get(cacheKey)
      if (!cached || cached.fingerprint !== fingerprint) {
        const promise = this.extractDocument(sessionId, fileName, extension)
        const created: CachedExtraction = { fingerprint, promise, characters: 0 }
        cached = created
        this.storeCacheEntry(cacheKey, created)
        void promise.then((document) => {
          if (this.cache.get(cacheKey) !== created) return
          created.characters = document.normalized.length
          this.touchCacheEntry(cacheKey, created)
          this.trimCache()
        }).catch(() => {
          if (this.cache.get(cacheKey) === created) this.cache.delete(cacheKey)
        })
      } else {
        this.touchCacheEntry(cacheKey, cached)
      }
      try {
        const document = await cached.promise
        const after = await stat(filePath)
        if (fileFingerprint(after.mtimeMs, after.size) === fingerprint) return document
        if (this.cache.get(cacheKey) === cached) this.cache.delete(cacheKey)
      } catch (reason) {
        if (this.cache.get(cacheKey) === cached) this.cache.delete(cacheKey)
        throw reason
      }
    }
    throw new Error('文档在上下文提取期间持续变化，请稍后重试。')
  }

  private storeCacheEntry(cacheKey: string, cached: CachedExtraction): void {
    this.cache.delete(cacheKey)
    this.cache.set(cacheKey, cached)
    this.trimCache()
  }

  private touchCacheEntry(cacheKey: string, cached: CachedExtraction): void {
    this.cache.delete(cacheKey)
    this.cache.set(cacheKey, cached)
  }

  private trimCache(): void {
    let characters = Array.from(this.cache.values()).reduce((total, cached) => total + cached.characters, 0)
    while (this.cache.size > MAX_CACHED_DOCUMENTS || characters > MAX_CACHED_CHARACTERS) {
      const oldest = this.cache.entries().next().value as [string, CachedExtraction] | undefined
      if (!oldest) break
      this.cache.delete(oldest[0])
      characters -= oldest[1].characters
    }
  }

  private async extractDocument(sessionId: string, fileName: string, extension: string): Promise<CachedDocument> {
    const bytes = new Uint8Array(await this.sessions.read(sessionId))
    let extracted: ExtractedDocument

    if (isDesktopTextFile(fileName, extension) || DIRECT_TEXT_EXTENSIONS.has(extension)) {
      extracted = { strategy: 'text', text: decodeText(bytes) }
    } else if (extension === 'docx' || extension === 'dotx') {
      extracted = { strategy: 'docx', text: await extractDocx(bytes) }
    } else if (extension === 'pptx' || extension === 'pptm') {
      extracted = { strategy: 'pptx', text: await extractPptx(bytes) }
    } else if (['xlsx', 'xlsm', 'xls', 'ods'].includes(extension)) {
      extracted = { strategy: 'xlsx', text: extractWorkbook(bytes) }
    } else if (extension === 'pdf') {
      const text = await extractPdf(bytes)
      extracted = text
        ? { strategy: 'pdf', text }
        : { strategy: 'pdf', text: `文件名：${fileName}\n格式：PDF\n文件大小：${bytes.byteLength} 字节`, warning: 'PDF 未包含可提取的文本层；扫描版内容需要 OCR 后才能参与问答。' }
    } else {
      extracted = {
        strategy: 'metadata',
        text: `文件名：${fileName}\n格式：${extension || '未知'}\n文件大小：${bytes.byteLength} 字节`,
        warning: '此二进制格式暂不支持可靠的文本提取；本次对话只包含文件元数据。',
      }
    }

    const normalized = normalizeExtractedText(extracted.text).slice(0, MAX_EXTRACTION_CHARACTERS)
    return {
      strategy: extracted.strategy,
      normalized,
      sourceWasClipped: extracted.text.length > MAX_EXTRACTION_CHARACTERS,
      warning: extracted.warning,
    }
  }
}

interface CachedExtraction {
  readonly fingerprint: string
  readonly promise: Promise<CachedDocument>
  characters: number
}

interface CachedDocument {
  readonly strategy: DesktopAiDocumentContext['strategy']
  readonly normalized: string
  readonly sourceWasClipped: boolean
  readonly warning?: string
}

interface ExtractedDocument {
  readonly strategy: DesktopAiDocumentContext['strategy']
  readonly text: string
  readonly warning?: string
}

function normalizeCachePath(filePath: string): string {
  const normalized = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function fileFingerprint(mtimeMs: number, size: number): string {
  return `${mtimeMs}:${size}`
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const archive = await JSZip.loadAsync(bytes)
  const document = archive.file('word/document.xml')
  if (!document) throw new Error('DOCX 主文档内容缺失。')
  const parts: string[] = []
  parts.push(xmlParagraphs(await document.async('string')))
  const notes = Object.keys(archive.files)
    .filter((name) => /^word\/(footnotes|endnotes|comments)\.xml$/i.test(name))
    .sort()
  for (const name of notes) {
    const file = archive.file(name)
    if (file) parts.push(xmlParagraphs(await file.async('string')))
  }
  return parts.filter(Boolean).join('\n\n')
}

async function extractPptx(bytes: Uint8Array): Promise<string> {
  const archive = await JSZip.loadAsync(bytes)
  const slides = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(naturalFileOrder)
  if (!slides.length) throw new Error('PPTX 幻灯片内容缺失。')
  const result: string[] = []
  for (let index = 0; index < slides.length; index += 1) {
    if (result.join('\n').length >= MAX_EXTRACTION_CHARACTERS) break
    const file = archive.file(slides[index])
    if (!file) continue
    const text = xmlTextRuns(await file.async('string'))
    result.push(`[幻灯片 ${index + 1}]\n${text}`)
  }
  return result.join('\n\n')
}

function extractWorkbook(bytes: Uint8Array): string {
  const workbook = XLSX.read(bytes, { type: 'array', cellText: true, cellDates: true, dense: true })
  const result: string[] = []
  for (const sheetName of workbook.SheetNames) {
    if (result.join('\n').length >= MAX_EXTRACTION_CHARACTERS) break
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
    result.push(`[工作表：${sheetName}]\n${csv}`)
  }
  return result.join('\n\n')
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  // TypeScript emits CommonJS for the Electron host. Keep this one ESM-only dependency
  // behind native import() without letting any user-controlled value reach the loader.
  const importEsm = Function('return import("pdfjs-dist/legacy/build/pdf.mjs")') as () => Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>
  const { getDocument } = await importEsm()
  const standardFontDataUrl = `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/')}/`
  const loadingTask = getDocument({ data: bytes.slice(), standardFontDataUrl })
  const document = await loadingTask.promise
  const pages: string[] = []
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (pages.join('\n').length >= MAX_EXTRACTION_CHARACTERS) break
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => 'str' in item ? item.str : '')
        .filter(Boolean)
        .join(' ')
      if (text.trim()) pages.push(`[PDF 第 ${pageNumber} 页]\n${text}`)
      page.cleanup()
    }
  } finally {
    await loadingTask.destroy()
  }
  return pages.join('\n\n')
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const source = bytes.subarray(2)
    const swapped = new Uint8Array(source.length)
    for (let index = 0; index + 1 < source.length; index += 2) {
      swapped[index] = source[index + 1]
      swapped[index + 1] = source[index]
    }
    return new TextDecoder('utf-16le').decode(swapped)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

function xmlParagraphs(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/gi, '\t')
    .replace(/<w:br\b[^>]*\/>/gi, '\n')
    .split(/<\/w:p>/i)
    .map(xmlTextRuns)
    .filter(Boolean)
    .join('\n')
}

function xmlTextRuns(xml: string): string {
  return decodeXmlEntities(Array.from(xml.matchAll(/<(?:w:t|a:t)\b[^>]*>([\s\S]*?)<\/(?:w:t|a:t)>/gi))
    .map((match) => match[1])
    .join(' '))
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function clipContext(value: string, limit: number): { text: string; truncated: boolean } {
  const safeLimit = Number.isInteger(limit) ? Math.max(8_000, Math.min(500_000, limit)) : 160_000
  if (value.length <= safeLimit) return { text: value, truncated: false }
  const marker = '\n\n……文档中间内容因上下文限制已省略……\n\n'
  const remaining = safeLimit - marker.length
  const headLength = Math.ceil(remaining * 0.72)
  return {
    text: `${value.slice(0, headLength)}${marker}${value.slice(value.length - (remaining - headLength))}`,
    truncated: true,
  }
}

function naturalFileOrder(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}
