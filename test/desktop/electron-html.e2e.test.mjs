import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'
import JSZip from 'jszip'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop renders HTML with local assets inside an isolated origin', { timeout: 90_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-html-test-'))
  const documentDirectory = join(temporaryDirectory, 'document')
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const htmlPath = join(documentDirectory, 'preview.html')
  const classPath = join(temporaryDirectory, 'ConsoleDecompiler.class')
  await mkdir(documentDirectory)
  const decompilerJar = await JSZip.loadAsync(await readFile(resolve('resource/java-decompiler.jar')))
  const classFixture = decompilerJar.file('org/jetbrains/java/decompiler/main/decompiler/ConsoleDecompiler.class')
  assert.ok(classFixture)
  await Promise.all([
    writeFile(join(temporaryDirectory, 'outside.txt'), 'must-not-be-readable'),
    writeFile(join(documentDirectory, 'preview.css'), '#relative-style { color: rgb(12, 34, 56); }'),
    writeFile(join(documentDirectory, 'preview.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>'),
    writeFile(join(documentDirectory, 'preview.js'), 'document.body.dataset.externalScript = "executed";'),
    writeFile(classPath, await classFixture.async('nodebuffer')),
    writeFile(htmlPath, `<!doctype html>
      <html><head><link rel="stylesheet" href="preview.css"></head>
      <body>
        <p id="relative-style">HTML preview fixture</p>
        <img id="relative-image" src="preview.svg">
        <script src="preview.js"></script>
        <script>
          document.body.dataset.inlineScript = 'executed';
          try { document.body.dataset.parentApi = typeof parent.officeDesktop; }
          catch { document.body.dataset.parentApi = 'blocked'; }
          document.body.dataset.node = typeof require + ':' + typeof process;
        </script>
      </body></html>`),
  ])

  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    htmlPath,
    classPath,
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
  await page.waitForFunction(() => document.querySelectorAll('.document-tab').length === 2, { timeout: 30_000 })
  await page.$$eval('.document-tab', (tabs, htmlName) => {
    const target = tabs.find(tab => tab.querySelector('.document-tab__name')?.textContent === htmlName)
    if (!(target instanceof HTMLElement)) throw new Error('HTML document tab was not found.')
    target.click()
  }, basename(htmlPath))
  await page.waitForSelector('.desktop-html-viewer iframe', { timeout: 30_000 })
  const frame = await waitForHtmlFrame(page)
  await frame.waitForFunction(() => (
    document.body?.dataset.inlineScript === 'executed' &&
    document.body?.dataset.externalScript === 'executed'
  ), { timeout: 30_000 })
  await frame.waitForFunction(() => {
    const image = document.querySelector('#relative-image')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 8
  }, { timeout: 30_000 })

  const state = await frame.evaluate(() => ({
    inlineScript: document.body.dataset.inlineScript,
    externalScript: document.body.dataset.externalScript,
    parentApi: document.body.dataset.parentApi,
    node: document.body.dataset.node,
    color: getComputedStyle(document.querySelector('#relative-style')).color,
  }))
  assert.equal(await page.$eval('.document-tab__name', element => element.textContent), basename(htmlPath))
  await page.$$eval('.menu-button', buttons => {
    const help = buttons.find(button => button.textContent === '帮助')
    if (!(help instanceof HTMLElement)) throw new Error('Help menu was not found.')
    help.click()
  })
  assert.deepEqual(await page.$$eval('.menu-popover [role="menuitem"] span:first-child', items => items.map(item => item.textContent)), ['项目主页', '关于 Office Viewer'])
  assert.equal(await page.$eval('.desktop-shell', element => element.textContent?.includes('此菜单将在后续功能接入时启用。')), false)
  await page.$$eval('.menu-button', buttons => buttons.find(button => button.textContent === '帮助')?.click())
  assert.equal(state.inlineScript, 'executed')
  assert.equal(state.externalScript, 'executed')
  assert.ok(state.parentApi === 'blocked' || state.parentApi === 'undefined')
  assert.equal(state.node, 'undefined:undefined')
  assert.equal(state.color, 'rgb(12, 34, 56)')

  assert.equal(await page.$eval('.desktop-html-toolbar strong', element => element.textContent), 'HTML Preview')
  await page.$$eval('.desktop-html-toolbar button', buttons => {
    const target = buttons.find(button => button.textContent?.includes('源代码'))
    if (!(target instanceof HTMLElement)) throw new Error('HTML source toggle was not found.')
    target.click()
  })
  await page.waitForSelector('.desktop-html-viewer.is-split textarea[aria-label="HTML 源代码"]', { timeout: 30_000 })
  const editedHtml = (await page.$eval('textarea[aria-label="HTML 源代码"]', element => element.value))
    .replace('</body>', '<p id="desktop-edit-marker">Desktop source edit</p><script>document.body.dataset.savedSource = "executed";</script></body>')
  await page.$eval('textarea[aria-label="HTML 源代码"]', (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, editedHtml)
  await page.waitForSelector('.document-tab.is-active .dirty-dot')
  await page.$$eval('.desktop-html-toolbar button', buttons => {
    const target = buttons.find(button => button.textContent?.includes('保存并刷新'))
    if (!(target instanceof HTMLElement)) throw new Error('HTML save button was not found.')
    target.click()
  })
  await page.waitForFunction(() => document.querySelector('.document-tab.is-active .dirty-dot') === null)
  await waitForFileText(htmlPath, 'Desktop source edit')
  const savedFrame = await waitForHtmlFrameState(page, () => (
    document.querySelector('#desktop-edit-marker')?.textContent === 'Desktop source edit' &&
    document.body?.dataset.savedSource === 'executed'
  ))
  assert.equal(await savedFrame.$eval('#desktop-edit-marker', element => element.textContent), 'Desktop source edit')
  assert.deepEqual(await page.evaluate(() => ({ api: typeof window.officeDesktop, savedSource: document.body.dataset.savedSource })), { api: 'object' })

  const traversalStatus = await savedFrame.evaluate(async () => {
    const segments = location.pathname.split('/')
    const token = segments[2]
    const response = await fetch(`office-html://viewer/document/${token}/%2e%2e%2foutside.txt`)
    return response.status
  })
  assert.ok(traversalStatus === 400 || traversalStatus === 403 || traversalStatus === 404)

  await page.$$eval('.document-tab', (tabs, className) => {
    const target = tabs.find(tab => tab.querySelector('.document-tab__name')?.textContent === className)
    if (!(target instanceof HTMLElement)) throw new Error('Java Class document tab was not found.')
    target.click()
  }, basename(classPath))
  try {
    await page.waitForSelector('.desktop-java-viewer .cm-content', { timeout: 30_000 })
  } catch (reason) {
    const state = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll('.document-tab__name')].map(element => element.textContent),
      unsupported: document.querySelector('.state-panel--unsupported')?.textContent,
      error: document.querySelector('.ant-alert-error')?.textContent,
      source: document.querySelector('.desktop-java-viewer')?.textContent,
    }))
    throw new Error(`Java viewer did not load: ${reason}\n${JSON.stringify(state)}\n${processOutput.join('')}`)
  }
  await page.waitForFunction(() => document.querySelector('.desktop-java-viewer .cm-content')?.textContent?.includes('class ConsoleDecompiler'), { timeout: 30_000 })
  assert.equal(await page.$eval('.document-tab.is-active .document-tab__name', element => element.textContent), basename(classPath))
  assert.match(await page.$eval('.desktop-java-viewer .cm-content', element => element.textContent ?? ''), /class ConsoleDecompiler/)
})

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

async function waitForHtmlFrame(page) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const frame = page.frames().find(candidate => candidate.url().startsWith('office-html://viewer/document/'))
    if (frame) return frame
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the isolated HTML viewer frame.')
}

async function waitForHtmlFrameState(page, predicate) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const frame of page.frames().filter(candidate => candidate.url().startsWith('office-html://viewer/document/'))) {
      try {
        if (await frame.evaluate(predicate)) return frame
      } catch {}
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the saved HTML preview.')
}

async function waitForFileText(path, expected) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await readFile(path, 'utf8')).includes(expected)) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for ${path} to contain ${expected}.`)
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
