import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop routes every original spreadsheet format through the Excel UI', { timeout: 120_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-spreadsheet-formats-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const fixtures = createSpreadsheetFixtures(temporaryDirectory)
  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    ...fixtures.map(fixture => fixture.path),
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
  page.on('dialog', dialog => void dialog.accept())
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.stack || error.message))
  await page.waitForFunction(count => document.querySelectorAll('.document-tab').length === count, { timeout: 30_000 }, fixtures.length)

  for (const fixture of fixtures) {
    await selectDocumentTab(page, basename(fixture.path))
    await page.waitForFunction((name, value) => (
      document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === name &&
      document.querySelector('.excel-app .x-spreadsheet') !== null &&
      document.querySelector('.excel-load-error') === null &&
      document.querySelector('.x-spreadsheet-formula-bar-input')?.value === value
    ), { timeout: 30_000 }, basename(fixture.path), fixture.value)
  }

  const csvFixture = fixtures.find(fixture => fixture.path.endsWith('.csv'))
  assert.ok(csvFixture)
  await selectDocumentTab(page, basename(csvFixture.path))
  await page.waitForFunction(name => document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === name, { timeout: 30_000 }, basename(csvFixture.path))
  assert.ok(
    await page.evaluate(() => performance.getEntriesByName('office-excel-cache-hit', 'mark').length > 0),
    'Switching back to a recent workbook must hit the parsed Excel cache.',
  )
  await page.waitForSelector('.metadata-mode-button', { timeout: 30_000 })
  await page.$eval('.metadata-mode-button', button => button.click())
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
  const toggledState = await page.evaluate(() => ({
    mode: document.querySelector('.metadata-mode-button')?.textContent?.trim(),
    activeName: document.querySelector('.document-tab.is-active .document-tab__name')?.textContent,
    dirty: document.querySelector('.document-tab.is-active .dirty-dot') !== null,
    spreadsheet: document.querySelector('.excel-app') !== null,
  }))
  assert.equal(toggledState.mode, '表格视图', `CSV toggle did not change mode: ${JSON.stringify(toggledState)}`)
  try {
    await page.waitForSelector('.desktop-text-viewer[data-language="plaintext"] .cm-content', { timeout: 15_000 })
  } catch (reason) {
    const state = await page.evaluate(() => ({
      mode: document.querySelector('.metadata-mode-button')?.textContent,
      textViewer: document.querySelector('.desktop-text-viewer')?.outerHTML.slice(0, 500),
      spreadsheet: document.querySelector('.excel-app') !== null,
      error: document.querySelector('.ant-alert-error')?.textContent,
      surface: document.querySelector('.document-surface')?.textContent?.slice(0, 500),
    }))
    throw new Error(`CSV text editor did not load: ${reason}\n${JSON.stringify(state)}\n${processOutput.join('')}`)
  }
  await page.click('.desktop-text-viewer .cm-content')
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.type('Desktop CSV Edit,84')
  await page.waitForSelector('.document-tab.is-active .dirty-dot')
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyS')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => document.querySelector('.document-tab.is-active .dirty-dot') === null)
  await waitForFileText(csvFixture.path, 'Desktop CSV Edit,84')
  await page.$eval('.metadata-mode-button', button => button.click())
  try {
    await page.waitForFunction(value => (
      document.querySelector('.excel-app .x-spreadsheet') !== null &&
      document.querySelector('.x-spreadsheet-formula-bar-input')?.value === value
    ), { timeout: 30_000 }, 'Desktop CSV Edit')
  } catch (reason) {
    const state = await page.evaluate(() => ({
      activeName: document.querySelector('.document-tab.is-active .document-tab__name')?.textContent,
      mode: document.querySelector('.metadata-mode-button')?.textContent,
      spreadsheet: document.querySelector('.excel-app .x-spreadsheet') !== null,
      formula: document.querySelector('.x-spreadsheet-formula-bar-input')?.value,
      error: document.querySelector('.excel-load-error, .ant-alert-error')?.textContent,
      surface: document.querySelector('.document-surface')?.textContent?.slice(0, 500),
    }))
    throw new Error(`CSV spreadsheet did not reload: ${reason}\n${JSON.stringify(state)}\n${processOutput.join('')}`)
  }

  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

function createSpreadsheetFixtures(directory) {
  const formats = [
    { extension: 'xls', bookType: 'xls', value: 'Legacy XLS' },
    { extension: 'xlsm', bookType: 'xlsm', value: 'Macro Workbook' },
    { extension: 'ods', bookType: 'ods', value: 'OpenDocument Sheet' },
    { extension: 'csv', bookType: 'csv', value: 'Comma Data', FS: ',' },
    { extension: 'tsv', bookType: 'csv', value: 'Tab Data', FS: '\t' },
  ]
  return formats.map(format => {
    const path = join(directory, `format.${format.extension}`)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[format.value, 42]]), 'Format')
    XLSX.writeFile(workbook, path, { bookType: format.bookType, FS: format.FS })
    return { path, value: format.value }
  })
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

async function waitForFileText(path, expected) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await readFile(path, 'utf8')).includes(expected)) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for ${path} to contain ${expected}.`)
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
