// Lightweight dependency-free HTML pretty-printer used by the desktop HTML viewer.
// It re-indents markup without altering attribute order, raw <script>/<style>/<pre>
// contents, or significant inline text.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'pre', 'textarea'])
const INLINE_TEXT_LIMIT = 120

export function formatHtmlText(source: string, indent = '  '): string {
  const tokens = source.match(/<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<\/[^>]*>|<[^>]*>|[^<]+/g)
  if (!tokens || tokens.length === 0) return source

  const lines: string[] = []
  let depth = 0
  const pad = () => indent.repeat(depth)

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (!token.startsWith('<')) {
      const text = token.replace(/\s+/g, ' ').trim()
      if (text) lines.push(pad() + text)
      continue
    }
    if (token.startsWith('<!--') || token.startsWith('<!') || token.startsWith('<?')) {
      lines.push(pad() + token.trim())
      continue
    }

    const closing = token.match(/^<\/\s*([\w:-]+)/)
    if (closing) {
      depth = Math.max(0, depth - 1)
      lines.push(pad() + token.trim())
      continue
    }

    const opening = token.match(/^<\s*([\w:-]+)/)
    if (!opening) {
      lines.push(pad() + token.trim())
      continue
    }
    const tag = opening[1].toLowerCase()
    const selfClosing = /\/>$/.test(token) || VOID_ELEMENTS.has(tag)

    if (!selfClosing && RAW_TEXT_ELEMENTS.has(tag)) {
      lines.push(pad() + token.trim())
      let content = ''
      let closeIndex = -1
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (new RegExp(`^</\\s*${tag}\\s*>$`, 'i').test(tokens[cursor].trim())) {
          closeIndex = cursor
          break
        }
        content += tokens[cursor]
      }
      const raw = content.replace(/^\s+/, '').replace(/\s+$/, '')
      if (raw) lines.push(raw)
      if (closeIndex >= 0) {
        lines.push(pad() + tokens[closeIndex].trim())
        index = closeIndex
      }
      continue
    }

    // Keep simple `<tag>text</tag>` runs on a single line.
    if (!selfClosing && index + 2 < tokens.length) {
      const inner = tokens[index + 1]
      const closer = tokens[index + 2]
      if (!inner.startsWith('<') && new RegExp(`^</\\s*${tag}\\s*>$`, 'i').test(closer.trim())) {
        const collapsed = inner.replace(/\s+/g, ' ').trim()
        if (collapsed.length <= INLINE_TEXT_LIMIT) {
          lines.push(pad() + token.trim() + collapsed + closer.trim())
          index += 2
          continue
        }
      }
    }

    lines.push(pad() + token.trim())
    if (!selfClosing) depth += 1
  }

  const formatted = lines.join('\n')
  return source.endsWith('\n') ? `${formatted}\n` : formatted
}
