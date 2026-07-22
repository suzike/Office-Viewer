import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import HTMLtoDOCX from 'vscode-html-to-docx'
import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop preserves the original Word editor and PowerPoint viewer UIs', { timeout: 120_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-word-ppt-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const docxPath = join(temporaryDirectory, 'word-roundtrip.docx')
  const dotxPath = join(temporaryDirectory, 'word-template.dotx')
  const pptxPath = join(temporaryDirectory, 'slides.pptx')
  const pptmPath = join(temporaryDirectory, 'slides-macro.pptm')
  await createDocxFixture(docxPath)
  await createPptxFixture(pptxPath)
  await copyFile(docxPath, dotxPath)
  await copyFile(pptxPath, pptmPath)

  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    docxPath,
    dotxPath,
    pptxPath,
    pptmPath,
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
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  browser = await connectToElectron(remoteDebuggingPort, applicationProcess, processOutput)
  page = await waitForApplicationPage(browser)
  if (process.env.OFFICE_VIEWER_PPT_SCREENSHOT || process.env.OFFICE_VIEWER_WORD_SCREENSHOT) {
    await page.setViewport({ width: 1600, height: 900 })
  }
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.stack || error.message))

  await page.waitForSelector('.ppt-viewer #ppt-canvas', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('.ppt-statusbar')?.textContent?.includes('Slide 1 / 2'), { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('.ppt-thumb img').length === 2, { timeout: 30_000 })
  assert.equal(await page.$eval('.document-tab.is-active .document-tab__name', element => element.textContent), basename(pptmPath))
  assert.equal(await page.$$eval('.ppt-thumb', elements => elements.length), 2)
  assert.notEqual(await page.$('.color-mode-toggle'), null)
  if (process.env.OFFICE_VIEWER_PPT_SCREENSHOT) {
    await page.screenshot({ path: process.env.OFFICE_VIEWER_PPT_SCREENSHOT })
  }

  await selectDocumentTab(page, basename(pptxPath))
  await page.waitForFunction(() => document.querySelector('.ppt-statusbar')?.textContent?.includes('Slide 1 / 2'), { timeout: 30_000 })

  await selectDocumentTab(page, basename(dotxPath))
  await page.waitForSelector('.office-document-activity[data-active="true"] .word-viewer .ep-root .layout-page', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('.office-document-activity[data-active="true"] .word-viewer')?.textContent?.includes('Office Viewer DOCX roundtrip'), { timeout: 30_000 })
  await page.waitForSelector('.office-document-activity[data-active="true"] .word-viewer[data-editor-ready="true"]', { timeout: 30_000 })

  await selectDocumentTab(page, basename(docxPath))
  await page.waitForSelector('.office-document-activity[data-active="true"] .word-viewer .ep-root .layout-page', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('.office-document-activity[data-active="true"] .word-viewer')?.textContent?.includes('Office Viewer DOCX roundtrip'), { timeout: 30_000 })
  await page.waitForSelector('.office-document-activity[data-active="true"] .word-viewer[data-editor-ready="true"]', { timeout: 30_000 })
  assert.equal(await page.$eval('.document-tab.is-active .document-tab__name', element => element.textContent), basename(docxPath))
  assert.notEqual(await page.$('.office-document-activity[data-active="true"] .word-viewer .dark-mode-toggle'), null)
  assert.ok(await page.$$eval('.office-document-activity[data-active="true"] .word-viewer .ep-root button', buttons => buttons.length) > 5, 'The original Word toolbar must be present.')
  if (process.env.OFFICE_VIEWER_WORD_SCREENSHOT) {
    await page.screenshot({ path: process.env.OFFICE_VIEWER_WORD_SCREENSHOT })
  }

  const firstTextRun = await page.$('.office-document-activity[data-active="true"] .word-viewer .layout-run-text')
  assert.ok(firstTextRun, 'The original Word editor must render a text run.')
  await firstTextRun.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' SAVED')
  try {
    await page.waitForSelector('.document-tab.is-active .dirty-dot', { timeout: 10_000 })
  } catch (reason) {
    const state = await page.evaluate(() => ({
      activeText: document.querySelector('.office-document-activity[data-active="true"] .word-viewer')?.textContent?.slice(0, 500),
      run: document.querySelector('.office-document-activity[data-active="true"] .word-viewer .layout-run-text')?.outerHTML,
      activeElement: document.activeElement?.outerHTML.slice(0, 500),
      editable: document.querySelector('.office-document-activity[data-active="true"] [contenteditable="true"]')?.outerHTML.slice(0, 500),
      marks: performance.getEntriesByType('mark').map(entry => entry.name),
    }))
    throw new Error(`Word edit did not mark the document dirty: ${JSON.stringify(state)}`, { cause: reason })
  }

  // Hidden React Activity trees keep the live editor/viewer models. This is
  // the regression gate for both parsed-cache hits and unsaved edit survival.
  await selectDocumentTab(page, basename(pptxPath))
  await page.waitForFunction(() => document.querySelector('.ppt-statusbar')?.textContent?.includes('Slide 1 / 2'), { timeout: 30_000 })
  await selectDocumentTab(page, basename(docxPath))
  await page.waitForSelector('.office-document-activity[data-active="true"] .word-viewer .ep-root .layout-page', { timeout: 30_000 })
  await page.waitForSelector('.document-tab.is-active .dirty-dot', { timeout: 10_000 })
  try {
    await page.waitForFunction(() => document.querySelector('.office-document-activity[data-active="true"] .word-viewer')?.textContent?.includes('SAVED'), { timeout: 10_000 })
  } catch (reason) {
    const state = await page.evaluate(() => ({
      activeText: document.querySelector('.office-document-activity[data-active="true"] .word-viewer')?.textContent?.slice(0, 500),
      activities: Array.from(document.querySelectorAll('.office-document-activity')).map(element => ({
        active: element.getAttribute('data-active'),
        id: element.getAttribute('data-document-id'),
        text: element.textContent?.slice(0, 250),
      })),
      marks: performance.getEntriesByType('mark').map(entry => entry.name),
    }))
    throw new Error(`Dirty Word edit was not restored after tab switch: ${JSON.stringify(state)}`, { cause: reason })
  }
  const officeCacheMarks = await page.evaluate(() => performance.getEntriesByType('mark').map(entry => entry.name))
  assert.ok(officeCacheMarks.includes('office-word-cache-hit'), `Missing Word cache hit: ${officeCacheMarks.join(', ')}`)
  assert.ok(officeCacheMarks.includes('office-powerpoint-cache-hit'), `Missing PowerPoint cache hit: ${officeCacheMarks.join(', ')}`)
  assert.equal(officeCacheMarks.filter(mark => mark === 'office-word-draft-serialize').length, 1, 'Rapid Word input must collapse to one draft serialization')

  await page.keyboard.down('Control')
  await page.keyboard.press('KeyS')
  await page.keyboard.up('Control')
  await waitForDocxText(docxPath, 'SAVED')
  await page.waitForFunction(() => document.querySelector('.document-tab.is-active .dirty-dot') === null, { timeout: 15_000 })

  // A same-id save replaces the session fingerprint. Editing again verifies
  // that the draft manager migrated to the refreshed cache key.
  try {
    await page.waitForSelector('.office-document-activity[data-active="true"] .word-viewer .layout-run-text', { timeout: 30_000 })
  } catch (reason) {
    const state = await page.evaluate(() => ({
      activeName: document.querySelector('.document-tab.is-active .document-tab__name')?.textContent,
      activity: document.querySelector('.office-document-activity[data-active="true"]')?.outerHTML.slice(0, 1000),
      word: document.querySelector('.office-document-activity[data-active="true"] .word-viewer')?.outerHTML.slice(0, 1000),
      error: document.querySelector('.ant-alert-error')?.textContent,
      marks: performance.getEntriesByType('mark').map(entry => entry.name),
    }))
    throw new Error(`Word editor disappeared after same-id save: ${JSON.stringify(state)}\n${pageErrors.join('\n')}`, { cause: reason })
  }
  const savedTextRun = await page.$('.office-document-activity[data-active="true"] .word-viewer .layout-run-text')
  assert.ok(savedTextRun)
  await savedTextRun.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' AGAIN')
  await page.waitForSelector('.document-tab.is-active .dirty-dot', { timeout: 10_000 })
  await selectDocumentTab(page, basename(pptxPath))
  await page.waitForFunction(() => document.querySelector('.ppt-statusbar')?.textContent?.includes('Slide 1 / 2'), { timeout: 30_000 })
  await selectDocumentTab(page, basename(docxPath))
  await page.waitForSelector('.office-document-activity[data-active="true"] .word-viewer[data-editor-ready="true"]', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('.office-document-activity[data-active="true"] .word-viewer')?.textContent?.includes('AGAIN'), { timeout: 15_000 })
  await page.waitForSelector('.document-tab.is-active .dirty-dot', { timeout: 10_000 })
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyS')
  await page.keyboard.up('Control')
  await waitForDocxText(docxPath, 'AGAIN')
  await page.waitForFunction(() => document.querySelector('.document-tab.is-active .dirty-dot') === null, { timeout: 15_000 })

  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function createDocxFixture(filePath) {
  const result = await HTMLtoDOCX(
    '<!doctype html><html><body><h1>Office Viewer DOCX roundtrip</h1><p>Editable paragraph</p><table><tr><td>Cell A</td><td>Cell B</td></tr></table></body></html>',
    undefined,
    { title: 'Office Viewer Word gate', creator: 'Office Viewer tests' },
  )
  const bytes = result instanceof Blob ? Buffer.from(await result.arrayBuffer()) : Buffer.from(result)
  await writeFile(filePath, bytes)
}

