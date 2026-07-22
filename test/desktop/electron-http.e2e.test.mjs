import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop HTTP client edits, safely gates localhost, sends and renders a response', { timeout: 90_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-http-e2e-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')

  const api = createHttpServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ path: request.url, environment: request.headers['x-environment'] }))
  })
  await listen(api)
  const apiAddress = api.address()
  assert.ok(apiAddress && typeof apiAddress === 'object')
  const documentPath = join(temporaryDirectory, 'desktop.http')
  await writeFile(documentPath, [
    '@baseUrl = http://127.0.0.1',
    '# @name desktopRequest',
    `POST http://127.0.0.1:${apiAddress.port}/status HTTP/1.1`,
    'X-Environment: {{target}}',
    '',
    '< ./payload.json',
    '###',
    'GET https://example.com/{{desktopRequest.response.body.path}}/{{missing}}',
  ].join('\n'))
  await writeFile(join(temporaryDirectory, 'payload.json'), '{}')

  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    documentPath,
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
    await close(api)
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  browser = await connectToElectron(remoteDebuggingPort, applicationProcess, processOutput)
  page = await waitForApplicationPage(browser)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.waitForSelector('[data-testid="desktop-http-viewer"]', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('.http-client__source .cm-content')?.textContent?.includes('desktopRequest'))

  const languageUi = await page.evaluate(() => ({
    codeMirror: Boolean(document.querySelector('.http-client__source .cm-editor')),
    oldTextarea: Boolean(document.querySelector('textarea.http-client__source')),
    outline: [...document.querySelectorAll('.http-client__outline button')].map(button => button.textContent),
    diagnosticTitles: [...document.querySelectorAll('.cm-http-diagnostic')].map(node => node.getAttribute('title')),
    problemText: document.querySelector('.http-client__problems')?.textContent,
    documentLinkTitle: document.querySelector('.cm-http-link')?.getAttribute('title'),
    requestCodeLenses: document.querySelectorAll('.http-client__code-lens:not(.http-client__code-lens--reference)').length,
    variableCodeLenses: document.querySelectorAll('.http-client__code-lens--reference').length,
  }))
  assert.equal(languageUi.codeMirror, true)
  assert.equal(languageUi.oldTextarea, false)
  assert.ok(languageUi.outline.some(text => text?.includes('desktopRequest')))
  assert.match(languageUi.problemText ?? '', /missing is not found/)
  assert.ok(languageUi.diagnosticTitles.includes('missing is not found'))
  assert.match(languageUi.documentLinkTitle ?? '', /payload\.json/)
  assert.equal(languageUi.requestCodeLenses, 2)
  assert.equal(languageUi.variableCodeLenses, 1)

  await page.$$eval('.http-client__toolbar button', (buttons) => {
    const settings = buttons.find(button => button.textContent === '环境与设置')
    if (!(settings instanceof HTMLElement)) throw new Error('HTTP settings button was not found.')
    settings.click()
  })
  await page.waitForSelector('.http-client__settings')
  await page.$eval('.http-client__settings textarea', (textarea) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, '{"$shared":{"target":"desktop-e2e"},"local":{}}')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.$$eval('.http-client__settings-grid label', (labels) => {
    const preview = labels.find(candidate => candidate.textContent?.includes('预览列'))?.querySelector('select')
    if (!(preview instanceof HTMLSelectElement)) throw new Error('Preview column setting was not found.')
    preview.value = 'current'
    preview.dispatchEvent(new Event('change', { bubbles: true }))
    const privateNetwork = labels.find(candidate => candidate.textContent?.includes('允许本地/私有网络'))?.querySelector('input')
    if (!(privateNetwork instanceof HTMLInputElement)) throw new Error('Private network opt-in was not found.')
    if (privateNetwork.checked) privateNetwork.click()
  })
  await page.click('.http-client__code-lens:not(.http-client__code-lens--reference) button')
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
  const blockedState = await page.evaluate(() => ({
    error: document.querySelector('.http-client__inline-error')?.textContent,
    response: document.querySelector('.http-client__response')?.textContent,
    status: document.querySelector('.http-client__status')?.textContent,
    privateNetwork: [...document.querySelectorAll('.http-client__settings-grid label')].find(candidate => candidate.textContent?.includes('允许本地/私有网络'))?.querySelector('input')?.checked,
  }))
  assert.match(blockedState.error ?? '', /Private and local network/, JSON.stringify(blockedState))
  await page.$$eval('.http-client__settings-grid label', (labels) => {
    const label = labels.find(candidate => candidate.textContent?.includes('允许本地/私有网络'))
    const checkbox = label?.querySelector('input')
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('Private network opt-in was not found.')
    checkbox.click()
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.http-client__settings-grid label')]
    .find(candidate => candidate.textContent?.includes('允许本地/私有网络'))?.querySelector('input')?.checked === true)
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  await page.$eval('.http-client__inline-error button', button => button.click())
  await page.click('.http-client__code-lens:not(.http-client__code-lens--reference) button')
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
  const sentState = await page.evaluate(() => ({
    error: document.querySelector('.http-client__inline-error')?.textContent,
    response: document.querySelector('.http-client__response')?.textContent,
    status: document.querySelector('.http-client__status')?.textContent,
  }))
  assert.match(sentState.response ?? '', /desktop-e2e/, JSON.stringify(sentState))
  await page.waitForSelector('.http-client--response-focused')
  await page.$$eval('.http-client__response-toolbar button', buttons => {
    const back = buttons.find(button => button.textContent?.includes('返回请求'))
    if (!(back instanceof HTMLElement)) throw new Error('Current-column response back button was not found.')
    back.click()
  })
  await page.waitForSelector('.http-client:not(.http-client--response-focused) .cm-content')

  await page.click('.http-client__source .cm-content')
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await page.keyboard.press('Enter')
  await page.keyboard.type('# edited-by-electron-e2e')
  await page.keyboard.down('Control')
  await page.keyboard.press('s')
  await page.keyboard.up('Control')
  await waitForFile(documentPath, text => text.includes('edited-by-electron-e2e'))

  await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  const persistedSettings = await page.evaluate(() => window.officeDesktop.loadHttpSettings())
  assert.equal(persistedSettings.environmentSource, '{"$shared":{"target":"desktop-e2e"},"local":{}}')
  assert.equal(persistedSettings.previewColumn, 'current')
  assert.equal(persistedSettings.allowPrivateNetwork, true)
  const persistedText = await readFile(join(profileDirectory, 'http-settings.json'), 'utf8')
  assert.doesNotMatch(persistedText, /desktop-e2e/)
  assert.match(persistedText, /encryptedEnvironmentSource/)

  const state = await page.evaluate(() => ({
    response: document.querySelector('.http-client__response')?.textContent,
    status: document.querySelector('.http-client__status')?.textContent,
    responseToolbar: document.querySelector('.http-client__response-toolbar')?.textContent,
    requestButtons: document.querySelectorAll('.http-client__code-lens:not(.http-client__code-lens--reference)').length,
  }))
  assert.match(state.response ?? '', /"path": "\/status"/)
  assert.match(state.response ?? '', /"environment": "desktop-e2e"/)
  assert.match(state.responseToolbar ?? '', /200/)
  assert.match(state.status ?? '', /已保存/)
  assert.equal(state.requestButtons, 2)
  assert.deepEqual(pageErrors, [])
})

async function waitForFile(path, predicate) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (predicate(await readFile(path, 'utf8'))) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new Error(`Timed out waiting for file update: ${path}`)
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
}

function close(server) {
  return new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
}

async function reservePort() {
  const server = createPortServer()
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await close(server)
  return address.port
}

async function connectToElectron(port, child, output) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early.\n${output.join('')}`)
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }) }
    catch (error) { lastError = error; await new Promise(resolveDelay => setTimeout(resolveDelay, 100)) }
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
  throw new Error('Timed out waiting for Office Viewer.')
}

function collectProcessOutput(child, output) {
  child.stdout?.on('data', chunk => output.push(chunk.toString()))
  child.stderr?.on('data', chunk => output.push(chunk.toString()))
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill()
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise(resolveDelay => setTimeout(() => resolveDelay(false), 5_000)),
  ])
  if (!exited && process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    await once(killer, 'exit').catch(() => undefined)
  }
}
