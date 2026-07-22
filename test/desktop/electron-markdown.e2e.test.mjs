import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'
import JSZip from 'jszip'
import { PDFDocument, PDFName } from 'pdf-lib'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

test('desktop preserves the original Vditor Markdown UI, saves edits, loads local images, and blocks scripts', { timeout: 180_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-markdown-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const markdownDirectory = join(temporaryDirectory, 'docs')
  const markdownPath = join(markdownDirectory, 'desktop-note.md')
  const wikiPath = join(markdownDirectory, 'Linked Note.md')
  const corruptPath = join(temporaryDirectory, 'invalid-utf8.markdown')
  const markdownSource = [
    '# Original Vditor desktop gate',
    '',
    '![local pixel](./pixel.png)',
    '![workspace pixel](workspace-only.png)',
    '',
    '[[Linked Note]]',
    '',
    '## Dynamic export',
    '',
    '$$x^2 + y^2 = z^2$$',
    '',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '',
    '<script>window.__officeMarkdownExecuted = true</script>',
    '<img src="missing.png" onerror="window.__officeMarkdownExecuted = true">',
    '',
  ].join('\n')
  await mkdir(join(temporaryDirectory, '.git'))
  await mkdir(markdownDirectory)
  await Promise.all([
    writeFile(join(markdownDirectory, 'pixel.png'), pixel),
    writeFile(join(temporaryDirectory, 'workspace-only.png'), pixel),
    writeFile(wikiPath, '# Linked page\n\nWiki navigation target.\n'),
    writeFile(markdownPath, markdownSource),
    writeFile(corruptPath, Buffer.from([0xff, 0xfe, 0x23, 0x20, 0x62, 0x61, 0x64])),
  ])

  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    corruptPath,
    markdownPath,
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
  if (process.env.OFFICE_VIEWER_SCREENSHOT || process.env.OFFICE_VIEWER_THEME_PANEL_SCREENSHOT) {
    await page.setViewport({ width: 1600, height: 900 })
  }
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message))

  await page.waitForFunction((name) =>
    document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === name,
  { timeout: 30_000 }, basename(markdownPath))

  const chromeMetrics = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect()
    const title = rect('.title-row')
    const menu = rect('.menu-row')
    const tabs = rect('.tab-strip')
    const metadata = rect('.metadata-bar')
    const surface = rect('.document-surface')
    return {
      titleHeight: title?.height,
      menuHeight: menu?.height,
      tabHeight: tabs?.height,
      metadataHeight: metadata?.height,
      documentTop: surface?.top,
    }
  })
  assert.equal(chromeMetrics.titleHeight, 38)
  assert.equal(chromeMetrics.menuHeight, 38, 'The application menus should share the compact title row.')
  assert.equal(chromeMetrics.tabHeight, 34)
  assert.equal(chromeMetrics.metadataHeight, 38)
  assert.ok(chromeMetrics.documentTop <= 111, `Desktop chrome is too tall: ${chromeMetrics.documentTop}px`)

  await page.click('.menu-button')
  await page.waitForSelector('.menu-popover', { visible: true })
  const menuPlacement = await page.$eval('.menu-popover', (menu) => {
    const bounds = menu.getBoundingClientRect()
    return { top: bounds.top, bottom: bounds.bottom, viewportHeight: window.innerHeight }
  })
  assert.ok(menuPlacement.top >= 37 && menuPlacement.bottom <= menuPlacement.viewportHeight)
  await page.click('.menu-button')

  let frame = await waitForMarkdownFrame(page)
  await frame.waitForSelector('.vditor-toolbar', { timeout: 30_000 })
  await frame.waitForSelector('.vditor-wysiwyg', { timeout: 30_000 })
  if (process.env.OFFICE_VIEWER_SCREENSHOT) {
    await page.screenshot({ path: process.env.OFFICE_VIEWER_SCREENSHOT })
  }

  const toolbarState = await frame.evaluate(() => ({
    buttons: document.querySelectorAll('.vditor-toolbar button').length,
    save: document.querySelector('[data-type="save"]') !== null,
    source: document.querySelector('[data-type="edit-in-vscode"]') !== null,
    executed: window.__officeMarkdownExecuted === true,
  }))
  assert.ok(toolbarState.buttons >= 12, 'The original Vditor toolbar was not rendered.')
  assert.equal(toolbarState.save, true)
  assert.equal(toolbarState.source, true)
  assert.equal(toolbarState.executed, false)

  await frame.click('[data-type="editor-theme"]')
  await frame.waitForSelector('.vditor-hint .vditor-editor-theme-panel', { visible: true })
  const themePanelState = await frame.$eval('.vditor-hint .vditor-editor-theme-panel', (content) => {
    const panel = content.closest('.vditor-hint')
    const bounds = panel.getBoundingClientRect()
    const style = getComputedStyle(panel)
    const rows = [...content.querySelectorAll('button')].map((button) => button.getBoundingClientRect())
    return {
      backgroundColor: style.backgroundColor,
      width: bounds.width,
      height: bounds.height,
      rowsSeparated: rows.every((row, index) => index === 0 || row.top >= rows[index - 1].bottom),
    }
  })
  assert.notEqual(themePanelState.backgroundColor, 'rgba(0, 0, 0, 0)', 'The editor theme panel must have an opaque surface.')
  assert.notEqual(themePanelState.backgroundColor, 'transparent', 'The editor theme panel must not reveal document content below it.')
  assert.ok(themePanelState.width <= 282, `Editor theme panel is too wide: ${themePanelState.width}px`)
  assert.ok(themePanelState.height <= 322, `Editor theme panel is too tall: ${themePanelState.height}px`)
  assert.equal(themePanelState.rowsSeparated, true, 'Editor theme choices overlap each other.')
  if (process.env.OFFICE_VIEWER_THEME_PANEL_SCREENSHOT) {
    await page.screenshot({ path: process.env.OFFICE_VIEWER_THEME_PANEL_SCREENSHOT })
  }
  await frame.click('[data-type="editor-theme"]')

  const interactionStarted = performance.now()
  for (let index = 0; index < 6; index += 1) {
    await frame.click('[data-type="editor-theme"]')
    await frame.waitForSelector('.vditor-hint .vditor-editor-theme-panel', { visible: true, timeout: 1_000 })
    const nextTheme = index % 2 === 0 ? 'Nord' : 'Light'
    await frame.click(`.vditor-editor-theme-panel button[data-theme="${nextTheme}"]`)
    await frame.waitForFunction((theme) => (
      document.querySelector('#vditor')?.getAttribute('data-editor-theme') === theme
      && document.querySelector('[data-type="editor-theme-toggle"]')?.getAttribute('data-theme') === theme
    ), { timeout: 1_000 }, nextTheme)
  }
  for (let index = 0; index < 8; index += 1) {
    const previousTheme = await frame.$eval('[data-type="editor-theme-toggle"]', (button) => button.getAttribute('data-theme'))
    await frame.click('[data-type="editor-theme-toggle"]')
    await frame.waitForFunction((theme) => (
      document.querySelector('[data-type="editor-theme-toggle"]')?.getAttribute('data-theme') !== theme
    ), { timeout: 1_000 }, previousTheme)
  }
  const interactionDuration = performance.now() - interactionStarted
  assert.ok(interactionDuration < 8_000, `Theme controls are too slow: ${interactionDuration.toFixed(0)}ms`)

  const advancedUi = await frame.evaluate(() => ({
    aiSettings: document.querySelector('[data-type="ai-settings"]') !== null,
    desktopSettings: document.querySelector('[data-type="desktop-markdown-settings"]') !== null,
    viewerSettings: document.querySelector('[data-type="settings"]') !== null,
    exportActions: [...document.querySelectorAll('#context-menu [data-action^="export"]')].map((item) => item.getAttribute('data-action')),
  }))
  assert.equal(advancedUi.aiSettings, true)
  assert.equal(advancedUi.desktopSettings, true)
  assert.equal(advancedUi.viewerSettings, true)
  assert.deepEqual(advancedUi.exportActions, ['exportPdf', 'exportPdfWithoutOutline', 'exportDocx', 'exportHtml'])

  const secretGuard = await frame.evaluate(() => {
    const key = 'vditor-global-settings'
    const previous = localStorage.getItem(key)
    localStorage.setItem(key, JSON.stringify({
      aiModels: JSON.stringify([{ id: 'e2e-model', url: 'https://example.invalid/v1', key: 'e2e-plaintext-secret' }]),
    }))
    const runtimeValue = localStorage.getItem(key)
    const probe = document.createElement('iframe')
    probe.src = 'about:blank'
    document.body.appendChild(probe)
    const persistedValue = probe.contentWindow.localStorage.getItem(key)
    probe.remove()
    if (previous === null) localStorage.removeItem(key)
    else localStorage.setItem(key, previous)
    return { runtimeValue, persistedValue }
  })
  assert.match(secretGuard.runtimeValue, /e2e-plaintext-secret/)
  assert.doesNotMatch(secretGuard.persistedValue ?? '', /e2e-plaintext-secret/)

  await frame.click('.vditor-wysiwyg', { button: 'right' })
  await frame.waitForSelector('#context-menu:not([hidden])')
  await frame.click('#context-menu [data-action="aiPolish"]')
  await frame.waitForSelector('.vditor-ai-dialog')
  assert.notEqual(await frame.$('.vditor-ai-dialog__btn--submit'), null)
  assert.notEqual(await frame.$('.vditor-ai-dialog__btn--cancel'), null)
  await page.keyboard.press('Escape')

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))
  const imageState = await frame.$$eval('.vditor-wysiwyg img', (images) => images.map((image) => ({
    alt: image.alt,
    src: image.src,
    complete: image.complete,
    naturalWidth: image.naturalWidth,
  })))
  const localImage = imageState.find((image) => image.src.startsWith('office-markdown://viewer/document/'))
  assert.ok(localImage?.complete && localImage.naturalWidth > 0, `Local Markdown image failed: ${JSON.stringify(imageState)}`)

  await frame.$eval('[data-type="desktop-markdown-settings"]', (button) => button.click())
  await page.waitForSelector('.desktop-markdown-settings[role="dialog"]')
  await page.click('.desktop-markdown-settings__check input[type="checkbox"]')
  await page.$eval('input[aria-label="粘贴图片路径"]', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'captures/${fileName}/${now}.${ext}')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.$eval('input[aria-label="PDF 顶部边距"]', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '42')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.click('.desktop-markdown-settings footer button.is-primary')
  await page.waitForSelector('.desktop-markdown-settings', { hidden: true })
  frame = await waitForMarkdownFrame(page, 'imageBase=workspace')
  await frame.waitForSelector('.vditor-wysiwyg', { timeout: 30_000 })
  await frame.waitForFunction(() => [...document.querySelectorAll('.vditor-wysiwyg img')].some((image) => (
    image.alt === 'workspace pixel' && image.complete && image.naturalWidth > 0
  )), { timeout: 30_000 })
  const persistedPreferences = await page.evaluate(() => window.officeDesktop.loadMarkdownPreferences())
  assert.equal(persistedPreferences.workspacePathAsImageBasePath, true)
  assert.equal(persistedPreferences.pasterImgPath, 'captures/${fileName}/${now}.${ext}')
  assert.equal(persistedPreferences.pdfMarginTop, 42)

  const sessionId = new URL(frame.url()).searchParams.get('session')
  assert.match(sessionId ?? '', /^[0-9a-f-]{36}$/i)
  const exportThroughDesktop = (type, withoutOutline = false) => withTimeout(page.evaluate(
    async ({ activeSession, source, exportType, omitOutline }) => window.officeDesktop.exportMarkdown(
      activeSession,
      source,
      { type: exportType, withoutOutline: omitOutline },
    ),
    { activeSession: sessionId, source: markdownSource, exportType: type, omitOutline: withoutOutline },
  ), 45_000, `Markdown ${type}${withoutOutline ? ' without outline' : ''} export`)
  const htmlExport = await exportThroughDesktop('html')
  traceStep('html export complete')
  const exportedHtml = await readFile(htmlExport.path, 'utf8')
  assert.match(exportedHtml, /class="katex/)
  assert.match(exportedHtml, /class="mermaid"/)
  assert.doesNotMatch(exportedHtml, /__officeMarkdownExecuted/)

  const docxExport = await exportThroughDesktop('docx')
  traceStep('docx export complete')
  const docx = await JSZip.loadAsync(await readFile(docxExport.path))
  assert.ok(docx.file('word/document.xml'))
  assert.ok(Object.keys(docx.files).some((name) => name.startsWith('word/media/')), 'DOCX dynamic content was not rasterized into media')

  const pdfExport = await exportThroughDesktop('pdf')
  traceStep('outlined pdf export complete')
  const outlinedPdf = await PDFDocument.load(await readFile(pdfExport.path))
  assert.ok(outlinedPdf.catalog.get(PDFName.of('Outlines')), 'PDF outline export did not create an outline catalog')
  await exportThroughDesktop('pdf', true)
  traceStep('plain pdf export complete')
  const plainPdf = await PDFDocument.load(await readFile(pdfExport.path))
  assert.equal(plainPdf.catalog.get(PDFName.of('Outlines')), undefined)

  await frame.click('.vditor-wysiwyg')
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await page.keyboard.type('\nVisual editor roundtrip.')
  await page.waitForSelector('.document-tab.is-active .dirty-dot')
  await frame.$eval('[data-type="save"]', (button) => button.click())
  await waitForFileText(markdownPath, 'Visual editor roundtrip.')
  await page.waitForFunction(() => document.querySelector('.document-tab.is-active .dirty-dot') === null)

  await frame.$eval('[data-type="edit-in-vscode"]', (button) => button.click())
  await page.waitForSelector('.desktop-markdown-source textarea', { timeout: 15_000 })
  traceStep('source mode open')
  setWindowsClipboardImage(join(markdownDirectory, 'pixel.png'))
  await page.$eval('.desktop-markdown-source textarea', (textarea) => {
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  })
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyV')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => /!\[[^\]]+\]\(captures\/desktop-note\/\d+\.png\)/.test(
    document.querySelector('.desktop-markdown-source textarea')?.value ?? '',
  ), { timeout: 15_000 })
  traceStep('clipboard image pasted')
  await waitForPastedImage(join(temporaryDirectory, 'captures', 'desktop-note'))
  setWindowsClipboardText('Plain source clipboard.')
  await page.$eval('.desktop-markdown-source textarea', (textarea) => {
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  })
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyV')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => document.querySelector('.desktop-markdown-source textarea')?.value.endsWith('Plain source clipboard.'))
  traceStep('clipboard text pasted')
  await page.$eval('.desktop-markdown-source textarea', (textarea) => {
    const value = `${textarea.value}\nDesktop source roundtrip.`
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForSelector('.document-tab.is-active .dirty-dot')
  await page.$eval('.desktop-markdown-source header button', (button) => button.click())
  await waitForFileText(markdownPath, 'Desktop source roundtrip.')
  traceStep('source saved')
  await page.waitForFunction(() => document.querySelector('.document-tab.is-active .dirty-dot') === null)
  await pressMarkdownSourceShortcut(page)
  await page.waitForFunction(() => document.querySelector('.desktop-markdown-source') === null)
  traceStep('source shortcut roundtrip complete')

  frame = await waitForMarkdownFrame(page)
  await frame.waitForFunction(() => document.querySelector('.vditor-wysiwyg')?.textContent?.includes('Desktop source roundtrip.'))
  assert.equal(await frame.evaluate(() => window.__officeMarkdownExecuted === true), false)

  await frame.click('.vditor-wysiwyg')
  await pressMarkdownSourceShortcut(page)
  await page.waitForSelector('.desktop-markdown-source textarea', { timeout: 15_000 })
  await page.$eval('.desktop-markdown-source textarea', textarea => textarea.focus())
  await pressMarkdownSourceShortcut(page)
  await page.waitForFunction(() => document.querySelector('.desktop-markdown-source') === null)

  await page.$eval('.document-tab.is-active .document-tab__close', (button) => button.click())
  await page.waitForFunction(() => document.querySelectorAll('.document-tab').length === 1)
  await openInExistingInstance(profileDirectory, markdownPath)
  await page.waitForFunction((name) =>
    document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === name,
  { timeout: 30_000 }, basename(markdownPath))
  frame = await waitForMarkdownFrame(page, 'imageBase=workspace')
  await frame.waitForFunction(() => document.querySelector('.vditor-wysiwyg')?.textContent?.includes('Desktop source roundtrip.'))
  traceStep('document reopened')

  await activateTab(page, basename(corruptPath))
  frame = await waitForMarkdownFrame(page, 'imageBase=workspace')
  await frame.waitForSelector('.vditor-toolbar', { timeout: 30_000 })
  assert.notEqual(await frame.$('.vditor-wysiwyg'), null)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
  traceStep('test complete')
})

