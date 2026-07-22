import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')
const memorySamplerPath = resolve('scripts/performance/sample-electron-memory.ps1')

export function launchDesktop({ profileDirectory, documentPaths = [], remoteDebuggingPort, packagedExecutable }) {
  const executable = packagedExecutable ? resolve(packagedExecutable) : electronExecutable
  const applicationArguments = packagedExecutable ? [] : [applicationEntry]
  const argumentsList = [
    ...(remoteDebuggingPort ? [`--remote-debugging-port=${remoteDebuggingPort}`] : []),
    `--user-data-dir=${profileDirectory}`,
    ...applicationArguments,
    ...documentPaths,
  ]
  const output = []
  const child = spawn(executable, argumentsList, {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr?.on('data', (chunk) => output.push(chunk.toString()))
  return { child, output }
}

export async function connectToDesktop(port, child, output, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before DevTools became available.\n${output.join('')}`)
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` })
    } catch (error) {
      lastError = error
      await delay(80)
    }
  }
  throw new Error(`Timed out connecting to Electron DevTools: ${lastError}\n${output.join('')}`)
}

export async function waitForApplicationPage(browser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = (await browser.pages()).find((candidate) => candidate.url().includes('index.desktop.html'))
    if (page) return page
    await delay(80)
  }
  throw new Error('Timed out waiting for the Office Viewer renderer page.')
}

export async function waitForStableShell(page) {
  await page.waitForSelector('.desktop-shell', { visible: true, timeout: 30_000 })
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
}

export async function waitForWorkbook(page, name, expectedCell) {
  await page.waitForFunction((targetName, cell) => {
    return document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === targetName &&
      document.querySelector('.excel-app .x-spreadsheet') !== null &&
      document.querySelector('.excel-load-error') === null &&
      document.querySelector('.x-spreadsheet-formula-bar-input')?.value === cell
  }, { timeout: 30_000 }, name, expectedCell)
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
}

export async function measureTabSwitch(page, name, expectedCell) {
  return page.evaluate(async (targetName, cell) => {
    const target = [...document.querySelectorAll('.document-tab')]
      .find((tab) => tab.querySelector('.document-tab__name')?.textContent === targetName)
    if (!(target instanceof HTMLElement)) throw new Error(`Document tab not found: ${targetName}`)
    const start = performance.now()
    target.click()
    const deadline = performance.now() + 30_000
    while (performance.now() < deadline) {
      const ready = document.querySelector('.document-tab.is-active .document-tab__name')?.textContent === targetName &&
        document.querySelector('.excel-app .x-spreadsheet') !== null &&
        document.querySelector('.excel-load-error') === null &&
        document.querySelector('.x-spreadsheet-formula-bar-input')?.value === cell
      if (ready) {
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
        return performance.now() - start
      }
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
    }
    throw new Error(`Timed out switching to ${targetName}`)
  }, name, expectedCell)
}

export function createDeterministicAiServer({ firstChunkDelayMs = 60 } = {}) {
  let capturedPrompt = ''
  const server = createHttpServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    try {
      capturedPrompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages?.[0]?.content ?? ''
    } catch {
      capturedPrompt = ''
    }
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    await delay(firstChunkDelayMs)
    response.write('{"message":{"content":"基准首字"}}\n')
    await delay(25)
    response.end('{"message":{"content":"：本地流式响应完成。"}}\n')
  })
  return {
    server,
    getCapturedPrompt: () => capturedPrompt,
  }
}

export async function configureLocalAiProvider(page, port) {
  const providerId = await page.evaluate(async (mockPort) => {
    const current = await window.officeDesktop.loadAiAssistantSettings()
    const id = `custom-perf-${crypto.randomUUID().slice(0, 8)}`
    await window.officeDesktop.saveAiAssistantSettings({
      activeProviderId: id,
      contextCharacterLimit: current.contextCharacterLimit,
      providers: [
        ...current.providers,
        {
          id,
          name: 'Office Viewer 性能基准模型',
          kind: 'ollama',
          enabled: true,
          model: 'office-viewer-perf-mock',
          baseUrl: `http://127.0.0.1:${mockPort}`,
          allowPrivateNetwork: true,
        },
      ],
    })
    return id
  }, port)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
  await waitForStableShell(page)
  await page.waitForSelector('.document-assistant__launcher', { visible: true, timeout: 30_000 })
  await page.$eval('.document-assistant__launcher', (button) => button.click())
  await page.waitForSelector('.document-assistant__panel', { visible: true, timeout: 10_000 })
  await page.waitForFunction((expectedId) => document.querySelector('.document-assistant__model-select select')?.value === expectedId, { timeout: 20_000 }, providerId)
}

