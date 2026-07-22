import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import puppeteer from 'puppeteer-core'
import { parquetWriteBuffer } from 'hyparquet-writer'

const require = createRequire(import.meta.url)
const { writePsdBuffer } = require('ag-psd')

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop reuses the original Parquet, PSD, font, and ICNS viewers for valid and corrupt files', { timeout: 120_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-special-format-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const files = {
    parquet: join(temporaryDirectory, 'minimal.parquet'),
    psd: join(temporaryDirectory, 'minimal.psd'),
    font: join(temporaryDirectory, 'minimal.ttf'),
    otf: join(temporaryDirectory, 'minimal.otf'),
    woff: join(temporaryDirectory, 'minimal.woff'),
    woff2: join(temporaryDirectory, 'minimal.woff2'),
    icns: join(temporaryDirectory, 'minimal.icns'),
    corruptParquet: join(temporaryDirectory, 'corrupt.parquet'),
    corruptPsd: join(temporaryDirectory, 'corrupt.psd'),
    corruptFont: join(temporaryDirectory, 'corrupt.ttf'),
    corruptWoff2: join(temporaryDirectory, 'corrupt.woff2'),
    corruptIcns: join(temporaryDirectory, 'corrupt.icns'),
  }
  await Promise.all([
    createParquetFixture(files.parquet),
    createPsdFixture(files.psd),
    copyFile(resolve('node_modules/@vscode/codicons/dist/codicon.ttf'), files.font),
    copyFile(resolve('node_modules/epubjs/documentation/html/assets/fonts/OTF/SourceCodePro-Regular.otf'), files.otf),
    copyFile(resolve('node_modules/epubjs/documentation/html/assets/fonts/WOFF/TTF/SourceCodePro-Regular.ttf.woff'), files.woff),
    copyFile(resolve('node_modules/epubjs/documentation/html/assets/fonts/WOFF2/TTF/SourceCodePro-Regular.ttf.woff2'), files.woff2),
    createIcnsFixture(files.icns),
    writeFile(files.corruptParquet, Buffer.from('not-a-parquet')),
    writeFile(files.corruptPsd, Buffer.from('not-a-psd')),
    writeFile(files.corruptFont, Buffer.from('not-a-font')),
    writeFile(files.corruptWoff2, Buffer.from('not-a-woff2')),
    writeFile(files.corruptIcns, Buffer.from('not-an-icns')),
  ])

  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    files.corruptParquet,
    files.corruptPsd,
    files.corruptFont,
    files.corruptWoff2,
    files.corruptIcns,
    files.parquet,
    files.psd,
    files.icns,
    files.font,
    files.otf,
    files.woff,
    files.woff2,
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
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  browser = await connectToElectron(remoteDebuggingPort, applicationProcess, processOutput)
  page = await waitForApplicationPage(browser)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message))

  await page.waitForSelector('.desktop-shell', { timeout: 30_000 })
  await waitForActiveTab(page, basename(files.woff2), 12)
  try {
    await page.waitForSelector('.font-viewer canvas.item', { timeout: 10_000 })
  } catch (error) {
    const state = await page.evaluate(() => ({
      text: document.querySelector('.font-viewer')?.textContent,
      alert: document.querySelector('.font-viewer .ant-alert-error')?.textContent,
      decoderFrame: document.querySelector('iframe[data-office-font-decoder="true"]')?.outerHTML,
    }))
    throw new Error(`WOFF2 viewer did not finish loading: ${JSON.stringify({ state, pageErrors })}`, { cause: error })
  }
  assert.match(await page.$eval('.font-viewer', (element) => element.textContent), /glyphs/)
  assert.equal(await page.$('.font-viewer .ant-alert-error'), null)

  const isolation = await page.evaluate(() => {
    const frame = document.querySelector('iframe[data-office-font-decoder="true"]')
    return {
      mainCsp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
      mainHasDecoderModule: typeof window.Module !== 'undefined',
      frameSandbox: frame?.getAttribute('sandbox'),
      frameSource: frame?.getAttribute('src'),
    }
  })
  assert.doesNotMatch(isolation.mainCsp ?? '', /(?:unsafe-eval|wasm-unsafe-eval)/)
  assert.match(isolation.mainCsp ?? '', /script-src 'self'/)
  assert.equal(isolation.mainHasDecoderModule, false)
  assert.equal(isolation.frameSandbox, 'allow-scripts')
  assert.match(isolation.frameSource ?? '', /font-decoder\.html$/)

  const decoderFrame = page.frames().find((frame) => frame.url().endsWith('/font-decoder.html'))
  assert.ok(decoderFrame, 'The isolated WOFF2 decoder frame was not created')
  const decoderGlobals = await decoderFrame.evaluate(() => {
    let canReadParentDocument = true
    try {
      void window.parent.document
    } catch {
      canReadParentDocument = false
    }
    return {
      officeDesktop: typeof window.officeDesktop,
      process: typeof window.process,
      require: typeof window.require,
      canReadParentDocument,
    }
  })
  assert.deepEqual(decoderGlobals, {
    officeDesktop: 'undefined',
    process: 'undefined',
    require: 'undefined',
    canReadParentDocument: false,
  })

  for (const fontPath of [files.font, files.otf, files.woff]) {
    await activateTab(page, basename(fontPath))
    await page.waitForSelector('.font-viewer canvas.item', { timeout: 30_000 })
    assert.match(await page.$eval('.font-viewer', (element) => element.textContent), /glyphs/)
    assert.equal(await page.$('.font-viewer .ant-alert-error'), null)
  }

  await activateTab(page, basename(files.parquet))
  await page.waitForSelector('.parquet-viewer .ant-table-row', { timeout: 30_000 })
  assert.match(await page.$eval('.parquet-viewer', (element) => element.textContent), /Alice/)
  assert.equal(await page.$('.parquet-viewer__error'), null)

  await activateTab(page, basename(files.psd))
  await page.waitForSelector('.psd-viewer .psd-preview-image', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('.psd-preview-image')?.naturalWidth > 0)
  assert.match(await page.$eval('.psd-viewer', (element) => element.textContent), /Pixel Layer|Composite/)
  assert.equal(await page.$('.psd-viewer .ant-alert-error'), null)

  await activateTab(page, basename(files.icns))
  await page.waitForSelector('.icns-viewer .icns-preview-image', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('.icns-preview-image')?.naturalWidth > 0)
  assert.match(await page.$eval('.icns-viewer', (element) => element.textContent), /16×16/)
  assert.equal(await page.$('.icns-viewer .ant-alert-error'), null)

  await activateTab(page, basename(files.corruptParquet))
  await page.waitForSelector('.parquet-viewer__error', { timeout: 30_000 })

  await activateTab(page, basename(files.corruptPsd))
  await page.waitForSelector('.psd-viewer .ant-alert-error', { timeout: 30_000 })

  await activateTab(page, basename(files.corruptFont))
  await page.waitForSelector('.font-viewer .ant-alert-error', { timeout: 30_000 })

  await activateTab(page, basename(files.corruptWoff2))
  await page.waitForSelector('.font-viewer .ant-alert-error', { timeout: 30_000 })

  await activateTab(page, basename(files.corruptIcns))
  await page.waitForSelector('.icns-viewer .ant-alert-error', { timeout: 30_000 })

  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function createParquetFixture(filePath) {
  const arrayBuffer = parquetWriteBuffer({
    columnData: [
      { name: 'name', data: ['Alice', 'Bob'], type: 'STRING' },
      { name: 'score', data: [91, 87], type: 'INT32' },
    ],
  })
  await writeFile(filePath, Buffer.from(arrayBuffer))
}