async function waitForMarkdownFrame(page, expectedQuery = '') {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => (
      candidate.url().startsWith('office-markdown://viewer/assets/index.html') && candidate.url().includes(expectedQuery)
    ))
    if (frame) return frame
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the Markdown iframe.')
}

async function pressMarkdownSourceShortcut(page) {
  await page.keyboard.down('Control')
  await page.keyboard.down('Alt')
  await page.keyboard.press('KeyE')
  await page.keyboard.up('Alt')
  await page.keyboard.up('Control')
}

function setWindowsClipboardImage(imagePath) {
  const escapedPath = imagePath.replaceAll("'", "''")
  const command = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$image = [System.Drawing.Image]::FromFile('${escapedPath}')`,
    'try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }',
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, `Failed to seed the Windows image clipboard: ${result.stderr}`)
}

function setWindowsClipboardText(value) {
  const escapedValue = value.replaceAll("'", "''")
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('${escapedValue}')`,
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `Failed to seed the Windows text clipboard: ${result.stderr}`)
}

async function waitForPastedImage(directory) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      if ((await readdir(directory)).some((name) => name.endsWith('.png'))) return
    } catch {
      // The paste service creates the configured directory asynchronously.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for pasted Markdown image in ${directory}`)
}

async function waitForFileText(path, expected) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await readFile(path, 'utf8')).includes(expected)) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for saved Markdown text: ${expected}`)
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function traceStep(label) {
  if (process.env.OFFICE_VIEWER_E2E_TRACE) process.stderr.write(`[markdown-e2e] ${label}\n`)
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

async function openInExistingInstance(profileDirectory, filePath) {
  const output = []
  const child = spawn(electronExecutable, [
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    filePath,
  ], { cwd: repositoryRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  collectProcessOutput(child, output)
  const result = await waitForExit(child, 15_000)
  assert.equal(result.code, 0, `Electron handoff failed:\n${output.join('')}`)
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
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
      new Promise((_, rejectTimeout) => { timeout = setTimeout(() => rejectTimeout(new Error('Timed out waiting for Electron process exit.')), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function stopProcess(child) {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    await once(killer, 'exit').catch(() => undefined)
    return
  }
  if (child.exitCode === null) child.kill()
  await waitForExit(child, 5_000).catch(() => undefined)
}
