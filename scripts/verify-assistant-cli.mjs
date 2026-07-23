// End-to-end check: drive the desktop assistant UI with Codex and Claude Code providers.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')
const outputDirectory = resolve('test/output/ui-screenshots')
const PROVIDERS = ['claude-local', 'codex-local']

async function reservePort() {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  await new Promise((r) => server.close(r))
  return port
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-ai-'))
const csvPath = join(temporaryDirectory, 'sales.csv')
await mkdir(outputDirectory, { recursive: true })
await writeFile(csvPath, 'region,revenue\nnorth,1200\nsouth,980\n')

const port = await reservePort()
const applicationProcess = spawn(electronExecutable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(temporaryDirectory, 'profile')}`,
  applicationEntry,
  csvPath,
], { cwd: repositoryRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

const stopProcess = async () => {
  if (applicationProcess.exitCode !== null) return
  spawn('taskkill.exe', ['/pid', String(applicationProcess.pid), '/t', '/f'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 1500))
}

const results = {}
try {
  let browser
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      const { webSocketDebuggerUrl } = await response.json()
      browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null })
      break
    } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  const page = (await browser.pages())[0]
  await page.waitForSelector('.document-tab', { timeout: 30_000 })
  await page.waitForSelector('.document-assistant__launcher', { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 3000)) // let provider probes settle
  await page.click('.document-assistant__launcher')
  await page.waitForSelector('.document-assistant__panel', { timeout: 15_000 })
  await new Promise((r) => setTimeout(r, 500))

  const options = await page.evaluate(() => {
    const select = document.querySelector('.document-assistant__model-select select')
    return select ? [...select.options].map((item) => ({ value: item.value, disabled: item.disabled, text: item.textContent })) : null
  })
  console.log('model options:', JSON.stringify(options))

  for (const providerId of PROVIDERS) {
    try {
      const selected = await page.evaluate((id) => {
        const select = document.querySelector('.document-assistant__model-select select')
        if (!select) return 'no-select'
        const option = [...select.options].find((item) => item.value === id)
        if (!option) return 'missing'
        if (option.disabled) return `disabled:${option.textContent}`
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        setter.call(select, id)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return 'ok'
      }, providerId)
      if (selected !== 'ok') { results[providerId] = `SKIPPED (${selected})`; continue }

      await page.evaluate(() => {
        const textarea = document.querySelector('.document-assistant__input-wrap textarea')
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(textarea, '请用 Markdown 富格式总结这个文件：包含一个二级标题、一个要点列表、一个两列的 Markdown 表格，以及一小段 JSON 代码块。')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await new Promise((r) => setTimeout(r, 300))
      await page.click('.document-assistant__send')

      const outcome = await page.waitForFunction(() => {
        const error = document.querySelector('.document-assistant__error span')
        if (error?.textContent?.trim()) return { kind: 'error', text: error.textContent.trim() }
        const messages = [...document.querySelectorAll('.document-assistant__message.is-assistant .document-assistant__message-content')]
        const last = messages.at(-1)
        const pending = document.querySelector('.document-assistant__message.is-pending')
        if (last?.textContent?.trim() && !pending) return { kind: 'ok', text: last.textContent.trim().slice(0, 300) }
        return false
      }, { timeout: 170_000, polling: 1000 }).then((handle) => handle.jsonValue()).catch(() => ({ kind: 'timeout', text: '' }))
      results[providerId] = `${outcome.kind.toUpperCase()}: ${outcome.text}`
      await page.screenshot({ path: join(outputDirectory, `assistant-e2e-${providerId}.png`) })
    } catch (reason) {
      results[providerId] = `SCRIPT-ERROR: ${reason instanceof Error ? reason.message.split('\n')[0] : String(reason)}`
      await page.screenshot({ path: join(outputDirectory, `assistant-e2e-${providerId}-error.png`) }).catch(() => undefined)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  await browser.disconnect()
} finally {
  await stopProcess()
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
console.log(JSON.stringify(results, null, 2))