async function createPptxFixture(filePath) {
  const presentation = new PptxGenJS()
  presentation.layout = 'LAYOUT_WIDE'
  const first = presentation.addSlide()
  first.background = { color: 'F7F3E8' }
  first.addText('Office Viewer PowerPoint gate', { x: 0.8, y: 0.8, w: 8, h: 0.8, fontSize: 28, bold: true, color: '1F2937' })
  const second = presentation.addSlide()
  second.addText('Second slide', { x: 1, y: 1, w: 5, h: 1, fontSize: 24, color: 'C2410C' })
  await presentation.writeFile({ fileName: filePath })
}

async function waitForDocxText(filePath, expected) {
  const deadline = Date.now() + 20_000
  let lastText = ''
  while (Date.now() < deadline) {
    try {
      const archive = await JSZip.loadAsync(await readFile(filePath))
      lastText = await archive.file('word/document.xml')?.async('text') ?? ''
      if (lastText.includes(expected)) return
    } catch {
      // The host uses atomic replacement; retry while the new file is becoming visible.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Saved DOCX did not contain ${expected}: ${lastText.slice(0, 500)}`)
}

async function selectDocumentTab(page, name) {
  await page.$$eval('.document-tab', (tabs, targetName) => {
    const target = tabs.find(tab => tab.querySelector('.document-tab__name')?.textContent === targetName)
    if (!(target instanceof HTMLElement)) throw new Error(`Document tab not found: ${targetName}`)
    target.click()
  }, name)
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
