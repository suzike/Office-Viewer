// Visual verification: launch the desktop app headlessly and capture UI screenshots.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-shots-'))
const csvPath = join(temporaryDirectory, 'quarterly-report.csv')
await mkdir(outputDirectory, { recursive: true })
await writeFile(csvPath, 'region,revenue,profit\nnorth,1200,300\nsouth,980,210\neast,1430,415\nwest,760,150\n')

const port = await reservePort()
const applicationProcess = spawn(electronExecutable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(temporaryDirectory, 'profile')}`,
  '--window-size=1440,900',
  applicationEntry,
  csvPath,
], { cwd: repositoryRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

const stopProcess = async () => {
  if (applicationProcess.exitCode !== null) return
  spawn('taskkill.exe', ['/pid', String(applicationProcess.pid), '/t', '/f'], { stdio: 'ignore' })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
}

try {
  const browser = await connectToElectron(port)
  const page = (await browser.pages())[0]
  await page.waitForSelector('.document-tab', { timeout: 30_000 })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))

  // 1. Light theme — document workspace (tab strip + metadata bar + viewer)
  await page.screenshot({ path: join(outputDirectory, '01-workspace-light.png') })

  // 2. Menu popover (macOS menu style)
  await page.click('.menu-button')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  await page.screenshot({ path: join(outputDirectory, '02-menu-light.png') })
  await page.keyboard.press('Escape')

  // 3. Dark theme
  await page.click('.theme-toggle')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600))
  await page.screenshot({ path: join(outputDirectory, '03-workspace-dark.png') })

  // 4. Dark welcome screen (close the document tab first)
  await page.click('.document-tab__close')
  await page.waitForSelector('.welcome', { timeout: 15_000 })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600))
  await page.screenshot({ path: join(outputDirectory, '04-welcome-dark.png') })

  // 5. Light welcome screen
  await page.click('.theme-toggle')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600))
  await page.screenshot({ path: join(outputDirectory, '05-welcome-light.png') })

  // 6. AI assistant panel
  await page.click('.document-assistant__launcher')
  await page.waitForSelector('.document-assistant__panel', { timeout: 15_000 })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600))
  await page.screenshot({ path: join(outputDirectory, '06-assistant-light.png') })

  await browser.disconnect()
  console.log('Screenshots saved to', outputDirectory)
} finally {
  await stopProcess()
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
