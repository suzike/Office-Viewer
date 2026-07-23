// Lightweight dependency-free HTML validator used by the desktop HTML viewer.
// It reports unclosed/unmatched tags, duplicate id attributes and deprecated
// elements with 1-based source lines so the viewer can jump to the issue.

export type HtmlValidationRule = 'unclosed-tag' | 'unmatched-close' | 'duplicate-id' | 'deprecated-tag'

export interface HtmlValidationIssue {
  readonly line: number
  readonly rule: HtmlValidationRule
  readonly message: string
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])
const DEPRECATED_ELEMENTS = new Set([
  'acronym', 'applet', 'basefont', 'big', 'center', 'dir', 'font', 'frame',
  'frameset', 'isindex', 'marquee', 'noframes', 'strike', 'tt',
])
// Elements whose end tag may be omitted; opening one implicitly closes the
// listed siblings currently on top of the stack.
const IMPLIED_CLOSERS: Readonly<Record<string, readonly string[]>> = {
  p: ['p'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
  thead: ['tbody', 'tfoot'],
  tbody: ['tbody', 'tfoot'],
  tfoot: ['tbody'],
}
// Elements that are implicitly closed by an ancestor's end tag (or EOF), so
// truncating them is not reported as an error.
const IMPLICITLY_CLOSED = new Set([
  'p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'option',
])

const MAX_ISSUES = 500

export function validateHtmlDocument(source: string): HtmlValidationIssue[] {
  const issues: HtmlValidationIssue[] = []
  const stack: { name: string; line: number }[] = []
  const ids = new Map<string, number>()
  let index = 0
  let line = 1

  const advanceTo = (position: number) => {
    for (; index < position; index += 1) {
      if (source.charCodeAt(index) === 10) line += 1
    }
  }
  const report = (issueLine: number, rule: HtmlValidationRule, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ line: issueLine, rule, message })
  }

  const length = source.length
  while (index < length && issues.length < MAX_ISSUES) {
    const open = source.indexOf('<', index)
    if (open < 0) break
    advanceTo(open)
    const tagLine = line

    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4)
      advanceTo(close < 0 ? length : close + 3)
      continue
    }
    const rest = source.slice(open)
    const tagMatch = /^<\/?\s*([a-zA-Z][\w:-]*)[^>]*?(\/?)>/.exec(rest)
    if (!tagMatch || tagMatch[0].startsWith('<!') || tagMatch[0].startsWith('<?')) {
      // Doctype, processing instruction or a stray '<': skip to the next '>'.
      const close = source.indexOf('>', open + 1)
      advanceTo(close < 0 ? length : close + 1)
      continue
    }

    const [token, rawName, selfCloseSlash] = tagMatch
    const name = rawName.toLowerCase()
    advanceTo(open + token.length)
    const closing = token.startsWith('</')

    if (closing) {
      const top = stack.at(-1)
      if (top?.name === name) {
        stack.pop()
      } else {
        const at = stack.map((entry) => entry.name).lastIndexOf(name)
        if (at < 0) {
          report(tagLine, 'unmatched-close', `闭合标签 </${name}> 没有匹配的开始标签`)
        } else {
          for (let i = stack.length - 1; i > at; i -= 1) {
            const entry = stack[i]!
            if (!IMPLICITLY_CLOSED.has(entry.name)) {
              report(entry.line, 'unclosed-tag', `标签 <${entry.name}> 未闭合（被 </${name}> 截断）`)
            }
          }
          stack.length = at
        }
      }
      continue
    }

    if (DEPRECATED_ELEMENTS.has(name)) {
      report(tagLine, 'deprecated-tag', `<${name}> 是已弃用的标签`)
    }
    const idMatch = /[\s/]id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(token)
    const id = idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3]
    if (id) {
      if (ids.has(id)) {
        report(tagLine, 'duplicate-id', `重复的 id "${id}"（首次出现在第 ${ids.get(id)} 行）`)
      } else {
        ids.set(id, tagLine)
      }
    }

    if (selfCloseSlash || VOID_ELEMENTS.has(name)) continue

    const impliedSet = IMPLIED_CLOSERS[name]
    if (impliedSet) {
      while (stack.length > 0 && impliedSet.includes(stack.at(-1)!.name)) stack.pop()
    }
    stack.push({ name, line: tagLine })

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeMatch = new RegExp(`</${name}\\s*>`, 'i').exec(source.slice(index))
      advanceTo(closeMatch ? index + closeMatch.index + closeMatch[0].length : length)
      stack.pop()
    }
  }

  for (const entry of stack) {
    if (!IMPLICITLY_CLOSED.has(entry.name)) {
      report(entry.line, 'unclosed-tag', `标签 <${entry.name}> 未闭合`)
    }
  }
  return issues
}
