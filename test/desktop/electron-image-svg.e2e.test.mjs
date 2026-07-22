import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop preserves the original image and SVG tool UIs without executing active SVG content', { timeout: 90_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-image-svg-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const imagePath = resolve('image/logo.png')
  const svgPath = resolve('test/desktop/fixtures/malicious.svg')
  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    imagePath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  collectProcessOutput(applicationProcess, processOutput)

  let browser
  let page
  t.after(async () => {
    if (page && !page.isClosed()) await page.close().catch(() => undefined)
    browser?.disconnect()
    await stopProcess(applicationProcess)
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  browser = await connectToElectron(remoteDebuggingPort, applicationProcess, processOutput)
  page = await waitForApplicationPage(browser)
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message))

  await page.waitForSelector('.image-viewer .image-gallery', { timeout: 30_000 })
  await page.waitForFunction(() => {
    const image = document.querySelector('.image-gallery-image')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  }, { timeout: 30_000 })
  assert.equal(await page.$eval('.document-tab__name', (element) => element.textContent), basename(imagePath))
  assert.equal(await page.$$eval('.image-gallery-image', (images) => images.length), 1)
  assert.notEqual(await page.$('.image-wheel-toolbar'), null)

  await closeActiveDocument(page)
  await openInExistingInstance(profileDirectory, svgPath)
  await page.waitForSelector('.svg-viewer .cm-editor', { timeout: 30_000 })
  await page.waitForSelector('.svg-viewer__preview-img', { timeout: 30_000 })
  await page.waitForFunction(() => {
    const image = document.querySelector('.svg-viewer__preview-img')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  }, { timeout: 30_000 })

  const svgState = await page.evaluate(() => ({
    tab: document.querySelector('.document-tab__name')?.textContent,
    executed: window.__officeSvgExecuted === true,
    controls: [...document.querySelectorAll('.svg-viewer__btn')].map((button) => button.textContent?.trim()),
    error: document.querySelector('.svg-viewer__error')?.textContent,
  }))
  assert.equal(svgState.tab, basename(svgPath))
  assert.equal(svgState.executed, false)
  assert.equal(svgState.error, undefined)
  for (const labels of [['Save', '保存'], ['Open'], ['Format'], ['Copy'], ['Export'], ['Export PNG']]) {
    assert.ok(svgState.controls.some((text) => labels.some(label => text?.includes(label))), `Missing original SVG control: ${labels.join('/')}`)
  }
  assert.deepEqual(consoleErrors, [], `Renderer console errors:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function openInExistingInstance(profileDirectory, filePath) {
  const output = []
  const child = spawn(electronExecutable, [
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    filePath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  collectProcessOutput(child, output)
  const result = await waitForExit(child, 15_000)
  assert.equal(result.code, 0, `Electron handoff failed:\n${output.join('')}`)
}

async function closeActiveDocument(page) {
  await page.$eval('.document-tab__close', (button) => button.click())
  await page.waitForFunction(() => document.querySelectorAll('.document-tab').length === 0)
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
  return address.port
}

async function connectToElectron(port, child, output) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early.\n${output.join('')}`)
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` })
    } catch (error) {
      lastError = error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  throw new Error(`Timed out connecting to Electron: ${lastError}\n${output.join('')}`)
}

async function waitForApplicationPage(browser) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const page = (await browser.pages()).find((candidate) => candidate.url().includes('index.desktop.html'))
    if (page) return page
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the Office Viewer renderer page.')
}

function collectProcessOutput(child, output) {
  child.stdout?.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr?.on('data', (chunk) => output.push(chunk.toString()))
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  let timeout
  try {
    return await Promise.race([
      once(child, 'exit').then(([code, signal]) => ({ code, signal })),
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error('Timed out waiting for Electron process exit.')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill()
  try {
    await waitForExit(child, 5_000)
  } catch {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      await once(killer, 'exit').catch(() => undefined)
    }
  }
}