async function createPsdFixture(filePath) {
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ])
  const imageData = { width: 2, height: 2, data: pixels }
  const buffer = writePsdBuffer({
    width: 2,
    height: 2,
    imageData,
    children: [{
      name: 'Pixel Layer',
      left: 0,
      top: 0,
      right: 2,
      bottom: 2,
      imageData,
    }],
  })
  await writeFile(filePath, buffer)
}

async function createIcnsFixture(filePath) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const entryLength = 8 + png.length
  const icns = Buffer.alloc(8 + entryLength)
  icns.write('icns', 0, 'ascii')
  icns.writeUInt32BE(icns.length, 4)
  icns.write('icp4', 8, 'ascii')
  icns.writeUInt32BE(entryLength, 12)
  png.copy(icns, 16)
  await writeFile(filePath, icns)
}

async function waitForActiveTab(page, expectedName, tabCount) {
  await page.waitForFunction((name, count) => {
    const tabs = [...document.querySelectorAll('.document-tab__name')]
    return tabs.length === count && document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === name
  }, { timeout: 30_000 }, expectedName, tabCount)
}

async function activateTab(page, expectedName) {
  const found = await page.$$eval('.document-tab', (tabs, name) => {
    const tab = tabs.find((candidate) => candidate.querySelector('.document-tab__name')?.textContent === name)
    if (!tab) return false
    tab.click()
    return true
  }, expectedName)
  assert.equal(found, true, `Missing document tab: ${expectedName}`)
  await page.waitForFunction((name) =>
    document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === name,
  { timeout: 30_000 }, expectedName)
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
    if (child.exitCode !== null) throw new Error(`Electron exited before DevTools became available.\n${output.join('')}`)
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` })
    } catch (error) {
      lastError = error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  throw new Error(`Timed out connecting to Electron DevTools: ${lastError}\n${output.join('')}`)
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
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await once(killer, 'exit').catch(() => undefined)
    return
  }
  if (child.exitCode === null) child.kill()
  await waitForExit(child, 5_000).catch(() => undefined)
}
