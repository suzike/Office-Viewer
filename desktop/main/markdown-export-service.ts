import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, parse, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow } from 'electron'
import type { DesktopMarkdownExportResult, DesktopMarkdownImageExportResult, DesktopMarkdownPreferences, DesktopMarkdownTextExportResult } from '../shared/desktop-api'
import { markdownToPlainText } from './markdown-plain-text'

const MarkdownIt = require('markdown-it') as typeof import('markdown-it')
const markdownItAnchor = require('markdown-it-anchor')
const markdownItCheckbox = require('markdown-it-checkbox')
const markdownItFrontMatter = require('markdown-it-front-matter')
const markdownItMark = require('markdown-it-mark')
const markdownItObsidianCallouts = require('markdown-it-obsidian-callouts')
const markdownItToc = require('markdown-it-toc-done-right')
const katex = require('katex') as typeof import('katex')
const htmlToDocx = require('vscode-html-to-docx') as (html: string, header: string, options: Record<string, unknown>, footer: string) => Promise<Blob>
const { parse: parseHtml } = require('node-html-parser') as typeof import('node-html-parser')

const MAX_MARKDOWN_CHARS = 8 * 1024 * 1024
const MAX_EXPORT_BYTES = 256 * 1024 * 1024
const IMAGE_EXPORT_WIDTH = 840
const MAX_IMAGE_EXPORT_HEIGHT = 16_384

export class MarkdownExportService {
  public constructor(private readonly applicationRoot: string) {}

  public async export(
    markdownPath: string,
    markdown: string,
    option: { readonly type: 'pdf' | 'html' | 'docx'; readonly withoutOutline?: boolean },
    preferences: DesktopMarkdownPreferences,
  ): Promise<DesktopMarkdownExportResult> {
    if (!/\.(?:md|markdown)$/i.test(markdownPath)) throw new Error('Only Markdown documents can be exported.')
    if (typeof markdown !== 'string' || markdown.length > MAX_MARKDOWN_CHARS) throw new RangeError('Markdown export input exceeds the 8 MB limit.')
    if (!['pdf', 'html', 'docx'].includes(option.type)) throw new Error('Unsupported Markdown export type.')
    const origin = parse(markdownPath)
    const target = join(origin.dir, `${origin.name}.${option.type}`)
    const html = await this.render(markdownPath, markdown, option)
    if (option.type === 'html') {
      await atomicWrite(target, Buffer.from(html, 'utf8'))
    } else if (option.type === 'docx') {
      const task = await htmlToDocx(await this.rasterizeDynamicContent(markdownPath, html), '', {}, '')
      const bytes = Buffer.from(await task.arrayBuffer())
      assertExportSize(bytes)
      await atomicWrite(target, bytes)
    } else {
      let bytes = await this.printPdf(markdownPath, html, preferences.pdfMarginTop)
      if (!option.withoutOutline) bytes = Buffer.from(await createPdfOutline(bytes, html))
      assertExportSize(bytes)
      await atomicWrite(target, bytes)
    }
    return { type: option.type, path: target }
  }

  public async exportText(
    markdownPath: string,
    markdown: string,
    option: { readonly keepFrontMatter?: boolean } = {},
  ): Promise<DesktopMarkdownTextExportResult> {
    if (!/\.(?:md|markdown)$/i.test(markdownPath)) throw new Error('Only Markdown documents can be exported.')
    if (typeof markdown !== 'string' || markdown.length > MAX_MARKDOWN_CHARS) throw new RangeError('Markdown export input exceeds the 8 MB limit.')
    const origin = parse(markdownPath)
    const target = join(origin.dir, `${origin.name}.txt`)
    await atomicWrite(target, Buffer.from(markdownToPlainText(markdown, option), 'utf8'))
    return { path: target }
  }

