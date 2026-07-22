import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const SevenZip = require('7z-wasm').default ?? require('7z-wasm')
const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')
const RAR_FIXTURE = Buffer.from(
  'UmFyIRoHAM+QcwAADQAAAAAAAABE/XoAgCMAgAAAAHoAAAACz49u6RBWg0odMwMAAQAAAENNVAmRgUj+DP8lkhMHmASQ/weSuB6qBLpR5hAVgRbmhpQWpwFwlqcBRG9wBoQb3AUVFEaPLh/UcHHZN9gfx3H2G+QkNBsch2H4MKM+zftKitd/U8v3gxvoX2/UcRvxeGKIAjgjoh5Na88O461qTz+RPsmM0mwzF0ymRT9FY9y5doe1zHl0IJAuAAAAAAAAAAAAAgAAAAA1VYNKHTAJACAAAAAxRmlsZS50eHQAsCZjiozxdCCSNAAAAAAAAAAAAAIAAAAAOlWDSh0wDwAgAAAAMj8/LnR4dABOGzIth2UCALAgORXEPXsAQAcA',
  'base64',
)

test('desktop renders the original archive UI for 7z, RAR, TAR, TAR.GZ, and TGZ', { timeout: 150_000 }, async (t) => {
  assert.equal(process.platform, 'win32')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-nonzip-e2e-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const tar = createTar([{ name: 'folder/hello.txt', contents: Buffer.from('hello tar') }])
  const validFiles = [
    { name: 'valid.7z', contents: await createSevenZip(), expected: 'folder' },
    { name: 'valid.rar', contents: RAR_FIXTURE, expected: '1File.txt' },
    { name: 'valid.tar', contents: tar, expected: 'folder' },
    { name: 'valid.tar.gz', contents: gzipSync(tar), expected: 'folder' },
    { name: 'valid.tgz', contents: gzipSync(tar), expected: 'folder' },
  ]
  const damagedFiles = ['damaged.7z', 'damaged.rar', 'damaged.tar', 'damaged.tar.gz', 'damaged.tgz']
    .map((name) => ({ name, contents: Buffer.from('not-a-valid-archive') }))
  await Promise.all([...damagedFiles, ...validFiles].map((file) => writeFile(join(temporaryDirectory, file.name), file.contents)))

  const paths = [...damagedFiles, ...validFiles].map((file) => join(temporaryDirectory, file.name))
  const port = await reservePort()
  const output = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    ...paths,
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
  await waitForActiveTab(page, basename(paths.at(-1)), paths.length)

  for (const fixture of validFiles) {
    await activateTab(page, fixture.name)
    await page.waitForSelector('.zip-viewer .zip-toolbar', { timeout: 30_000 })
    await page.waitForFunction((expected) =>
      [...document.querySelectorAll('.zip-table-row .zip-file-name')]
        .some((row) => row.textContent?.includes(expected)),
    { timeout: 30_000 }, fixture.expected)
    assert.equal(await page.$('.archive-load-error'), null)
    assert.equal(await page.$('.zip-delete-btn'), null, `${fixture.name} must remain read-only`)
    assert.equal(await page.$$eval('.zip-toolbar-left .zip-btn', (buttons) => buttons.length), 4)
  }

  for (const fixture of damagedFiles) {
    await activateTab(page, fixture.name)
    await page.waitForSelector('.archive-load-error', { timeout: 30_000 })
    assert.match(await page.$eval('.archive-load-error', (element) => element.textContent), /archive|TAR|7z|RAR/i)
  }

  assert.deepEqual(consoleErrors, [], `Renderer console errors:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function createSevenZip() {
  const module = await SevenZip({ stdout: () => undefined, stderr: () => undefined })
  module.FS.mkdir('folder')
  module.FS.writeFile('folder/hello.txt', Buffer.from('hello 7z'))
  module.callMain(['a', 'valid.7z', 'folder/hello.txt'])
  return module.FS.readFile('valid.7z')
}

function createTar(entries) {
  const chunks = []
  for (const entry of entries) {
    const contents = entry.contents ?? Buffer.alloc(0)
    const header = Buffer.alloc(512)
    writeTarString(header, entry.name, 0, 100)
    writeTarOctal(header, 0o644, 100, 8)
    writeTarOctal(header, 0, 108, 8)
    writeTarOctal(header, 0, 116, 8)
    writeTarOctal(header, contents.byteLength, 124, 12)
    writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12)
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    writeTarString(header, 'ustar', 257, 6)
    writeTarString(header, '00', 263, 2)
    const checksum = header.reduce((sum, value) => sum + value, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    chunks.push(header, contents)
    const padding = (512 - (contents.byteLength % 512)) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function writeTarString(header, value, offset, length) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

function writeTarOctal(header, value, offset, length) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
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
