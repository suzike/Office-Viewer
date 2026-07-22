import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
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
const packagedExecutable = process.env.OFFICE_VIEWER_PACKAGED_EXECUTABLE
const launchExecutable = packagedExecutable ? resolve(packagedExecutable) : electronExecutable
const applicationArguments = packagedExecutable ? [] : [applicationEntry]

test('desktop runtime deduplicates startup XLSX arguments and renders without page errors', { timeout: 120_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-electron-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const workbookPath = join(temporaryDirectory, 'desktop-gate.xlsx')
  createWorkbookFixture(workbookPath)

  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(launchExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    ...applicationArguments,
    workbookPath,
    workbookPath,
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
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await connectToElectron(remoteDebuggingPort, applicationProcess, processOutput)
  page = await waitForApplicationPage(browser)
  if (process.env.OFFICE_VIEWER_XLSX_SCREENSHOT) await page.setViewport({ width: 1600, height: 900 })
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForSelector('.desktop-shell', { timeout: 30_000 })
  await waitForSingleRenderedWorkbook(page, basename(workbookPath), { consoleErrors, pageErrors })

  assert.equal(await page.$$eval('.document-tab', (tabs) => tabs.length), 1)
  assert.equal(await page.$eval('.document-tab__name', (element) => element.textContent), basename(workbookPath))
  assert.equal(await page.$('.excel-load-error'), null)
  if (process.env.OFFICE_VIEWER_XLSX_SCREENSHOT) {
    await page.screenshot({ path: process.env.OFFICE_VIEWER_XLSX_SCREENSHOT })
  }

  const overlayer = await page.$('.x-spreadsheet-overlayer')
  assert.ok(overlayer, 'The original spreadsheet interaction layer must be present.')
  const box = await overlayer.boundingBox()
  assert.ok(box)
  await page.$eval('.x-spreadsheet-overlayer', (element) => {
    const bounds = element.getBoundingClientRect()
    element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      buttons: 1,
      button: 0,
      detail: 2,
      clientX: bounds.left + 110,
      clientY: bounds.top + 46,
    }))
  })
  await page.waitForSelector('.x-spreadsheet-editor textarea', { visible: true, timeout: 10_000 })
  await page.focus('.x-spreadsheet-editor textarea')
  await page.$eval('.x-spreadsheet-editor textarea', (textarea) => {
    textarea.value = 'XLSX roundtrip SAVED'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.keyboard.press('Enter')
  await page.waitForSelector('.document-tab.is-active .dirty-dot', { timeout: 10_000 })
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyS')
  await page.keyboard.up('Control')
  await waitForWorkbookCell(workbookPath, 'XLSX roundtrip SAVED')
  await page.waitForFunction(() => document.querySelector('.document-tab.is-active .dirty-dot') === null, { timeout: 15_000 })

  await page.$eval('.document-tab__close', (button) => button.click())
  await page.waitForFunction(() => document.querySelectorAll('.document-tab').length === 0)

  const secondInstanceOutput = []
  const secondInstance = spawn(launchExecutable, [
    `--user-data-dir=${profileDirectory}`,
    ...applicationArguments,
    workbookPath,
    workbookPath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  collectProcessOutput(secondInstance, secondInstanceOutput)
  const secondExit = await waitForExit(secondInstance, 15_000)
  assert.equal(
    secondExit.code,
    0,
    `Second Electron instance did not hand off cleanly.\n${secondInstanceOutput.join('')}`,
  )

  await waitForSingleRenderedWorkbook(page, basename(workbookPath))
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))

  assert.equal(await page.$$eval('.document-tab', (tabs) => tabs.length), 1)
  assert.equal(await page.$('.excel-load-error'), null)
  assert.deepEqual(consoleErrors, [], `Renderer console errors:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

function createWorkbookFixture(filePath) {
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['Office Viewer desktop test gate', 'Status'],
    ['XLSX renderer', 'PASS'],
    ['Value', 42],
  ])
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Gate Sheet')
  XLSX.writeFile(workbook, filePath)
}

async function waitForWorkbookCell(filePath, expected) {
  const deadline = Date.now() + 20_000
  let lastValue
  while (Date.now() < deadline) {
    try {
      const workbook = XLSX.readFile(filePath)
      lastValue = workbook.Sheets[workbook.SheetNames[0]]?.A1?.v
      if (lastValue === expected) return
    } catch {
      // The host uses atomic replacement; retry while the new file is becoming visible.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Saved workbook A1 was ${JSON.stringify(lastValue)}, expected ${JSON.stringify(expected)}.`)
}

async function waitForSingleRenderedWorkbook(page, expectedName, diagnostics) {
  try {
    await page.waitForFunction((name) => {
      const tabs = [...document.querySelectorAll('.document-tab__name')]
      return tabs.length === 1 &&
        tabs[0]?.textContent === name &&
        document.querySelector('.excel-app .x-spreadsheet') !== null &&
        document.querySelector('.excel-load-error') === null
    }, { timeout: 30_000 }, expectedName)
  } catch (reason) {
    const state = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll('.document-tab__name')].map((tab) => tab.textContent),
      hasSpreadsheet: document.querySelector('.excel-app .x-spreadsheet') !== null,
      loadError: document.querySelector('.excel-load-error')?.textContent?.trim() ?? null,
      performanceMarks: performance.getEntriesByType('mark').map((entry) => entry.name),
      spinner: document.querySelector('.ant-spin-text')?.textContent?.trim() ?? null,
      excelApp: document.querySelector('.excel-app')?.outerHTML.slice(0, 1_000) ?? null,
      spreadsheetRoots: [...document.querySelectorAll('.x-spreadsheet')].map((element) => ({
        connected: element.isConnected,
        parent: element.parentElement?.id,
        hidden: element.closest('[hidden]') !== null,
      })),
      bodyText: document.body.textContent?.trim().slice(-500) ?? null,
    })).catch(() => null)
    throw new Error(`Workbook did not render: ${JSON.stringify({ state, ...diagnostics })}`, { cause: reason })
  }
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
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before DevTools became available.\n${output.join('')}`)
    }
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
    const applicationPage = pages.find((candidate) => candidate.url().includes('index.desktop.html'))
    if (applicationPage) {
      return applicationPage
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the Office Viewer renderer page.')
}

function collectProcessOutput(child, output) {
  child.stdout?.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr?.on('data', (chunk) => output.push(chunk.toString()))
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
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
  if (child.exitCode !== null) {
    return
  }
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
