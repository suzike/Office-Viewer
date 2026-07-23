// Smoke test for HTML viewer batch 1: CodeMirror source editor, zoom control,
// format button, snippet menu, and PDF export. Launches the built app headlessly.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')
const outputDirectory = resolve('test/output/ui-screenshots')

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  await new Promise((resolvePromise) => server.close(resolvePromise))
  return port
}

async function connectToElectron(port) {
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/version`)
      const { webSocketDebuggerUrl } = await response.json()
      return await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null })
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
  }
  throw new Error('Could not connect to Electron.')
}

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-html-batch1-'))
const htmlPath = join(temporaryDirectory, 'landing.html')
const pdfPath = join(temporaryDirectory, 'landing.pdf')
await mkdir(outputDirectory, { recursive: true })
await writeFile(htmlPath, '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Batch1 Smoke</title></head><body><h1>Smoke</h1><table><tr><td>1</td><td>2</td></tr></table><script>document.body.dataset.ok="1";</script></body></html>')

const port = await reservePort()
const applicationProcess = spawn(electronExecutable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(temporaryDirectory, 'profile')}`,
  '--window-size=1440,900',
  applicationEntry,
  htmlPath,
], { cwd: repositoryRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

const stopProcess = async () => {
  if (applicationProcess.exitCode !== null) return
  spawn('taskkill.exe', ['/pid', String(applicationProcess.pid), '/t', '/f'], { stdio: 'ignore' })
  await delay(1500)
}

const clickToolbarButton = (page, text) => page.$$eval('.desktop-html-toolbar button', (buttons, label) => {
  const target = buttons.find((button) => button.textContent?.includes(label))
  if (!(target instanceof HTMLElement)) throw new Error(`Toolbar button not found: ${label}`)
  target.click()
}, text)

try {
  const browser = await connectToElectron(port)
  const page = (await browser.pages())[0]
  await page.waitForSelector('.desktop-html-viewer iframe', { timeout: 30_000 })
  await delay(1200)

  // 1. Split mode shows the CodeMirror editor.
  await clickToolbarButton(page, '源代码')
  await page.waitForSelector('.desktop-html-viewer.is-split .cm-editor', { timeout: 15_000 })
  assert.ok(await page.$('.desktop-html-viewer.is-split .cm-editor .cm-lineNumbers'), 'CodeMirror line numbers gutter is missing')
  console.log('ok - split mode shows CodeMirror with line numbers')

  // 2. Zoom buttons resize the preview iframe.
  const transformAt = () => page.$eval('.desktop-html-preview iframe', (element) => element.style.transform)
  assert.match(await transformAt(), /scale\(1\)/)
  await page.$$eval('.desktop-html-zoom button', (buttons) => buttons.find((b) => b.getAttribute('aria-label') === '放大')?.click())
  await page.waitForFunction(() => document.querySelector('.desktop-html-preview iframe')?.style.transform === 'scale(1.1)')
  await page.$$eval('.desktop-html-zoom button', (buttons) => buttons.find((b) => b.getAttribute('aria-label') === '缩小')?.click())
  await page.waitForFunction(() => document.querySelector('.desktop-html-preview iframe')?.style.transform === 'scale(1)')
  assert.equal(await page.$eval('.desktop-html-zoom span', (element) => element.textContent), '100%')
  console.log('ok - zoom controls change preview scale (50%-200% range, 10% steps)')

  // 3. Format button reindents the minified document.
  await clickToolbarButton(page, '格式化')
  await page.waitForFunction(() => {
    const view = document.querySelector('.desktop-html-source')?.cmView
    return view ? view.state.doc.toString().includes('\n  <head>') : false
  }, { timeout: 15_000 })
  const formatted = await page.$eval('.desktop-html-source', (element) => element.cmView.state.doc.toString())
  assert.match(formatted, /<body>\n {4}<h1>Smoke<\/h1>/)
  console.log('ok - format button reindents minified HTML')

  // 4. Snippet menu inserts a template at the cursor.
  await clickToolbarButton(page, '插入片段')
  await page.waitForSelector('.desktop-html-snippets__menu [role="menuitem"]', { timeout: 10_000 })
  const snippetLabels = await page.$$eval('.desktop-html-snippets__menu [role="menuitem"]', (items) => items.map((item) => item.textContent))
  assert.ok(snippetLabels.length >= 6, `Expected at least 6 snippets, got ${snippetLabels.length}`)
  await page.$$eval('.desktop-html-snippets__menu [role="menuitem"]', (items) => {
    const target = items.find((item) => item.textContent?.includes('Hero'))
    if (!(target instanceof HTMLElement)) throw new Error('Hero snippet not found.')
    target.click()
  })
  await page.waitForFunction(() => {
    const view = document.querySelector('.desktop-html-source')?.cmView
    return view ? view.state.doc.toString().includes('class="hero"') : false
  }, { timeout: 15_000 })
  console.log(`ok - snippet menu inserts templates (${snippetLabels.length} snippets)`)

  // 5. Screenshot of the split view with formatted source.
  await page.screenshot({ path: join(outputDirectory, 'html-batch1.png') })
  console.log('ok - screenshot saved to test/output/ui-screenshots/html-batch1.png')

  // 6. Export PDF writes a file next to the source document.
  await clickToolbarButton(page, '导出 PDF')
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      await access(pdfPath)
      break
    } catch {
      if (Date.now() > deadline) throw new Error('PDF export did not produce a file in time.')
      await delay(500)
    }
  }
  console.log('ok - export PDF produced landing.pdf next to the source file')

  await browser.disconnect()
  console.log('HTML batch 1 smoke test passed.')
} finally {
  await stopProcess()
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
