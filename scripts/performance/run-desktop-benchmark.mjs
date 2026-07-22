import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpus, freemem, hostname, platform, release, tmpdir, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import {
  closeServer,
  configureLocalAiProvider,
  connectToDesktop,
  createDeterministicAiServer,
  launchDesktop,
  listen,
  measureAiFirstToken,
  measureTabSwitch,
  reservePort,
  startMemorySampler,
  stopProcess,
  waitForApplicationPage,
  waitForStableShell,
  waitForWorkbook,
} from '../../test/desktop/performance/desktop-benchmark-harness.mjs'
import {
  DEFAULT_COMPARISON_POLICY,
  DEFAULT_THRESHOLDS,
  compareWithBaseline,
  evaluateThresholds,
} from '../../test/desktop/performance/thresholds.mjs'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const packageJson = require('../../package.json')
const BYTES_PER_MIB = 1024 * 1024

const options = parseArguments(process.argv.slice(2))
const runStartedAt = new Date()
const outputPath = resolve(options.output ?? 'docs/performance/results/latest.json')
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-performance-'))
const profileDirectory = join(temporaryDirectory, 'electron-profile')
const firstWorkbookPath = join(temporaryDirectory, 'performance-first.xlsx')
const secondWorkbookPath = join(temporaryDirectory, 'performance-second.xlsx')
const secondaryProcesses = []
let desktopProcess
let memorySampler
let browser
let page
let aiServer