export async function measureAiFirstToken(page, prompt, expectedToken = '基准首字') {
  await page.focus('.document-assistant__input-wrap textarea')
  await page.keyboard.type(prompt)
  await page.waitForFunction(() => {
    const send = document.querySelector('.document-assistant__send')
    const input = document.querySelector('.document-assistant__input-wrap textarea')
    return send instanceof HTMLButtonElement && !send.disabled && input instanceof HTMLTextAreaElement && Boolean(input.value.trim())
  }, { timeout: 10_000 })
  try {
    return await page.evaluate((token) => new Promise((resolveMeasure, rejectMeasure) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        rejectMeasure(new Error('Timed out waiting for the first AI text token.'))
      }, 30_000)
      const started = performance.now()
      const readFirstText = () => {
        const content = document.querySelector('.document-assistant__message.is-assistant .document-assistant__message-content')?.textContent?.trim()
        if (!content?.includes(token)) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolveMeasure(performance.now() - started)
      }
      const observer = new MutationObserver(readFirstText)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      const send = document.querySelector('.document-assistant__send')
      if (!(send instanceof HTMLButtonElement)) {
        window.clearTimeout(timeout)
        observer.disconnect()
        rejectMeasure(new Error('AI send button was not found.'))
        return
      }
      send.click()
      readFirstText()
    }), expectedToken)
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const send = document.querySelector('.document-assistant__send')
      const select = document.querySelector('.document-assistant__model-select select')
      const input = document.querySelector('.document-assistant__input-wrap textarea')
      return {
        sendDisabled: send instanceof HTMLButtonElement ? send.disabled : null,
        sendLabel: send?.getAttribute('aria-label') ?? null,
        modelId: select instanceof HTMLSelectElement ? select.value : null,
        inputCharacters: input instanceof HTMLTextAreaElement ? input.value.length : null,
        assistantText: document.querySelector('.document-assistant__message.is-assistant .document-assistant__message-content')?.textContent?.trim() ?? null,
        errorText: document.querySelector('.document-assistant__error')?.textContent?.trim() ?? null,
        thinkingText: document.querySelector('.document-assistant__thinking')?.textContent?.trim() ?? null,
      }
    })
    throw new Error(`${error instanceof Error ? error.message : String(error)} Diagnostics: ${JSON.stringify(diagnostics)}`)
  }
}

export function startMemorySampler(rootProcessId, processMapPath, intervalMilliseconds = 100) {
  const samples = []
  const errors = []
  let processRoles = { [rootProcessId]: 'main' }
  writeProcessMap(processMapPath, processRoles)
  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', memorySamplerPath,
    '-RootProcessId', String(rootProcessId),
    '-ProcessMapPath', processMapPath,
    '-IntervalMilliseconds', String(intervalMilliseconds),
  ], { cwd: repositoryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let pending = ''
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { samples.push(JSON.parse(line)) } catch { errors.push(`Invalid sampler output: ${line}`) }
    }
  })
  child.stderr.on('data', (chunk) => errors.push(chunk.toString()))
  return {
    samples,
    errors,
    async waitForSamples(minimumCount, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      while (samples.length < minimumCount && Date.now() < deadline) await delay(20)
      if (samples.length < minimumCount) throw new Error(`Memory sampler did not produce ${minimumCount} sample(s). ${errors.join('\n')}`)
    },
    async discoverBrowserProcesses(browser) {
      const session = await browser.target().createCDPSession()
      try {
        const information = await session.send('SystemInfo.getProcessInfo')
        processRoles = { [rootProcessId]: 'main' }
        for (const entry of information.processInfo) {
          const id = Number(entry.id)
          if (Number.isInteger(id) && id > 0) processRoles[id] = entry.type === 'renderer' ? 'renderer' : 'other'
        }
        processRoles[rootProcessId] = 'main'
        writeProcessMap(processMapPath, processRoles)
      } finally {
        await session.detach().catch(() => undefined)
      }
    },
    async stop() {
      if (child.exitCode === null) child.kill()
      await Promise.race([once(child, 'exit'), delay(3_000)]).catch(() => undefined)
    },
  }
}

function writeProcessMap(path, roles) {
  writeFileSync(path, JSON.stringify(roles), 'utf8')
}

export async function reservePort() {
  const server = createHttpServer()
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await closeServer(server)
  return address.port
}

export function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
}

export function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
}

export async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([once(child, 'exit'), delay(5_000)]).catch(() => undefined)
  if (child.exitCode === null && process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    await once(killer, 'exit').catch(() => undefined)
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
