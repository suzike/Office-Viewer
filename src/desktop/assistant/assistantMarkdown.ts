import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'

/**
 * Renders assistant responses as rich Markdown (headings, lists, tables,
 * code blocks with syntax highlighting, quotes...). Raw HTML is escaped and
 * javascript: links are rejected by markdown-it, so the output is safe for
 * dangerouslySetInnerHTML. Images are disabled: the desktop CSP only allows
 * self/data:/blob: sources, so remote images would be broken anyway — the
 * alt text is rendered inline instead.
 */
const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, language) {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value
      }
      return hljs.highlightAuto(code).value
    } catch {
      return ''
    }
  },
})

renderer.disable('image')

export function renderAssistantMarkdown(source: string): string {
  return renderer.render(source)
}
