import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import puppeteer from 'puppeteer-core'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop opens the original Git History file frontend from the active document', { timeout: 120_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-git-history-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const gitRepository = join(temporaryDirectory, 'repository')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(gitRepository))
  const documentPath = join(gitRepository, 'history.md')
  await git(gitRepository, ['init', '-b', 'main'])
  await git(gitRepository, ['config', 'user.name', 'Office Viewer Test'])
  await git(gitRepository, ['config', 'user.email', 'office-viewer@example.invalid'])
  await writeFile(documentPath, '# Initial\n', 'utf8')
  await git(gitRepository, ['add', 'history.md'])
  await git(gitRepository, ['commit', '-m', 'Initial document'])
  await writeFile(documentPath, '# Updated\n\nSecond revision.\n', 'utf8')
  await git(gitRepository, ['commit', '-am', 'Update document'])

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

  await page.waitForSelector('.git-history-entry', { timeout: 30_000 })
  await page.$eval('.git-history-entry', (button) => button.click())
  await page.waitForSelector('.desktop-git-launcher', { timeout: 30_000 })
  await page.$$eval('.desktop-git-launcher__actions button', (buttons) => {
    const target = buttons.find((button) => button.textContent?.includes('当前文件历史'))
    if (!(target instanceof HTMLElement)) throw new Error('Missing active file history command')
    target.click()
  })

  await page.waitForSelector('.git-graph:not(.git-graph-loading):not(.git-graph-empty) .git-graph-table-body', { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('.git-graph-row').length >= 2, { timeout: 30_000 })
  assert.match(await page.$eval('.git-graph-file-banner-path', (element) => element.textContent ?? ''), /history\.md$/)
  const messages = await page.$$eval('.git-graph-message', (items) => items.map((item) => item.textContent?.trim()))
  assert.ok(messages.includes('Initial document'))
  assert.ok(messages.includes('Update document'))
  for (const title of ['Refresh', 'Fetch from remote(s)', 'Find in commit history (Ctrl+F)', 'Repository settings']) {
    assert.notEqual(await page.$(`.git-graph-icon-btn[aria-label="${title}"]`), null, `Missing original Git History control: ${title}`)
  }
  assert.equal(await page.$$eval('.git-history-entry', buttons => buttons.some(button => button.textContent?.includes('Quick Sync'))), false)
  await page.$eval('.git-graph-icon-btn[aria-label="Repository settings"]', button => button.click())
  await page.waitForSelector('.git-graph-settings-panel[aria-label="Settings"]')
  await page.$$eval('.git-graph-settings-checkbox', labels => {
    const target = labels.find(label => label.textContent?.includes('Show Quick Sync button'))
    const checkbox = target?.querySelector('input[type="checkbox"]')
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('Quick Sync preference was not found.')
    checkbox.click()
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.git-history-entry')].some(button => button.textContent?.includes('Quick Sync')))
  assert.equal(await page.evaluate(() => localStorage.getItem('office-desktop-git-quick-sync')), 'true')
  await page.$eval('.git-graph-settings-group-header button[title="Close"]', button => button.click())
  await page.waitForFunction(() => document.querySelector('.git-graph-settings-panel') === null)

  await page.$eval('.git-graph-row', (row) => row.click())
  await page.waitForSelector('.git-graph-cdv', { timeout: 30_000 })
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))
  const detailText = await page.$eval('.git-graph-cdv', (element) => element.textContent ?? '')
  assert.match(detailText, /Update document|Initial document/)
  assert.match(detailText, /history\.md/)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.git-graph-cdv'), { timeout: 10_000 })
  await page.click('.git-graph-row', { button: 'right' })
  await page.waitForSelector('.git-graph-context-menu', { timeout: 10_000 })
  await page.keyboard.press('Escape')

  assert.deepEqual(consoleErrors, [], `Renderer console errors:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd, windowsHide: true })
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
