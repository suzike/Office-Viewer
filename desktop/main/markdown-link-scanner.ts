import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { findMarkdownWorkspaceDirectory } from './markdown-resource-service'

const MAX_REFERENCES = 500
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/
const LINK_DEFINITION_PATTERN = /^[ \t]{0,3}\[[^\]]*\]:[ \t]*\S/
const INLINE_REFERENCE_PATTERN = /(!?)\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|([^()\n]*))\)/g
const TRAILING_TITLE_PATTERN = /\s+(?:"[^"]*"|'[^']*'|\([^()]*\))\s*$/
const EXTERNAL_TARGET_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/|#)/i
const WINDOWS_ABSOLUTE_PATTERN = /^[a-z]:[\\/]/i

export interface MarkdownLinkReference {
  readonly kind: 'link' | 'image'
  /** Decoded relative path without fragment/query, as written in the document. */
  readonly target: string
  /** 1-based source line of the reference. */
  readonly line: number
}

/**
 * Collect inline relative link/image targets from a Markdown document. Fenced
 * code blocks, reference-style definitions, external URLs, anchors, absolute
 * paths and wiki links are skipped. Only relative targets (the kind produced
 * by drag-and-drop insertion and pasted images) are reported.
 */
export function scanMarkdownReferences(markdown: string): MarkdownLinkReference[] {
  const references: MarkdownLinkReference[] = []
  let fenceMarker = ''
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  for (let index = 0; index < lines.length && references.length < MAX_REFERENCES; index += 1) {
    const line = lines[index]
    const fence = line.match(FENCE_PATTERN)
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[1][0]
      else if (fence[1][0] === fenceMarker) fenceMarker = ''
      continue
    }
    if (fenceMarker || LINK_DEFINITION_PATTERN.test(line)) continue
    INLINE_REFERENCE_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = INLINE_REFERENCE_PATTERN.exec(line)) !== null) {
      const rawTarget = unwrapLinkTarget((match[2] ?? match[3] ?? '').trim())
      if (!rawTarget || EXTERNAL_TARGET_PATTERN.test(rawTarget) || WINDOWS_ABSOLUTE_PATTERN.test(rawTarget)) continue
      const withoutFragment = rawTarget.split('#')[0].split('?')[0].trim()
      if (!withoutFragment) continue
      references.push({
        kind: match[1] === '!' ? 'image' : 'link',
        target: decodeLinkTarget(withoutFragment),
        line: index + 1,
      })
      if (references.length >= MAX_REFERENCES) break
    }
  }
  return references
}

/**
 * Check which relative references point at files that exist neither relative
 * to the document directory nor relative to the Markdown workspace root (the
 * two resolution modes the viewer itself supports).
 */
export async function findMissingMarkdownReferences(
  documentPath: string,
  markdown: string,
): Promise<MarkdownLinkReference[]> {
  const references = scanMarkdownReferences(markdown)
  if (references.length === 0) return []
  const documentDirectory = dirname(documentPath)
  const workspaceDirectory = await findMarkdownWorkspaceDirectory(documentPath)
  const missing: MarkdownLinkReference[] = []
  for (const reference of references) {
    if (await pathExists(resolve(documentDirectory, reference.target))) continue
    if (workspaceDirectory !== documentDirectory && await pathExists(resolve(workspaceDirectory, reference.target))) continue
    missing.push(reference)
  }
  return missing
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

function unwrapLinkTarget(value: string): string {
  let target = value
  if (target.startsWith('<') && target.includes('>')) {
    target = target.slice(1, target.indexOf('>'))
  } else {
    target = target.replace(TRAILING_TITLE_PATTERN, '')
  }
  return target.replace(/\\([()])/g, '$1').trim()
}

function decodeLinkTarget(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
