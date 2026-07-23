// Smoke test for Markdown batch 1 features: TOC toolbar button, word-count chip,
// long-image PNG export. Print is excluded (it opens a blocking system dialog).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-markdown-batch1-'))
const markdownPath = join(temporaryDirectory, 'batch1-note.md')
await mkdir(outputDirectory, { recursive: true })
await writeFile(markdownPath, [
  '# Batch One Heading',
  '',
  '一些中文内容用于统计字数。Some English words for the counter.',
  '',
  '## Second Heading',
  '',
  'More text here.',
  '',
].join('\n'))

const port = await reservePort()
const applicationProcess = spawn(electronExecutable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(temporaryDirectory, 'profile')}`,
  '--window-size=1440,900',
  applicationEntry,
  markdownPath,
], { cwd: repositoryRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
const processOutput = []
applicationProcess.stdout?.on('data', (chunk) => processOutput.push(chunk.toString()))
applicationProcess.stderr?.on('data', (chunk) => processOutput.push(chunk.toString()))

const stopProcess = async () => {
  if (applicationProcess.exitCode === null) {
    spawn('taskkill.exe', ['/pid', String(applicationProcess.pid), '/t', '/f'], { stdio: 'ignore' })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
  }
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
}

try {
  const browser = await connectToElectron(port)
  const page = (await browser.pages())[0]
  page.on('pageerror', (error) => console.error('pageerror:', error.message))
  page.on('console', (message) => { if (message.type() === 'error') console.error('console:', message.text()) })

  let frame
  for (let attempt = 0; attempt < 100; attempt += 1) {
    frame = page.frames().find((candidate) => candidate.url().startsWith('office-markdown://viewer/assets/index.html'))
    if (frame) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  }
  assert.ok(frame, 'Markdown iframe did not load')
  await frame.waitForSelector('.vditor-wysiwyg', { timeout: 30_000 })

  // TOC toolbar button inserts a [toc] marker.
  await frame.waitForSelector('[data-type="desktop-markdown-toc"]', { timeout: 15_000 })
  await frame.evaluate(() => {
    window.__smokeErrors = []
    window.addEventListener('error', (event) => window.__smokeErrors.push(String(event.error?.stack || event.message)))
    window.__emits = []
    const original = window.handler.emit
    window.handler.emit = (...args) => { window.__emits.push(args); return original(...args) }
  })
  const logicProbe = await frame.evaluate(async () => {
    const mod = await import('/assets/util.js')
    const calls = []
    const mock = {
      getValue: () => '# Title\n\nBody text.\n',
      setValue: (value) => calls.push(value),
    }
    mod.insertOrUpdateToc(mock)
    return { calls, exports: Object.keys(mod) }
  })
  console.log('smoke logic probe:', JSON.stringify(logicProbe, null, 2))
  await frame.$eval('[data-type="desktop-markdown-toc"]', (button) => button.click())
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  const tocDebug = await frame.evaluate(() => ({
    errors: window.__smokeErrors,
    saves: window.__emits.filter((args) => args[0] === 'save').map((args) => String(args[1]).slice(0, 60)),
  }))
  console.log('smoke debug:', JSON.stringify(tocDebug, null, 2))
  assert.ok(
    tocDebug.saves.some((value) => value.startsWith('[toc]')),
    `TOC click did not insert a [toc] marker: ${JSON.stringify(tocDebug)}`,
  )
  // Clicking again must keep exactly one marker (update, not duplicate).
  await frame.$eval('[data-type="desktop-markdown-toc"]', (button) => button.click())
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  const tocValue = await frame.evaluate(() => {
    const saves = window.__emits.filter((args) => args[0] === 'save').map((args) => String(args[1]))
    return saves.at(-1) ?? ''
  })
  assert.equal((tocValue.match(/^\[toc\]$/gm) ?? []).length, 1, 'TOC marker must appear exactly once after repeated clicks')
  console.log('smoke: TOC button inserted and updated [toc] marker')

  // Word-count chip renders CJK-aware stats.
  await frame.waitForFunction(
    () => /字数 \d+ · 词数 \d+ · 约 \d+ 分钟/.test(document.querySelector('.office-markdown-word-count')?.textContent ?? ''),
    { timeout: 15_000 },
  )
  const chipText = await frame.$eval('.office-markdown-word-count', (chip) => chip.textContent)
  console.log(`smoke: word-count chip shows "${chipText}"`)

  // Context menu exposes 打印 and 导出长图 as desktop-only items.
  await frame.click('.vditor-wysiwyg', { button: 'right' })
  await frame.waitForSelector('#context-menu:not([hidden])', { timeout: 15_000 })
  const menuActions = await frame.$$eval('#context-menu [data-action]', (items) => items.map((item) => item.getAttribute('data-action')))
  assert.ok(menuActions.includes('print'), 'Context menu is missing the print action')
  assert.ok(menuActions.includes('longImageExport'), 'Context menu is missing the long-image export action')
  assert.deepEqual(
    menuActions.filter((action) => action.startsWith('export')),
    ['exportPdf', 'exportPdfWithoutOutline', 'exportDocx', 'exportHtml'],
    'Existing export actions must be untouched',
  )
  console.log('smoke: context menu has 打印 and 导出长图')
  await frame.click('.vditor-wysiwyg')

  await page.screenshot({ path: join(outputDirectory, 'markdown-batch1.png') })

  // Long-image export writes a PNG next to the source document.
  const sessionId = new URL(frame.url()).searchParams.get('session')
  assert.ok(sessionId, 'Missing Markdown session id')
  const result = await page.evaluate(
    async ({ session, markdown }) => window.officeDesktop.exportMarkdownImage(session, markdown),
    { session: sessionId, markdown: await (await import('node:fs/promises')).readFile(markdownPath, 'utf8') },
  )
  assert.match(result.path, /batch1-note\.png$/)
  await access(result.path)
  console.log(`smoke: long-image export wrote ${result.path}`)

  browser.disconnect()
  console.log('markdown-batch1 smoke: PASS')
} catch (error) {
  console.error('markdown-batch1 smoke: FAIL')
  console.error(error)
  console.error(processOutput.join('').slice(-2000))
  process.exitCode = 1
} finally {
  await stopProcess()
}