try {
  assert.equal(process.platform, 'win32', 'The real desktop performance benchmark currently requires Windows.')
  createWorkbookFixture(firstWorkbookPath, 'PERF-FIRST')
  createWorkbookFixture(secondWorkbookPath, 'PERF-SECOND')

  const mock = createDeterministicAiServer({ firstChunkDelayMs: options.mockDelayMs })
  aiServer = mock.server
  await listen(aiServer)
  const aiAddress = aiServer.address()
  assert.ok(aiAddress && typeof aiAddress !== 'string')

  const remoteDebuggingPort = await reservePort()
  const coldStartMark = performance.now()
  const launched = launchDesktop({
    profileDirectory,
    remoteDebuggingPort,
    packagedExecutable: options.packagedExecutable,
  })
  desktopProcess = launched.child
  assert.ok(desktopProcess.pid, 'Electron main process did not expose a process id.')
  memorySampler = startMemorySampler(desktopProcess.pid, join(temporaryDirectory, 'performance-process-map.json'), options.memorySampleIntervalMs)
  ;[browser] = await Promise.all([
    connectToDesktop(remoteDebuggingPort, desktopProcess, launched.output),
    memorySampler.waitForSamples(1),
  ])
  await memorySampler.discoverBrowserProcesses(browser)
  page = await waitForApplicationPage(browser)
  await page.setViewport({ width: 1440, height: 900 })
  await waitForStableShell(page)
  const coldStartMs = performance.now() - coldStartMark

  const firstDocumentMark = performance.now()
  secondaryProcesses.push(launchDesktop({
    profileDirectory,
    documentPaths: [firstWorkbookPath],
    packagedExecutable: options.packagedExecutable,
  }).child)
  await waitForWorkbook(page, basename(firstWorkbookPath), 'PERF-FIRST')
  const firstDocumentOpenMs = performance.now() - firstDocumentMark

  secondaryProcesses.push(launchDesktop({
    profileDirectory,
    documentPaths: [secondWorkbookPath],
    packagedExecutable: options.packagedExecutable,
  }).child)
  await waitForWorkbook(page, basename(secondWorkbookPath), 'PERF-SECOND')

  const tabSwitchSamplesMs = []
  for (let index = 0; index < options.switchIterations; index += 1) {
    const useFirst = index % 2 === 0
    tabSwitchSamplesMs.push(await measureTabSwitch(
      page,
      basename(useFirst ? firstWorkbookPath : secondWorkbookPath),
      useFirst ? 'PERF-FIRST' : 'PERF-SECOND',
    ))
  }

  await configureLocalAiProvider(page, aiAddress.port)
  secondaryProcesses.push(launchDesktop({
    profileDirectory,
    documentPaths: [secondWorkbookPath],
    packagedExecutable: options.packagedExecutable,
  }).child)
  await waitForWorkbook(page, basename(secondWorkbookPath), 'PERF-SECOND')
  const aiFirstTokenMs = await measureAiFirstToken(page, '请基于当前工作簿给出一句结论。')
  await page.waitForFunction(() => document.querySelector('.document-assistant__message.is-assistant .document-assistant__message-content')?.textContent?.includes('本地流式响应完成'), { timeout: 30_000 })
  assert.match(mock.getCapturedPrompt(), /PERF-(FIRST|SECOND)/, 'The mock AI request must include real workbook context.')

  await delay(Math.max(400, options.memorySampleIntervalMs * 3))
  await memorySampler.stop()
  assert.ok(memorySampler.samples.length >= 20, `Memory sampler produced only ${memorySampler.samples.length} samples; at least 20 are required. ${memorySampler.errors.join('\n')}`)

  const memory = summarizeMemory(memorySampler.samples)
  const switchStatistics = summarizeSamples(tabSwitchSamplesMs)
  const comparableValues = {
    coldStartMs: round(coldStartMs),
    firstDocumentOpenMs: round(firstDocumentOpenMs),
    tabSwitchP95Ms: switchStatistics.p95,
    aiFirstTokenMs: round(aiFirstTokenMs),
    mainProcessPeakMb: memory.mainProcessPeakMb,
    rendererProcessesPeakMb: memory.rendererProcessesPeakMb,
    totalProcessTreePeakMb: memory.totalProcessTreePeakMb,
  }
  const thresholdEvaluation = evaluateThresholds(comparableValues)
  const baseline = options.baseline ? JSON.parse(await readFile(resolve(options.baseline), 'utf8')) : null
  const comparison = baseline
    ? compareWithBaseline(comparableValues, readComparableValues(baseline))
    : null

  const result = {
    schemaVersion: 1,
    benchmark: 'office-viewer-real-desktop-performance',
    generatedAt: new Date().toISOString(),
    runId: runStartedAt.toISOString().replace(/[:.]/g, '-'),
    source: readSourceState(),
    environment: {
      hostname: hostname(),
      platform: platform(),
      osRelease: release(),
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryMiB: round(totalmem() / BYTES_PER_MIB),
      freeMemoryAtReportMiB: round(freemem() / BYTES_PER_MIB),
      nodeVersion: process.version,
      electronVersion: packageJson.devDependencies?.electron ?? packageJson.dependencies?.electron ?? 'unknown',
      runtime: options.packagedExecutable ? 'packaged-win-unpacked' : 'development-build',
      executable: options.packagedExecutable ? resolve(options.packagedExecutable) : resolve('node_modules/electron/dist/electron.exe'),
    },
    isolation: {
      userDataDirectory: 'temporary-and-deleted-after-run',
      externalLlmCalled: false,
      aiTransport: '127.0.0.1 deterministic NDJSON mock through production AI IPC/service path',
      fixture: 'generated real XLSX workbooks, 480 data rows × 12 columns each',
    },
    configuration: {
      viewport: { width: 1440, height: 900 },
      switchIterations: options.switchIterations,
      mockFirstChunkDelayMs: options.mockDelayMs,
      memorySampleIntervalMs: options.memorySampleIntervalMs,
    },
    metrics: {
      coldStart: {
        unit: 'ms',
        start: 'immediately before spawning the primary Electron process with an empty temporary profile',
        end: 'second requestAnimationFrame after the visible .desktop-shell is attached',
        samples: [round(coldStartMs)],
        value: round(coldStartMs),
      },
      firstDocumentOpen: {
        unit: 'ms',
        start: 'immediately before spawning a second instance that hands a real XLSX path to the primary instance',
        end: 'active tab, spreadsheet surface, expected A1 formula-bar value, and two animation frames are ready',
        samples: [round(firstDocumentOpenMs)],
        value: round(firstDocumentOpenMs),
      },
      tabSwitch: {
        unit: 'ms',
        start: 'renderer performance.now immediately before clicking the target document tab',
        end: 'target tab, spreadsheet surface, target A1 value, and two animation frames are ready',
        samples: tabSwitchSamplesMs.map((value) => round(value)),
        ...switchStatistics,
        comparisonValue: 'p95',
      },
      aiFirstToken: {
        unit: 'ms',
        start: 'renderer performance.now immediately before clicking Send',
        end: 'first non-empty assistant text mutation reaches the renderer',
        samples: [round(aiFirstTokenMs)],
        value: round(aiFirstTokenMs),
        note: `Includes workbook extraction, IPC, production provider request, and a fixed ${options.mockDelayMs} ms mock-model delay.`,
      },
      memory: {
        unit: 'MiB working set',
        start: 'sampler begins immediately after the primary Electron process is spawned',
        end: 'after the final streamed AI response is rendered',
        sampleIntervalMs: options.memorySampleIntervalMs,
        observedSampleIntervalMs: memory.observedSampleIntervalMs,
        sampleCount: memorySampler.samples.length,
        mainProcessPeakMb: memory.mainProcessPeakMb,
        rendererProcessesPeakMb: memory.rendererProcessesPeakMb,
        totalProcessTreePeakMb: memory.totalProcessTreePeakMb,
        maximumProcessCount: memory.maximumProcessCount,
        maximumRendererCount: memory.maximumRendererCount,
      },
    },
    summary: {
      comparableValues,
      thresholds: {
        enforcement: options.enforce ? 'enforced' : 'advisory',
        budgets: DEFAULT_THRESHOLDS,
        ...thresholdEvaluation,
      },
      baselineComparison: comparison,
    },
    diagnostics: {
      memorySamplerErrors: memorySampler.errors,
    },
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  printSummary(result, outputPath)

  if (options.enforce && (!thresholdEvaluation.allPassed || comparison && !comparison.passed)) {
    process.exitCode = 1
  }
} finally {
  await memorySampler?.stop().catch(() => undefined)
  if (page && !page.isClosed()) await page.close().catch(() => undefined)
  browser?.disconnect()
  for (const secondary of secondaryProcesses) await stopProcess(secondary).catch(() => undefined)
  if (desktopProcess) await stopProcess(desktopProcess).catch(() => undefined)
  if (aiServer) await closeServer(aiServer).catch(() => undefined)
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
}

function createWorkbookFixture(filePath, marker) {
  const rows = [[marker, 'Office Viewer performance benchmark', 'Generated fixture', new Date(0).toISOString()]]
  for (let row = 1; row <= 480; row += 1) {
    rows.push(Array.from({ length: 12 }, (_, column) => column === 0 ? `ROW-${row}` : row * (column + 1)))
  }
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Performance Data')
  XLSX.writeFile(workbook, filePath, { compression: true })
}

function summarizeSamples(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  }
}

