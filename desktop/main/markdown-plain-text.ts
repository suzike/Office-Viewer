const FRONT_MATTER_PATTERN = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*\n?/
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/
const HEADING_PATTERN = /^[ \t]{0,3}#{1,6}[ \t]+/
const HEADING_CLOSING_PATTERN = /[ \t]+#+[ \t]*$/
const SETEXT_UNDERLINE_PATTERN = /^[ \t]{0,3}=+[ \t]*$/
const THEMATIC_BREAK_PATTERN = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const BLOCKQUOTE_PATTERN = /^[ \t]{0,3}>[ \t]?/
const LIST_MARKER_PATTERN = /^[ \t]{0,6}(?:[-+*]|\d{1,9}[.)])[ \t]+/
const CHECKBOX_PATTERN = /^\[[ xX]\][ \t]+/
const LINK_DEFINITION_PATTERN = /^[ \t]{0,3}\[[^\]]*\]:[ \t]*\S+/
const TABLE_SEPARATOR_PATTERN = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/
const TABLE_ROW_PATTERN = /^[ \t]*\|[ \t]*\S[\s\S]*\|[ \t]*$/

export interface MarkdownPlainTextOptions {
  /** Keep YAML front-matter lines in the output (stripped by default). */
  readonly keepFrontMatter?: boolean
}

/**
 * Strip Markdown syntax (headings, emphasis, links, code fences, list markers,
 * tables, front-matter) and return readable plain text. Code fence contents are
 * kept verbatim; everything else is reduced to its textual payload.
 */
export function markdownToPlainText(markdown: string, options: MarkdownPlainTextOptions = {}): string {
  let source = markdown.replace(/\r\n/g, '\n')
  if (!options.keepFrontMatter) source = source.replace(FRONT_MATTER_PATTERN, '')
  const output: string[] = []
  let fenceMarker = ''
  for (let line of source.split('\n')) {
    const fence = line.match(FENCE_PATTERN)
    if (fence) {
      if (!fenceMarker) {
        fenceMarker = fence[1][0]
        continue
      }
      if (fence[1][0] === fenceMarker) {
        fenceMarker = ''
        continue
      }
    }
    if (fenceMarker) {
      output.push(line)
      continue
    }
    if (LINK_DEFINITION_PATTERN.test(line)) continue
    if (THEMATIC_BREAK_PATTERN.test(line)) continue
    if (SETEXT_UNDERLINE_PATTERN.test(line)) continue
    if (TABLE_SEPARATOR_PATTERN.test(line)) continue
    if (HEADING_PATTERN.test(line)) {
      line = line.replace(HEADING_PATTERN, '').replace(HEADING_CLOSING_PATTERN, '')
    }
    while (BLOCKQUOTE_PATTERN.test(line)) line = line.replace(BLOCKQUOTE_PATTERN, '')
    line = line.replace(LIST_MARKER_PATTERN, '').replace(CHECKBOX_PATTERN, '')
    if (TABLE_ROW_PATTERN.test(line)) {
      line = line.replace(/^[ \t]*\|[ \t]*/, '').replace(/[ \t]*\|[ \t]*$/, '').replace(/[ \t]*\|[ \t]*/g, '  ')
    }
    output.push(stripInlineMarkdown(line))
  }
  return output
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/___([^_]+)___/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\b_([^_\n]+)_\b/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/<[^>]+>/g, '')
}
