import { randomUUID } from 'node:crypto'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, parse } from 'node:path'
import { BrowserWindow } from 'electron'
import type { DesktopHtmlExportResult } from '../shared/desktop-api'

const MAX_HTML_BYTES = 64 * 1024 * 1024
const MAX_EXPORT_BYTES = 256 * 1024 * 1024
const SCREENSHOT_EXPORT_WIDTH = 1280
const MAX_SCREENSHOT_EXPORT_HEIGHT = 16_384

export class HtmlExportService {
  public async exportPdf(htmlPath: string): Promise<DesktopHtmlExportResult> {
    if (!/\.(?:html?|xhtml)$/i.test(htmlPath)) throw new Error('Only HTML documents can be exported.')
    const fileStat = await stat(htmlPath)
    if (!fileStat.isFile() || fileStat.size > MAX_HTML_BYTES) {
      throw new RangeError('HTML export input exceeds the 64 MB limit.')
    }
    const origin = parse(htmlPath)
    const target = join(origin.dir, `${origin.name}.pdf`)
    const window = createExportWindow()
    try {
      await window.loadFile(htmlPath)
      await settleExportWindow(window)
      const bytes = await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
      if (bytes.byteLength > MAX_EXPORT_BYTES) {
        throw new RangeError('HTML export exceeds the 256 MB limit.')
      }
      await atomicWrite(target, bytes)
    } finally {
      if (!window.isDestroyed()) window.destroy()
    }
    return { type: 'pdf', path: target }
  }

  public async exportImage(htmlPath: string): Promise<DesktopHtmlExportResult> {
    if (!/\.(?:html?|xhtml)$/i.test(htmlPath)) throw new Error('Only HTML documents can be exported.')
    const fileStat = await stat(htmlPath)
    if (!fileStat.isFile() || fileStat.size > MAX_HTML_BYTES) {
      throw new RangeError('HTML export input exceeds the 64 MB limit.')
    }
    const origin = parse(htmlPath)
    const target = join(origin.dir, `${origin.name}.png`)
    const window = createExportWindow(SCREENSHOT_EXPORT_WIDTH, 800)
    try {
      await window.loadFile(htmlPath)
      await settleExportWindow(window)
      const contentHeight = await window.webContents.executeJavaScript(`Math.ceil(Math.max(document.body?.scrollHeight??0,document.documentElement?.scrollHeight??0))`, true) as number
      const height = Math.max(200, Math.min(MAX_SCREENSHOT_EXPORT_HEIGHT, contentHeight))
      window.setContentSize(SCREENSHOT_EXPORT_WIDTH, height)
      // Give the resized hidden window a moment to relayout before capturing.
      await window.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 300))`, true)
      const image = await window.webContents.capturePage()
      const bytes = image.toPNG()
      if (bytes.byteLength > MAX_EXPORT_BYTES) {
        throw new RangeError('HTML export exceeds the 256 MB limit.')
      }
      await atomicWrite(target, bytes)
    } finally {
      if (!window.isDestroyed()) window.destroy()
    }
    return { type: 'png', path: target }
  }
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

async function settleExportWindow(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`Promise.race([
    Promise.all([
      document.fonts?.ready ?? Promise.resolve(),
      ...[...document.images].filter((image) => !image.complete).map((image) => new Promise((resolve) => { image.onload = image.onerror = resolve })),
    ]).then(() => new Promise((resolve) => setTimeout(resolve, 300))),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ])`, true)
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx' })
  if (extname(path)) await rm(path, { force: true })
  await rename(temporary, path)
}
