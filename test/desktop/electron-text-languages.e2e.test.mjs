import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop text workspace covers YAML/XML and every contributed language frontend', { timeout: 120_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-text-languages-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const fixtures = [
    ['sample.yaml', 'root:\n  defaults: &defaults\n    enabled: true\n  selected: *defaults\n'],
    ['sample.xml', '<root><item id="1">value</item></root>'],
    ['nginx.conf', 'server {\n  listen 8080;\n}\n'],
    ['sample.kt', 'fun main() { println("Office Viewer") }\n'],
    ['sample.reg', 'Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\Software\\OfficeViewer]\n"Enabled"=dword:00000001\n'],
    ['sample.toml', '[viewer]\nenabled = true\n'],
    ['sample.kql', 'requests\n| where success == true\n| summarize count() by name\n'],
  ]
  const paths = []
  for (const [name, content] of fixtures) {
    const path = join(temporaryDirectory, name)
    await writeFile(path, content, 'utf8')
    paths.push(path)
  }

  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    ...paths,
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

  await page.waitForFunction((count) => document.querySelectorAll('.document-tab').length === count, { timeout: 30_000 }, fixtures.length)
  const expectedLanguages = new Map([
    ['sample.yaml', 'yaml'], ['sample.xml', 'xml'], ['nginx.conf', 'nginx'],
    ['sample.kt', 'kotlin'], ['sample.reg', 'reg'], ['sample.toml', 'toml'], ['sample.kql', 'kusto'],
  ])
  for (const [name, language] of expectedLanguages) {
    await selectTab(page, name)
    await page.waitForSelector(`.desktop-text-viewer[data-language="${language}"] .cm-editor`, { timeout: 30_000 })
    assert.equal(await page.$eval('.desktop-text-toolbar strong', (element) => element.textContent?.toLowerCase()), language)
  }

  await selectTab(page, 'sample.yaml')
  await page.waitForSelector('.desktop-yaml-outline', { timeout: 30_000 })
  const yamlOutline = await page.$$eval('.desktop-yaml-outline button', (buttons) => buttons.map((button) => button.textContent?.trim()))
  assert.ok(yamlOutline.includes('root'))
  assert.ok(yamlOutline.includes('defaults'))
  assert.ok(yamlOutline.includes('selected'))

  await selectTab(page, 'sample.xml')
  await clickButtonWithText(page, '.desktop-text-toolbar button', '格式化全文')
  await page.waitForFunction(() => document.querySelectorAll('.desktop-text-editor .cm-line').length >= 3, { timeout: 10_000 })
  await page.keyboard.down('Control')
  await page.keyboard.press('s')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => !document.querySelector('.document-tab.is-active .dirty-dot'), { timeout: 10_000 })
  const formattedXml = await readFile(join(temporaryDirectory, 'sample.xml'), 'utf8')
  assert.match(formattedXml, /<root>\r?\n  <item id="1">value<\/item>\r?\n<\/root>/)

  assert.deepEqual(consoleErrors, [], `Renderer console errors:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function selectTab(page, name) {
  await page.$$eval('.document-tab', (tabs, selectedName) => {
    const target = tabs.find((tab) => tab.querySelector('.document-tab__name')?.textContent === selectedName)
    if (!(target instanceof HTMLElement)) throw new Error(`Missing tab ${selectedName}`)
    target.click()
  }, name)
  await page.waitForFunction((selectedName) => document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === selectedName, {}, name)
}

async function clickButtonWithText(page, selector, text) {
  await page.$$eval(selector, (buttons, expected) => {
    const target = buttons.find((button) => button.textContent?.includes(expected))
    if (!(target instanceof HTMLElement)) throw new Error(`Missing button ${expected}`)
    target.click()
  }, text)
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
  if (child.exitCode !== null) return
  child.kill()
  try {
    await waitForExit(child, 5_000)
  } catch {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      await once(killer, 'exit').catch(() => undefined)
    }
  }
}