  public async print(markdownPath: string, markdown: string): Promise<void> {
    if (!/\.(?:md|markdown)$/i.test(markdownPath)) throw new Error('Only Markdown documents can be printed.')
    if (typeof markdown !== 'string' || markdown.length > MAX_MARKDOWN_CHARS) throw new RangeError('Markdown print input exceeds the 8 MB limit.')
    const html = await this.render(markdownPath, markdown, { type: 'pdf', withoutOutline: true })
    const temporary = join(dirname(markdownPath), `.${parse(markdownPath).name}-${randomUUID()}.print.html`)
    await writeFile(temporary, html, { flag: 'wx' })
    const window = createExportWindow()
    try {
      await loadExportHtml(window, temporary)
      await new Promise<void>((resolvePrint, rejectPrint) => {
        window.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
          if (success || /cancel/i.test(failureReason ?? '')) {
            resolvePrint()
          } else {
            rejectPrint(new Error(failureReason || 'The document could not be printed.'))
          }
        })
      })
    } finally {
      if (!window.isDestroyed()) window.destroy()
      await rm(temporary, { force: true })
    }
  }

  public async exportImage(markdownPath: string, markdown: string): Promise<DesktopMarkdownImageExportResult> {
    if (!/\.(?:md|markdown)$/i.test(markdownPath)) throw new Error('Only Markdown documents can be exported.')
    if (typeof markdown !== 'string' || markdown.length > MAX_MARKDOWN_CHARS) throw new RangeError('Markdown export input exceeds the 8 MB limit.')
    const origin = parse(markdownPath)
    const target = join(origin.dir, `${origin.name}.png`)
    const html = await this.render(markdownPath, markdown, { type: 'pdf', withoutOutline: true })
    const temporary = join(origin.dir, `.${origin.name}-${randomUUID()}.image.html`)
    await writeFile(temporary, html, { flag: 'wx' })
    const window = createExportWindow(IMAGE_EXPORT_WIDTH, 800)
    try {
      await loadExportHtml(window, temporary)
      await window.webContents.executeJavaScript(`Promise.race([Promise.all([...document.images].filter(image=>!image.complete).map(image=>new Promise(done=>{image.addEventListener('load',done,{once:true});image.addEventListener('error',done,{once:true})}))),new Promise(resolve=>setTimeout(resolve,10000))])`, true)
      const contentHeight = await window.webContents.executeJavaScript(`Math.ceil(Math.max(document.body?.scrollHeight??0,document.documentElement?.scrollHeight??0))`, true) as number
      const height = Math.max(200, Math.min(MAX_IMAGE_EXPORT_HEIGHT, contentHeight))
      window.setContentSize(IMAGE_EXPORT_WIDTH, height)
      // Give the resized hidden window a moment to relayout before capturing.
      await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,300))`, true)
      const image = await window.webContents.capturePage()
      const bytes = image.toPNG()
      assertExportSize(bytes)
      await atomicWrite(target, bytes)
    } finally {
      if (!window.isDestroyed()) window.destroy()
      await rm(temporary, { force: true })
    }
    return { path: target }
  }

  private async render(
    markdownPath: string,
    markdown: string,
    option: { readonly type: 'pdf' | 'html' | 'docx'; readonly withoutOutline?: boolean },
  ): Promise<string> {
    let input = markdown
    if (option.type === 'pdf' && !option.withoutOutline && !/\[toc]/i.test(input)) {
      const frontMatter = input.match(/^---[\s\S]*?\n---\s*\n?/)
      input = frontMatter ? `${frontMatter[0]}[toc]\n${input.slice(frontMatter[0].length)}` : `[toc]\n${input}`
    }
    const md = new MarkdownIt({ html: true, breaks: false, linkify: true })
      .use(markdownItFrontMatter, () => undefined)
      .use(markdownItCheckbox)
      .use(markdownItMark)
      .use(markdownItAnchor)
      .use(markdownItToc)
      .use(markdownItObsidianCallouts)
      .use(markdownItKatex)

    const originalFence = md.renderer.rules.fence
    md.renderer.rules.fence = ((tokens: any[], index: number, options: any, env: any, self: any) => {
      const token = tokens[index] as { info?: string; content?: string }
      if (token.info?.trim().toLowerCase() === 'mermaid') return `<div class="mermaid">${escapeHtml(token.content ?? '')}</div>`
      return originalFence ? originalFence(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
    }) as typeof md.renderer.rules.fence
    const originalImage = md.renderer.rules.image
    md.renderer.rules.image = ((tokens: any[], index: number, options: any, env: any, self: any) => {
      const token = tokens[index] as { attrIndex: (name: string) => number; attrs: [string, string][] }
      const sourceIndex = token.attrIndex('src')
      if (sourceIndex >= 0 && option.type !== 'html') token.attrs[sourceIndex][1] = resolveExportImage(markdownPath, token.attrs[sourceIndex][1])
      return originalImage ? originalImage(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
    }) as typeof md.renderer.rules.image

    const content = sanitizeGeneratedHtml(md.render(input))
    const [template, styles] = await Promise.all([
      readFile(resolve(this.applicationRoot, 'template', 'template', 'template.html'), 'utf8'),
      this.readStyles(option.type),
    ])
    let output = template
      .replace('{{{title}}}', escapeHtml(originTitle(markdownPath)))
      .replace('{{{style}}}', `<style>${styles}</style>`)
      .replace('{{{content}}}', content)
    if (content.includes('class="mermaid"')) {
      const mermaid = option.type === 'html'
        ? 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js'
        : pathToFileURL(resolve(this.applicationRoot, 'resource', 'markdown', 'dist', 'js', 'mermaid', 'mermaid.min.js')).href
      output = output.replace('</body>', `<script src="${mermaid}"></script><script>mermaid.initialize({startOnLoad:true,securityLevel:'strict'});</script></body>`)
    }
    return output
  }

  private async readStyles(type: 'pdf' | 'html' | 'docx'): Promise<string> {
    const styleRoot = resolve(this.applicationRoot, 'template', 'styles')
    const names = ['arduino-light.css', 'markdown.css', 'markdown-pdf.css']
    const baseStyles = (await Promise.all(names.map((name) => readFile(resolve(styleRoot, name), 'utf8')))).join('\n')
    const katexPath = resolve(this.applicationRoot, 'resource', 'markdown', 'dist', 'js', 'katex', 'katex.min.css')
    const katexStyles = rewriteKatexAssetUrls(await readFile(katexPath, 'utf8'), katexPath, type)
    return `${baseStyles}\n${katexStyles}`
  }

  private async rasterizeDynamicContent(markdownPath: string, html: string): Promise<string> {
    if (!/(?:class="mermaid"|class="[^"]*katex)/.test(html)) return html
    const temporary = join(dirname(markdownPath), `.${parse(markdownPath).name}-${randomUUID()}.docx.html`)
    await writeFile(temporary, html, { flag: 'wx' })
    const window = createExportWindow()
    try {
      await loadExportHtml(window, temporary)
      const count = await window.webContents.executeJavaScript(`(() => {
        const nodes = [...document.querySelectorAll('.mermaid, .katex-display, .katex')]
          .filter((node, index, all) => !node.classList.contains('katex') || !node.closest('.katex-display') || node.classList.contains('katex-display'));
        nodes.forEach((node, index) => node.dataset.officeExportId = String(index));
        return nodes.length;
      })()`, true) as number
      for (let index = 0; index < count; index += 1) {
        const rectangle = await window.webContents.executeJavaScript(`(() => {
          const node = document.querySelector('[data-office-export-id="${index}"]');
          if (!node) return null;
          node.scrollIntoView({block:'center',inline:'nearest'});
          const rect = node.getBoundingClientRect();
          return {x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)), width: Math.ceil(rect.width), height: Math.ceil(rect.height)};
        })()`, true) as { x: number; y: number; width: number; height: number } | null
        if (!rectangle || rectangle.width <= 0 || rectangle.height <= 0 || rectangle.width > 16000 || rectangle.height > 16000) continue
        const image = await window.webContents.capturePage(rectangle)
        const dataUrl = `data:image/png;base64,${image.toPNG().toString('base64')}`
        await window.webContents.executeJavaScript(`(() => {
          const node = document.querySelector('[data-office-export-id="${index}"]');
          if (!node) return;
          const image = document.createElement('img');
          image.src = ${JSON.stringify(dataUrl)};
          image.width = ${rectangle.width}; image.height = ${rectangle.height};
          image.alt = node.textContent || 'Markdown dynamic content';
          image.style.cssText = 'max-width:100%;height:auto;' + (node.classList.contains('katex') && !node.classList.contains('katex-display') ? 'display:inline-block;vertical-align:middle' : 'display:block;margin:1em auto');
          node.replaceWith(image);
        })()`, true)
      }
      return await window.webContents.executeJavaScript('document.documentElement.outerHTML', true) as string
    } finally {
      if (!window.isDestroyed()) window.destroy()
      await rm(temporary, { force: true })
    }
  }

  private async printPdf(markdownPath: string, html: string, marginTop: number): Promise<Buffer> {
    const temporary = join(dirname(markdownPath), `.${parse(markdownPath).name}-${randomUUID()}.export.html`)
    await writeFile(temporary, html, { flag: 'wx' })
    const window = createExportWindow()
    try {
      await loadExportHtml(window, temporary)
      return await window.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        // The extension setting is expressed in millimetres, while Electron's
        // printToPDF API expects inches.
        margins: { top: Math.max(0, Math.min(250, marginTop)) / 25.4, bottom: 0, left: 0, right: 0 },
      })
    } finally {
      if (!window.isDestroyed()) window.destroy()
      await rm(temporary, { force: true })
    }
  }
}

function markdownItKatex(md: any): void {
  md.inline.ruler.after('escape', 'math_inline', (state: any, silent: boolean) => {
    if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false
    const start = state.pos + 1
    let end = start
    while ((end = state.src.indexOf('$', end)) >= 0) {
      let slashCount = 0
      for (let index = end - 1; index >= 0 && state.src[index] === '\\'; index -= 1) slashCount += 1
      if (slashCount % 2 === 0) break
      end += 1
    }
    if (end < 0 || end === start) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.content = state.src.slice(start, end)
      token.markup = '$'
    }
    state.pos = end + 1
    return true
  })
  md.block.ruler.after('blockquote', 'math_block', (state: any, startLine: number, endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const maximum = state.eMarks[startLine]
    if (state.src.slice(start, start + 2) !== '$$') return false
    if (silent) return true
    let nextLine = startLine
    let content = state.src.slice(start + 2, maximum)
    if (content.trimEnd().endsWith('$$')) content = content.trimEnd().slice(0, -2)
    else {
      let closed = false
      while (++nextLine < endLine) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
        const lineEnd = state.eMarks[nextLine]
        const line = state.src.slice(lineStart, lineEnd)
        const close = line.lastIndexOf('$$')
        if (close >= 0) {
          content += `\n${line.slice(0, close)}`
          closed = true
          break
        }
        content += `\n${line}`
      }
      if (!closed) nextLine = endLine - 1
    }
    state.line = nextLine + 1
    const token = state.push('math_block', 'math', 0)
    token.block = true
    token.content = content.trim()
    token.map = [startLine, state.line]
    token.markup = '$$'
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.renderer.rules.math_inline = (tokens: any[], index: number) => katex.renderToString(tokens[index].content, { throwOnError: false, strict: false })
  md.renderer.rules.math_block = (tokens: any[], index: number) => `<div class="katex-display">${katex.renderToString(tokens[index].content, { displayMode: true, throwOnError: false, strict: false })}</div>\n`
}

function rewriteKatexAssetUrls(css: string, katexPath: string, type: 'pdf' | 'html' | 'docx'): string {
  return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, _quote, rawAsset: string) => {
    const asset = rawAsset.trim()
    if (/^(?:data:|https?:|file:|about:|#)/i.test(asset)) return match
    const normalized = asset.replace(/^\.\//, '')
    const href = type === 'html'
      ? `https://cdn.jsdelivr.net/npm/katex@0.16.2/dist/${normalized}`
      : pathToFileURL(resolve(dirname(katexPath), normalized)).href
    return `url("${href}")`
  })
}

