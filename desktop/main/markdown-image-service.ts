import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import type { DesktopMarkdownImageResult, DesktopMarkdownPreferences } from '../shared/desktop-api'
import { findMarkdownWorkspaceDirectory } from './markdown-resource-service'

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

export async function saveMarkdownImage(
  documentPath: string,
  data: ArrayBuffer | Uint8Array,
  requestedExtension: string | undefined,
  preferences: DesktopMarkdownPreferences,
): Promise<DesktopMarkdownImageResult> {
  if (!/\.(?:md|markdown)$/i.test(documentPath)) throw new Error('Images can only be inserted into Markdown documents.')
  const bytes = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new RangeError('Markdown image must contain between 1 byte and 32 MB.')
  const extension = normalizeImageExtension(requestedExtension, bytes)
  const documentDirectory = await realpath(dirname(documentPath))
  const imageBaseDirectory = preferences.workspacePathAsImageBasePath
    ? await findMarkdownWorkspaceDirectory(documentPath)
    : documentDirectory
  const now = new Date()
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const variables: Record<string, string> = {
    workspaceDir: imageBaseDirectory.replace(/\\/g, '/'),
    fileName: parse(documentPath).name.replace(/\s/g, ''),
    now: String(now.getTime()),
    date,
    uuid: randomUUID().replace(/-/g, ''),
    ext: extension,
  }
  const template = preferences.pasterImgPath || 'image/${fileName}/${now}.${ext}'
  const expanded = template.replace(/\$\{(workspaceDir|fileName|now|date|uuid|ext)}/g, (_whole, name: string) => variables[name])
  const candidate = resolve(imageBaseDirectory, expanded.replace(/^\$\{workspaceDir}\/?/, ''))
  const pathFromBase = relative(imageBaseDirectory, candidate)
  if (!pathFromBase || pathFromBase === '..' || pathFromBase.startsWith(`..${sep}`) || isAbsolute(pathFromBase)) {
    throw new Error('Markdown image path must remain inside the document workspace.')
  }
  const parent = dirname(candidate)
  await mkdir(parent, { recursive: true })
  const realParent = await realpath(parent)
  const parentFromBase = relative(imageBaseDirectory, realParent)
  if (parentFromBase === '..' || parentFromBase.startsWith(`..${sep}`) || isAbsolute(parentFromBase)) {
    throw new Error('Markdown image directory resolves outside the document workspace.')
  }
  let target = candidate
  try {
    await stat(target)
    const parsed = parse(target)
    target = resolve(parsed.dir, `${parsed.name}-${randomUUID().slice(0, 8)}${parsed.ext}`)
  } catch {
    // The generated path is available.
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx' })
  await rename(temporary, target)
  const markdownPath = relative(imageBaseDirectory, target).split(sep).join('/')
  const label = basename(markdownPath, extname(markdownPath))
  return {
    markdown: `![${label}](${encodeMarkdownPath(markdownPath)})`,
    relativePath: markdownPath,
  }
}

function normalizeImageExtension(_requested: string | undefined, bytes: Buffer): string {
  const detected = detectImageExtension(bytes)
  if (!detected) throw new Error('Unsupported Markdown image type or invalid image contents.')
  const value = detected
  if (!ALLOWED_EXTENSIONS.has(value)) throw new Error('Unsupported Markdown image type.')
  return value === 'jpeg' ? 'jpg' : value
}

function detectImageExtension(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'bmp'
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'ico'
  const prefix = bytes.subarray(0, 1024).toString('utf8').trimStart()
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(prefix)) return 'svg'
  return undefined
}

function encodeMarkdownPath(value: string): string {
  return value.split('/').map((segment) => encodeURIComponent(segment).replace(/%20/g, ' ')).join('/')
}
