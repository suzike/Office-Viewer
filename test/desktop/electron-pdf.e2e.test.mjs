import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop embeds the original sandboxed PDF.js viewer UI', { timeout: 90_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-pdf-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const pdfPath = join(temporaryDirectory, 'original-pdf-ui.pdf')
  await writeFile(pdfPath, createPdfFixture())
  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    pdfPath,
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
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await connectToElectron(remoteDebuggingPort, applicationProcess, processOutput)
  page = await waitForApplicationPage(browser)
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message))

  await page.waitForSelector('.desktop-pdf-viewer iframe', { timeout: 30_000 })
  const frame = await waitForPdfFrame(page)
  await frame.waitForSelector('#toolbarContainer', { timeout: 30_000 })
  try {
    await frame.waitForFunction(() => {
      const canvas = document.querySelector('#viewer .page canvas')
      return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0
    }, { timeout: 30_000 })
  } catch (reason) {
    const state = await frame.evaluate(() => ({
      readyState: document.readyState,
      hasApplication: Boolean(window.PDFViewerApplication),
      initialized: window.PDFViewerApplication?.initialized,
      hasDocument: Boolean(window.PDFViewerApplication?.pdfDocument),
      lastMessageType: window.__officePdfLastMessageType,
      lastBufferBytes: window.__officePdfLastBufferBytes,
      openCount: window.__officePdfOpenCount,
      pages: document.querySelectorAll('#viewer .page').length,
      error: document.querySelector('#errorWrapper')?.textContent?.trim(),
      moreInfo: document.querySelector('#errorMoreInfo')?.value,
    }))
    const parentState = await page.evaluate(() => ({
      alert: document.querySelector('.desktop-pdf-viewer .ant-alert-description')?.textContent,
      loading: Boolean(document.querySelector('.desktop-pdf-viewer .ant-spin')),
    }))
    const networkState = await frame.evaluate(async () => {
      const file = new URL(location.href).searchParams.get('file')
      if (!file) return { file: null }
      try {
        const response = await fetch(file)
        const bytes = await response.arrayBuffer()
        return { file, status: response.status, ok: response.ok, bytes: bytes.byteLength }
      } catch (error) {
        return { file, fetchError: String(error) }
      }
    })
    throw new Error(`PDF.js did not render a page: ${reason}\n${JSON.stringify(state)}\n${JSON.stringify(parentState)}\n${JSON.stringify(networkState)}\n${consoleErrors.join('\n')}\n${pageErrors.join('\n')}`)
  }

  assert.equal(await page.$eval('.document-tab__name', element => element.textContent), basename(pdfPath))
  for (const selector of ['#sidebarToggle', '#viewFind', '#zoomOut', '#zoomIn', '#print', '#download']) {
    assert.notEqual(await frame.$(selector), null, `Missing original PDF.js control: ${selector}`)
  }
  assert.match(await frame.$eval('#numPages', element => element.textContent?.trim() ?? ''), /1/)
  assert.deepEqual(consoleErrors, [], `Renderer console errors:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

function createPdfFixture() {
  const pageContents = 'BT /F1 24 Tf 72 720 Td (Office Viewer original PDF.js UI) Tj ET\n'
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(pageContents, 'binary')} >>\nstream\n${pageContents}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(Buffer.byteLength(source, 'binary'))
    source += object
  }
  const xref = Buffer.byteLength(source, 'binary')
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(source, 'binary')
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
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
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    }
  }
  throw new Error(`Timed out connecting to Electron: ${lastError}\n${output.join('')}`)
}

async function waitForApplicationPage(browser) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const page = (await browser.pages()).find(candidate => candidate.url().includes('index.desktop.html'))
    if (page) return page
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the Office Viewer renderer page.')
}

async function waitForPdfFrame(page) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const frame = page.frames().find(candidate => candidate.url().startsWith('office-pdf://viewer/viewer.html?file='))
    if (frame) return frame
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the original PDF.js viewer frame.')
}

function collectProcessOutput(child, output) {
  child.stdout?.on('data', chunk => output.push(chunk.toString()))
  child.stderr?.on('data', chunk => output.push(chunk.toString()))
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
