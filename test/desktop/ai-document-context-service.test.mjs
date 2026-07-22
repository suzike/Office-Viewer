import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { AiDocumentContextService } from '../../out/desktop/main/ai-document-context-service.js'
import { FileSessionManager } from '../../out/desktop/main/file-session-manager.js'

test('AI document context extracts text, DOCX, PPTX and XLSX content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-context-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const paths = {
    text: join(directory, 'notes.md'),
    docx: join(directory, 'report.docx'),
    pptx: join(directory, 'deck.pptx'),
    xlsx: join(directory, 'data.xlsx'),
  }
  await writeFile(paths.text, '# 标题\n这是文本上下文。')
  await writeFile(paths.docx, await makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>需求结论</w:t></w:r></w:p></w:body></w:document>' }))
  await writeFile(paths.pptx, await makeZip({ 'ppt/slides/slide1.xml': '<p:sld><a:t>第一张幻灯片</a:t></p:sld>' }))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['指标', '值'], ['温度', 24]]), '数据')
  await writeFile(paths.xlsx, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  const registered = await sessions.registerPaths(Object.values(paths))
  const byName = new Map(registered.map((session) => [session.name, session]))
  const service = new AiDocumentContextService(sessions)

  assert.match((await service.extract(byName.get('notes.md').id, 160_000)).text, /文本上下文/)
  assert.match((await service.extract(byName.get('report.docx').id, 160_000)).text, /需求结论/)
  assert.match((await service.extract(byName.get('deck.pptx').id, 160_000)).text, /第一张幻灯片/)
  assert.match((await service.extract(byName.get('data.xlsx').id, 160_000)).text, /温度,24/)
})

test('AI document context truncates deterministically and extracts PDF text layers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-context-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const textPath = join(directory, 'large.txt')
  const pdfPath = join(directory, 'sample.pdf')
  await writeFile(textPath, `HEAD-${'x'.repeat(20_000)}-TAIL`)
  const pdfDocument = await PDFDocument.create()
  const font = await pdfDocument.embedFont(StandardFonts.Helvetica)
  pdfDocument.addPage().drawText('PDF searchable requirement text', { x: 40, y: 700, font, size: 12 })
  await writeFile(pdfPath, await pdfDocument.save())
  const [text, pdf] = await sessions.registerPaths([textPath, pdfPath])
  const service = new AiDocumentContextService(sessions)
  const clipped = await service.extract(text.id, 8_000)
  assert.equal(clipped.truncated, true)
  assert.match(clipped.text, /HEAD-/)
  assert.match(clipped.text, /-TAIL/)
  const pdfContext = await service.extract(pdf.id, 8_000)
  assert.equal(pdfContext.strategy, 'pdf')
  assert.match(pdfContext.text, /PDF searchable requirement text/)
})

test('AI document context caches concurrent extraction and invalidates it after mtime changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-context-cache-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const documentPath = join(directory, 'cached.md')
  await writeFile(documentPath, 'alpha')
  const [session] = await sessions.registerPaths([documentPath])
  const originalRead = sessions.read.bind(sessions)
  let reads = 0
  sessions.read = async (sessionId) => {
    reads += 1
    return originalRead(sessionId)
  }
  const service = new AiDocumentContextService(sessions)

  const [first, concurrent] = await Promise.all([
    service.extract(session.id, 8_000),
    service.extract(session.id, 16_000),
  ])
  assert.equal(first.text, 'alpha')
  assert.equal(concurrent.text, 'alpha')
  assert.equal(reads, 1, 'concurrent extraction should share one file read and parse')
  assert.equal((await service.extract(session.id, 32_000)).text, 'alpha')
  assert.equal(reads, 1, 'an unchanged document should reuse the parsed context')

  const before = await stat(documentPath)
  await writeFile(documentPath, 'bravo')
  const changedTime = new Date(before.mtimeMs + 2_000)
  await utimes(documentPath, changedTime, changedTime)
  assert.equal((await service.extract(session.id, 8_000)).text, 'bravo')
  assert.equal(reads, 2, 'mtime changes should invalidate and reparse the document context')

  const stable = await stat(documentPath)
  await writeFile(documentPath, 'charlie-has-a-different-size')
  await utimes(documentPath, stable.atime, stable.mtime)
  assert.equal((await service.extract(session.id, 8_000)).text, 'charlie-has-a-different-size')
  assert.equal(reads, 3, 'size changes should invalidate even when mtime is unchanged')
})

test('AI document context removes rejected extraction promises so a retry can run', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-context-retry-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const documentPath = join(directory, 'broken.docx')
  await writeFile(documentPath, await makeZip({ 'word/other.xml': '<w:document />' }))
  const [session] = await sessions.registerPaths([documentPath])
  const originalRead = sessions.read.bind(sessions)
  let reads = 0
  sessions.read = async (sessionId) => { reads += 1; return originalRead(sessionId) }
  const service = new AiDocumentContextService(sessions)

  const concurrent = await Promise.allSettled([
    service.extract(session.id, 8_000),
    service.extract(session.id, 8_000),
  ])
  assert.equal(concurrent.every((result) => result.status === 'rejected'), true)
  assert.equal(reads, 1, 'concurrent callers should share the rejected extraction promise')
  await assert.rejects(() => service.extract(session.id, 8_000), /主文档内容缺失/)
  assert.equal(reads, 2, 'a rejected extraction must be removed so later calls can retry')
})

test('AI document context LRU evicts entries at the character-weight limit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-context-weight-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const paths = ['first.md', 'second.md', 'third.md'].map((name) => join(directory, name))
  for (let index = 0; index < paths.length; index += 1) {
    await writeFile(paths[index], `${index}`.repeat(800_000))
  }
  const registered = await sessions.registerPaths(paths)
  const originalRead = sessions.read.bind(sessions)
  let reads = 0
  sessions.read = async (sessionId) => { reads += 1; return originalRead(sessionId) }
  const service = new AiDocumentContextService(sessions)

  for (const session of registered) await service.extract(session.id, 8_000)
  assert.equal(reads, 3)
  await service.extract(registered[0].id, 8_000)
  assert.equal(reads, 4, 'the least-recent document should be reparsed after weighted eviction')
})

test('AI document context LRU has a bounded entry count', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-context-capacity-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const paths = Array.from({ length: 13 }, (_value, index) => join(directory, `entry-${index}.md`))
  for (let index = 0; index < paths.length; index += 1) await writeFile(paths[index], `document-${index}`)
  const registered = await sessions.registerPaths(paths)
  const originalRead = sessions.read.bind(sessions)
  let reads = 0
  sessions.read = async (sessionId) => { reads += 1; return originalRead(sessionId) }
  const service = new AiDocumentContextService(sessions)

  for (const session of registered) await service.extract(session.id, 8_000)
  assert.equal(reads, 13)
  await service.extract(registered[0].id, 8_000)
  assert.equal(reads, 14, 'the thirteenth entry should evict the least-recent cached document')
})

async function makeZip(files) {
  const archive = new JSZip()
  for (const [name, contents] of Object.entries(files)) archive.file(name, contents)
  return archive.generateAsync({ type: 'nodebuffer' })
}
