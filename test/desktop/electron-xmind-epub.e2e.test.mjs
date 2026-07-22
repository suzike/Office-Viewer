import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop renders original EPUB and XMind views, sanitizes metadata, and reports corrupt files', { timeout: 120_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-format-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const epubPath = join(temporaryDirectory, 'safe-reader.epub')
  const xmindPath = join(temporaryDirectory, 'mind-map.xmind')
  const corruptEpubPath = join(temporaryDirectory, 'corrupt.epub')
  const corruptXmindPath = join(temporaryDirectory, 'corrupt.xmind')
  await Promise.all([
    createEpubFixture(epubPath),
    createXmindFixture(xmindPath),
    writeFile(corruptEpubPath, Buffer.from('not-an-epub')),
    writeFile(corruptXmindPath, Buffer.from('not-an-xmind')),
  ])

  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    corruptEpubPath,
    corruptXmindPath,
    xmindPath,
    epubPath,
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
    if (page && !page.isClosed()) {
      await page.close().catch(() => undefined)
    }
    browser?.disconnect()
    await stopProcess(applicationProcess)
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  browser = await connectToElectron(remoteDebuggingPort, applicationProcess, processOutput)
  page = await waitForApplicationPage(browser)
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.waitForSelector('.desktop-shell', { timeout: 30_000 })
  await waitForActiveTab(page, basename(epubPath), 4)
  try {
    await page.waitForSelector('.epub-viewer', { timeout: 15_000 })
  } catch (error) {
    const state = await page.evaluate(() => ({
      html: document.querySelector('.document-stage')?.innerHTML.slice(0, 3000),
      text: document.body.textContent,
    }))
    throw new Error(`EPUB component was not mounted: ${JSON.stringify({ state, consoleErrors, pageErrors })}`, { cause: error })
  }
  try {
    await page.waitForFunction(() =>
      document.querySelector('.epub-viewer .sidebar-button:not(.hidden)') !== null ||
      document.querySelector('.epub-viewer .error') !== null,
    { timeout: 15_000 })
  } catch (error) {
    const state = await page.$eval('.epub-viewer', (element) => ({
      html: element.innerHTML.slice(0, 2000),
      text: element.textContent,
    }))
    throw new Error(`EPUB renderer did not reach ready or error state: ${JSON.stringify(state)}`, { cause: error })
  }
  const epubError = await page.$eval('.epub-viewer .error-info', (element) => element.textContent).catch(() => null)
  assert.equal(epubError, null, `Valid EPUB fixture failed to render: ${epubError}`)

  await page.$eval('.epub-viewer .sidebar-button', (button) => button.click())
  await page.waitForFunction(() => !document.querySelector('.epub-viewer .sidebar-wrapper')?.classList.contains('out'))
  await page.$eval('.epub-viewer .tab-list .item:nth-child(3)', (button) => button.click())
  await page.waitForSelector('.epub-viewer .tab.info .description strong')
  const metadataState = await page.$eval('.epub-viewer .tab.info .description', (element) => ({
    html: element.innerHTML,
    text: element.textContent,
    unsafeElementCount: element.querySelectorAll('script, style, img, iframe, object, embed').length,
    attributedElementCount: element.querySelectorAll('[onerror], [onclick], [style], [href], [src]').length,
    executed: window.__epubMetadataExecuted === true,
  }))
  assert.match(metadataState.text, /Safe metadata description/)
  assert.match(metadataState.html, /<strong>metadata<\/strong>/)
  assert.equal(metadataState.unsafeElementCount, 0)
  assert.equal(metadataState.attributedElementCount, 0)
  assert.equal(metadataState.executed, false)

  const chapterFrame = await waitForEpubFrame(page, 'EPUB desktop renderer')
  await chapterFrame.waitForSelector('#relative-image')
  await chapterFrame.waitForFunction(() => document.querySelector('#relative-image')?.naturalWidth > 0)
  assert.match(await chapterFrame.$eval('#relative-image', (image) => image.src), /^blob:/)
  assert.equal(await chapterFrame.$eval('#chapter-link', (link) => typeof link.onclick), 'function')
  await chapterFrame.$eval('#chapter-link', (link) => link.click())
  await waitForEpubFrame(page, 'Second EPUB chapter')

  await activateTab(page, basename(xmindPath))
  await page.waitForSelector('.xmind-viewer .xmind-map .map-container', { timeout: 30_000 })
  assert.equal(await page.$eval('.xmind-map', (element) => element.textContent.includes('Desktop XMind Root')), true)
  assert.equal(await page.$('.xmind-viewer .ant-alert-error'), null)
  assert.deepEqual(consoleErrors, [], `Renderer console errors for valid files:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors for valid files:\n${pageErrors.join('\n')}`)

  consoleErrors.length = 0
  pageErrors.length = 0
  await activateTab(page, basename(corruptXmindPath))
  await page.waitForSelector('.xmind-viewer .ant-alert-error', { timeout: 30_000 })

  await activateTab(page, basename(corruptEpubPath))
  await page.waitForSelector('.epub-viewer .error', { timeout: 30_000 })

  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function createEpubFixture(filePath) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">desktop-epub-gate</dc:identifier>
    <dc:title>Desktop EPUB Gate</dc:title>
    <dc:creator>Office Viewer</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>Safe &lt;strong&gt;metadata&lt;/strong&gt; description&lt;img src=x onerror=&quot;window.__epubMetadataExecuted=true&quot;&gt;&lt;script&gt;window.__epubMetadataExecuted=true&lt;/script&gt;</dc:description>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-two" href="chapter-two.xhtml" media-type="application/xhtml+xml"/>
    <item id="pixel" href="images/pixel.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="chapter"/><itemref idref="chapter-two"/></spine>
</package>`)
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="chapter.xhtml">Chapter</a></li><li><a href="chapter-two.xhtml">Next</a></li></ol></nav></body></html>`)
  zip.file('OEBPS/chapter.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>EPUB desktop renderer</h1><p>Binary bridge fixture.</p><img id="relative-image" src="images/pixel.png" alt="pixel"/><a id="chapter-link" href="chapter-two.xhtml">Next chapter</a></body></html>`)
  zip.file('OEBPS/chapter-two.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second chapter</title></head><body><h1>Second EPUB chapter</h1></body></html>`)
  zip.file('OEBPS/images/pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

async function createXmindFixture(filePath) {
  const zip = new JSZip()
  zip.file('content.json', JSON.stringify([{
    id: 'desktop-sheet',
    title: 'Desktop XMind Sheet',
    rootTopic: {
      id: 'root-topic',
      title: 'Desktop XMind Root',
      children: {
        attached: [{ id: 'child-topic', title: 'Binary bridge child' }],
      },
    },
    relationships: [],
  }]))
  zip.file('metadata.json', JSON.stringify({ creator: { name: 'Office Viewer test' } }))
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
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

async function waitForEpubFrame(page, expectedText) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const text = await frame.$eval('body', (body) => body.textContent)
        if (text?.includes(expectedText)) return frame
      } catch {
        // epub.js replaces its iframe while navigating between spine items.
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for EPUB frame containing: ${expectedText}`)
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
    const pages = await browser.pages()
    const page = pages.find((candidate) => candidate.url().includes('index.desktop.html'))
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