function createExportWindow(width = 1200, height = 800): BrowserWindow {
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('file:')) event.preventDefault()
  })
  return window
}

async function loadExportHtml(window: BrowserWindow, path: string): Promise<void> {
  await window.loadFile(path)
  await window.webContents.executeJavaScript(`Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise(resolve => setTimeout(resolve, 10000))])`, true)
  await window.webContents.executeJavaScript(`new Promise(resolve => { const start=Date.now(); const done=()=>{ const nodes=[...document.querySelectorAll('.mermaid')]; if(!nodes.length||nodes.every(n=>n.querySelector('svg')||n.dataset.processed==='true')||Date.now()-start>10000) resolve(); else setTimeout(done,100) }; done() })`, true)
}

async function createPdfOutline(pdf: Uint8Array, html: string): Promise<Uint8Array> {
  const { PDFDocument, PDFDict, PDFHexString, PDFName, PDFNumber } = require('pdf-lib') as typeof import('pdf-lib')
  const document = await PDFDocument.load(pdf)
  const root = parseHtml(html)
  const items = root.querySelectorAll('.table-of-contents > ol > li')
  if (items.length === 0) return document.save()

  const destinations: Record<string, { dest: any; title?: string; child?: any[]; isLast?: boolean }> = {}
  for (const [, object] of (document.context as any).indirectObjects.entries()) {
    if (!(object instanceof PDFDict)) continue
    for (const [key, value] of (object as any).dict.entries()) {
      if ((key as any).encodedName === '/Dest' && typeof (value as any).encodedName === 'string') {
        destinations[(value as any).encodedName] = { dest: value }
      }
    }
  }

  const directChildren = (element: any, tagName: string) => element.childNodes.filter((node: any) => node?.rawTagName === tagName)
  const inflate = (nodes: any[]): any[] => nodes.flatMap((item, index) => {
    const anchor = directChildren(item, 'a')[0]
    if (!anchor) return []
    const fragment = decodeURIComponent((anchor.getAttribute('href') ?? '').replace(/^#/, ''))
    const key = `/${encodeURIComponent(fragment).replace(/%/g, '#25')}`
    const destination = destinations[key]
    if (!destination) return []
    const nested = directChildren(item, 'ol')[0]
    return [{
      ...destination,
      title: anchor.text.trim(),
      isLast: nodes.length === 1 || index === nodes.length - 1,
      child: nested ? inflate(directChildren(nested, 'li')) : undefined,
    }]
  })
  const outlineItems = inflate(items)
  if (outlineItems.length === 0) return document.save()

  const outlineRoot = document.context.nextRef()
  const build = (nodes: any[], parent: any): any[] => {
    const references = nodes.map(() => document.context.nextRef())
    nodes.forEach((node, index) => {
      const map = new Map<any, any>()
      map.set(PDFName.Title, PDFHexString.fromText(node.title))
      map.set(PDFName.Parent, parent)
      if (references.length > 1) map.set(PDFName.of(index === references.length - 1 ? 'Prev' : 'Next'), references[index === references.length - 1 ? index - 1 : index + 1])
      if (node.child?.length) {
        const children = build(node.child, references[index])
        map.set(PDFName.of('First'), children[0])
        map.set(PDFName.of('Last'), children.at(-1))
        map.set(PDFName.of('Count'), PDFNumber.of(children.length))
      }
      map.set(PDFName.of('Dest'), node.dest)
      document.context.assign(references[index], PDFDict.fromMapWithContext(map, document.context))
    })
    return references
  }
  const references = build(outlineItems, outlineRoot)
  const rootMap = new Map<any, any>()
  rootMap.set(PDFName.Type, PDFName.of('Outlines'))
  rootMap.set(PDFName.of('First'), references[0])
  rootMap.set(PDFName.of('Last'), references.at(-1))
  rootMap.set(PDFName.of('Count'), PDFNumber.of(references.length))
  document.catalog.set(PDFName.of('Outlines'), outlineRoot)
  document.context.assign(outlineRoot, PDFDict.fromMapWithContext(rootMap, document.context))
  return document.save()
}

function sanitizeGeneratedHtml(html: string): string {
  const root = parseHtml(`<div>${html}</div>`)
  root.querySelectorAll('script, iframe, object, embed, form, base, meta[http-equiv]').forEach((node) => node.remove())
  root.querySelectorAll('*').forEach((node) => {
    for (const [name, value] of Object.entries(node.attributes)) {
      if (/^on/i.test(name) || name.toLowerCase() === 'srcdoc') node.removeAttribute(name)
      else if (['href', 'src', 'xlink:href'].includes(name.toLowerCase()) && /^\s*(?:javascript|vbscript):/i.test(value)) node.removeAttribute(name)
    }
  })
  return root.querySelector('div')?.innerHTML ?? ''
}

function resolveExportImage(markdownPath: string, source: string): string {
  try {
    const decoded = decodeURIComponent(source).replace(/\\/g, '/')
    if (/^(?:https?:|data:|file:)/i.test(decoded)) return decoded
    const candidate = resolve(dirname(markdownPath), decoded)
    const fromDocument = relative(dirname(markdownPath), candidate)
    if (fromDocument.startsWith('..') || /^[a-z]:/i.test(fromDocument)) return ''
    return pathToFileURL(candidate).href
  } catch {
    return ''
  }
}

function originTitle(path: string): string {
  return parse(path).base
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function assertExportSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw new RangeError('Markdown export exceeds the 256 MB limit.')
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx' })
  if (extname(path)) await rm(path, { force: true })
  await rename(temporary, path)
}
