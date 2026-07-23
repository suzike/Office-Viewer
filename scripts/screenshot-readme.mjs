// Capture README screenshots (docs/assets/screenshots + image/README) with the current desktop UI.
// Usage: npm run desktop:build && node scripts/screenshot-readme.mjs
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import HTMLtoDOCX from 'vscode-html-to-docx'
import PptxGenJS from 'pptxgenjs'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')
const screenshotDirectory = resolve('docs/assets/screenshots')
const gitHistoryTarget = resolve('image/README/1783342874748.png')
const repoMarkdown = resolve('changelog.md')

function createWorkbookFixture(filePath) {
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['季度', '区域', '收入 (万元)', '成本 (万元)', '利润 (万元)', '同比增长'],
    ['Q1', '华北', 1200, 900, 300, '12.5%'],
    ['Q1', '华东', 1430, 1015, 415, '18.2%'],
    ['Q2', '华北', 1350, 980, 370, '9.8%'],
    ['Q2', '华南', 980, 770, 210, '7.4%'],
    ['Q3', '华东', 1580, 1120, 460, '15.6%'],
    ['Q3', '西部', 760, 610, 150, '5.1%'],
    ['Q4', '华北', 1490, 1050, 440, '21.3%'],
    ['Q4', '华南', 1120, 830, 290, '11.9%'],
  ])
  worksheet['!cols'] = [{ wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(workbook, worksheet, '销售汇总')
  XLSX.writeFile(workbook, filePath)
}

async function createDocxFixture(filePath) {
  const html = `<!doctype html><html><body>
    <h1>Office Viewer 产品方案</h1>
    <p>本文档演示 <strong>Word 编辑器</strong> 的渲染与编辑能力,支持格式工具栏、表格、链接和原文件保存。</p>
    <h2>核心目标</h2>
    <ul><li>统一桌面界面中处理 Office、Markdown、PDF 与压缩包</li><li>内置文档 AI 助手,支持多模型切换</li></ul>
    <h2>里程碑</h2>
    <table><tr><th>阶段</th><th>内容</th><th>状态</th></tr>
    <tr><td>v0.5.0</td><td>桌面基线</td><td>已发布</td></tr>
    <tr><td>v0.5.6</td><td>功能批次 3</td><td>已发布</td></tr></table>
    <p>更多细节见 <a href="https://github.com/suzike/Office-Viewer">GitHub 仓库</a>。</p>
  </body></html>`
  const result = await HTMLtoDOCX(html, undefined, { title: 'Office Viewer 产品方案', creator: 'Office Viewer' })
  const bytes = result instanceof Blob ? Buffer.from(await result.arrayBuffer()) : Buffer.from(result)
  await writeFile(filePath, bytes)
}

async function createPptxFixture(filePath) {
  const presentation = new PptxGenJS()
  presentation.layout = 'LAYOUT_WIDE'
  const cover = presentation.addSlide()
  cover.background = { color: '1E1E20' }
  cover.addText('Office Viewer Desktop', { x: 0.8, y: 2.2, w: 11.6, h: 1, fontSize: 40, bold: true, color: 'F5F5F7', align: 'center' })
  cover.addText('统一桌面文档工作台 · v0.5.6', { x: 0.8, y: 3.4, w: 11.6, h: 0.6, fontSize: 20, color: '0A84FF', align: 'center' })
  const agenda = presentation.addSlide()
  agenda.addText('核心能力', { x: 0.6, y: 0.5, w: 8, h: 0.8, fontSize: 28, bold: true, color: '1F2937' })
  agenda.addText([
    { text: 'Word / Excel / PowerPoint 渲染与编辑', options: { bullet: true } },
    { text: 'Markdown 所见即所得与多格式导出', options: { bullet: true } },
    { text: 'PDF、图片、压缩包与开发者文档', options: { bullet: true } },
    { text: 'AI 文档助手:问答、总结、改写、翻译', options: { bullet: true } },
  ], { x: 0.9, y: 1.6, w: 11, h: 3.5, fontSize: 18, color: '374151', lineSpacing: 32 })
  const roadmap = presentation.addSlide()
  roadmap.addText('发布路线', { x: 0.6, y: 0.5, w: 8, h: 0.8, fontSize: 28, bold: true, color: '1F2937' })
  roadmap.addText([
    { text: 'v0.5.0 桌面基线', options: { bullet: true } },
    { text: 'v0.5.2 macOS 设计语言', options: { bullet: true } },
    { text: 'v0.5.4–0.5.6 三大功能批次', options: { bullet: true } },
  ], { x: 0.9, y: 1.6, w: 11, h: 3, fontSize: 18, color: '374151', lineSpacing: 32 })
  await presentation.writeFile({ fileName: filePath })
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  await new Promise((resolvePromise) => server.close(resolvePromise))
  return port
}

async function connectToElectron(port) {
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/version`)
      const { webSocketDebuggerUrl } = await response.json()
      return await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null })
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
  }
  throw new Error('Could not connect to Electron.')
}

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function activateTab(page, fileName) {
  const clicked = await page.$$eval('.document-tab', (tabs, name) => {
    const tab = tabs.find((element) => element.textContent.includes(name))
    if (!tab) return false
    tab.click()
    return true
  }, fileName)
  if (!clicked) throw new Error(`Tab not found: ${fileName}`)
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-readme-shots-'))
const xlsxPath = join(temporaryDirectory, 'quarterly-report.xlsx')
const docxPath = join(temporaryDirectory, 'product-proposal.docx')
const pptxPath = join(temporaryDirectory, 'product-roadmap.pptx')
createWorkbookFixture(xlsxPath)
await createDocxFixture(docxPath)
await createPptxFixture(pptxPath)

const port = await reservePort()
const applicationProcess = spawn(electronExecutable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(temporaryDirectory, 'profile')}`,
  '--window-size=1440,900',
  applicationEntry,
  xlsxPath,
  docxPath,
  pptxPath,
  repoMarkdown,
], { cwd: repositoryRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

const stopProcess = async () => {
  if (applicationProcess.exitCode !== null) return
  spawn('taskkill.exe', ['/pid', String(applicationProcess.pid), '/t', '/f'], { stdio: 'ignore' })
  await delay(1500)
}

try {
  const browser = await connectToElectron(port)
  const page = (await browser.pages())[0]
  await page.waitForSelector('.document-tab', { timeout: 30_000 })
  await delay(2000)

  // 1. Excel workbook
  await activateTab(page, 'quarterly-report.xlsx')
  await delay(3000)
  await page.screenshot({ path: join(screenshotDirectory, 'excel-workbook.png') })
  console.log('captured excel-workbook.png')

  // 2. Word editor
  await activateTab(page, 'product-proposal.docx')
  await delay(4000)
  await page.screenshot({ path: join(screenshotDirectory, 'word-editor.png') })
  console.log('captured word-editor.png')

  // 3. PowerPoint viewer
  await activateTab(page, 'product-roadmap.pptx')
  await delay(4000)
  await page.screenshot({ path: join(screenshotDirectory, 'powerpoint-viewer.png') })
  console.log('captured powerpoint-viewer.png')

  // 4. AI assistant panel (over the Word document)
  await activateTab(page, 'product-proposal.docx')
  await delay(1500)
  await page.click('.document-assistant__launcher')
  await page.waitForSelector('.document-assistant__panel', { timeout: 15_000 })
  await delay(1200)
  await page.screenshot({ path: join(screenshotDirectory, 'ai-assistant.png') })
  console.log('captured ai-assistant.png')
  await page.keyboard.press('Escape')

  // 5. Git History (repo file so the git service has a repository)
  await activateTab(page, 'changelog.md')
  await delay(2500)
  await page.click('.git-history-entry')
  await page.waitForSelector('.document-surface--git', { timeout: 15_000 })
  await delay(1500)
  const historyOpened = await page.$$eval('button', (buttons) => {
    const button = buttons.find((element) => element.textContent.includes('当前文件历史'))
    if (!button) return false
    button.click()
    return true
  })
  if (!historyOpened) throw new Error('Git History: current-file button not found.')
  await delay(5000)
  await page.screenshot({ path: gitHistoryTarget })
  console.log('captured git-history image')

  await browser.disconnect()
  console.log('README screenshots updated.')
} finally {
  await stopProcess()
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
