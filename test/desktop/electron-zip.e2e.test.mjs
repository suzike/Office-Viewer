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

test('desktop renders the original ZIP UI, browses folders, and blocks damaged or traversal archives', { timeout: 90_000 }, async (t) => {
  assert.equal(process.platform, 'win32')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-zip-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const validPath = join(temporaryDirectory, 'valid.zip')
  const damagedPath = join(temporaryDirectory, 'damaged.zip')
  const traversalPath = join(temporaryDirectory, 'traversal.zip')
  await Promise.all([
    createValidZip(validPath),
    createTraversalZip(traversalPath),
    writeFile(damagedPath, Buffer.from('not-a-valid-zip')),
  ])

  const port = await reservePort()
  const output = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    traversalPath,
    damagedPath,
    validPath,
  ], { cwd: repositoryRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  collectOutput(applicationProcess, output)

  let browser
  let page
  t.after(async () => {
    if (page && !page.isClosed()) await page.close().catch(() => undefined)
    browser?.disconnect()
    await stopProcess(applicationProcess)
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  browser = await connect(port, applicationProcess, output)
  page = await waitForApplicationPage(browser)
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.waitForSelector('.desktop-shell', { timeout: 30_000 })
  await waitForActiveTab(page, basename(validPath), 3)
  await page.waitForSelector('.zip-viewer .zip-toolbar', { timeout: 30_000 })
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.zip-table-row .zip-file-name')]
    return rows.some((row) => row.textContent?.includes('folder')) && rows.some((row) => row.textContent?.includes('root.txt'))
  })
  assert.equal(await page.$('.archive-load-error'), null)

  const openedFolder = await page.$$eval('.zip-table-row', (rows) => {
    const row = rows.find((candidate) => candidate.querySelector('.zip-file-name')?.textContent?.includes('folder'))
    if (!row) return false
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 5 }))
    row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 5, clientY: 5 }))
    row.click()
    return true
  })
  assert.equal(openedFolder, true)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.zip-table-row .zip-file-name')].some((row) => row.textContent?.includes('nested.txt')))
  assert.match(await page.$eval('.zip-path', (element) => element.textContent), /folder/)

  await activateTab(page, basename(damagedPath))
  await page.waitForSelector('.archive-load-error', { timeout: 30_000 })
  assert.match(await page.$eval('.archive-load-error', (element) => element.textContent), /Invalid or damaged ZIP archive/i)

  await activateTab(page, basename(traversalPath))
  await page.waitForSelector('.archive-load-error', { timeout: 30_000 })
  assert.match(await page.$eval('.archive-load-error', (element) => element.textContent), /Unsafe archive entry path/i)

  assert.deepEqual(consoleErrors, [], `Renderer console errors:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function createValidZip(filePath) {
  const zip = new JSZip()
  zip.file('root.txt', 'root entry')
  zip.file('folder/nested.txt', 'nested entry')
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

async function createTraversalZip(filePath) {
  const zip = new JSZip()
  zip.file('aaa/evil.txt', 'must not escape')
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const from = Buffer.from('aaa/evil.txt')
  const to = Buffer.from('../xevil.txt')
  let replacements = 0
  for (let offset = bytes.indexOf(from); offset >= 0; offset = bytes.indexOf(from, offset + to.length)) {
    to.copy(bytes, offset)
    replacements += 1
  }
  assert.equal(replacements, 2, 'Fixture must patch both local and central ZIP filenames.')
  await writeFile(filePath, bytes)
}

async function waitForActiveTab(page, name, count) {
  await page.waitForFunction((expected, expectedCount) =>
    document.querySelectorAll('.document-tab').length === expectedCount &&
    document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === expected,
  { timeout: 30_000 }, name, count)
}

async function activateTab(page, name) {
  const found = await page.$$eval('.document-tab', (tabs, expected) => {
    const tab = tabs.find((candidate) => candidate.querySelector('.document-tab__name')?.textContent === expected)
    if (!tab) return false
    tab.click()
    return true
  }, name)
  assert.equal(found, true)
  await page.waitForFunction((expected) =>
    document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === expected,
  { timeout: 30_000 }, name)
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

async function connect(port, child, output) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early.\n${output.join('')}`)
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }) } catch (error) { lastError = error }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
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
  throw new Error('Timed out waiting for desktop renderer.')
}

function collectOutput(child, output) {
  child.stdout?.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr?.on('data', (chunk) => output.push(chunk.toString()))
}

async function stopProcess(child) {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    await once(killer, 'exit').catch(() => undefined)
    return
  }
  if (child.exitCode === null) child.kill()
}