function percentile(sorted, quantile) {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  return round(sorted[index])
}

function summarizeMemory(samples) {
  const observedIntervals = samples.slice(1).map((sample, index) => sample.timestampUnixMs - samples[index].timestampUnixMs)
  return {
    mainProcessPeakMb: round(Math.max(...samples.map((sample) => sample.mainBytes)) / BYTES_PER_MIB),
    rendererProcessesPeakMb: round(Math.max(...samples.map((sample) => sample.rendererBytes)) / BYTES_PER_MIB),
    totalProcessTreePeakMb: round(Math.max(...samples.map((sample) => sample.totalBytes)) / BYTES_PER_MIB),
    maximumProcessCount: Math.max(...samples.map((sample) => sample.processCount)),
    maximumRendererCount: Math.max(...samples.map((sample) => sample.rendererCount)),
    observedSampleIntervalMs: observedIntervals.length ? summarizeSamples(observedIntervals) : null,
  }
}

function readComparableValues(result) {
  const values = result?.summary?.comparableValues
  if (!values || typeof values !== 'object') throw new Error('Baseline JSON does not contain summary.comparableValues.')
  return values
}

function readSourceState() {
  try {
    return {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    }
  } catch {
    return { commit: null, dirty: null }
  }
}

function printSummary(result, path) {
  const values = result.summary.comparableValues
  console.log(`\nOffice Viewer desktop performance benchmark`)
  console.log(`  Cold start:             ${values.coldStartMs} ms`)
  console.log(`  First XLSX open:        ${values.firstDocumentOpenMs} ms`)
  console.log(`  Tab switch p95:         ${values.tabSwitchP95Ms} ms`)
  console.log(`  AI first token:         ${values.aiFirstTokenMs} ms`)
  console.log(`  Main peak:              ${values.mainProcessPeakMb} MiB`)
  console.log(`  Renderer peak:          ${values.rendererProcessesPeakMb} MiB`)
  console.log(`  Process-tree peak:      ${values.totalProcessTreePeakMb} MiB`)
  console.log(`  Absolute budgets:       ${result.summary.thresholds.allPassed ? 'PASS' : 'ADVISORY FAIL'}`)
  if (result.summary.baselineComparison) console.log(`  Baseline comparison:    ${result.summary.baselineComparison.passed ? 'PASS' : 'REGRESSION'}`)
  console.log(`  JSON result:            ${path}\n`)
}

function parseArguments(argumentsList) {
  const parsed = {
    output: null,
    baseline: null,
    packagedExecutable: process.env.OFFICE_VIEWER_PACKAGED_EXECUTABLE || null,
    enforce: false,
    switchIterations: 6,
    mockDelayMs: 60,
    memorySampleIntervalMs: 100,
  }
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--enforce') parsed.enforce = true
    else if (argument === '--output') parsed.output = requiredValue(argumentsList, ++index, argument)
    else if (argument === '--baseline') parsed.baseline = requiredValue(argumentsList, ++index, argument)
    else if (argument === '--packaged') parsed.packagedExecutable = requiredValue(argumentsList, ++index, argument)
    else if (argument === '--switch-iterations') parsed.switchIterations = positiveInteger(requiredValue(argumentsList, ++index, argument), argument)
    else if (argument === '--mock-delay-ms') parsed.mockDelayMs = positiveInteger(requiredValue(argumentsList, ++index, argument), argument)
    else if (argument === '--memory-sample-ms') parsed.memorySampleIntervalMs = positiveInteger(requiredValue(argumentsList, ++index, argument), argument)
    else if (argument === '--help') {
      console.log('Usage: node scripts/performance/run-desktop-benchmark.mjs [--output path] [--baseline path] [--packaged exe] [--enforce]')
      process.exit(0)
    } else throw new Error(`Unknown argument: ${argument}`)
  }
  if (parsed.switchIterations < 2) throw new Error('--switch-iterations must be at least 2.')
  if (parsed.memorySampleIntervalMs < 50) throw new Error('--memory-sample-ms must be at least 50.')
  return parsed
}

function requiredValue(list, index, option) {
  const value = list[index]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`)
  return value
}

function positiveInteger(value, option) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${option} requires a positive integer.`)
  return number
}

function round(value, digits = 2) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
