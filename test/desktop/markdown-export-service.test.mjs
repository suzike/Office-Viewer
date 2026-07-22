import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MarkdownExportService } from '../../out/desktop/main/markdown-export-service.js'

const preferences = {
  editMode: 'wysiwyg', editorTheme: 'Auto', codeMirrorTheme: 'Auto', mermaidTheme: 'Auto',
  workspacePathAsImageBasePath: false, pasterImgPath: 'image/${fileName}/${now}.${ext}',
  pdfMarginTop: 25, viewerSettings: { enabled: false },
}

test('Markdown HTML export keeps the original styled feature set while sanitizing active content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-markdown-export-'))
  const documentPath = join(directory, 'Export Note.md')
  await writeFile(documentPath, '# placeholder')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const markdown = [
    '# Export heading', '', '- [x] checked', '', 'Inline math $x^2$.', '',
    '```mermaid', 'graph TD; A-->B;', '```', '',
    '<script>window.pwned=true</script>', '<a href="javascript:alert(1)" onclick="window.pwned=true">unsafe</a>',
  ].join('\n')

  const result = await new MarkdownExportService(resolve('.')).export(documentPath, markdown, { type: 'html' }, preferences)
  const html = await readFile(result.path, 'utf8')
  assert.equal(result.path, join(directory, 'Export Note.html'))
  assert.match(html, /id="export-heading"/)
  assert.match(html, /class="katex"/)
  assert.match(html, /class="mermaid"/)
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid/)
  assert.doesNotMatch(html, /window\.pwned/)
  assert.doesNotMatch(html, /javascript:alert/)
})

test('Markdown DOCX export produces an Office Open XML package without launching Electron for static content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-markdown-docx-'))
  const documentPath = join(directory, 'Document.md')
  await writeFile(documentPath, '# placeholder')
  t.after(() => rm(directory, { recursive: true, force: true }))

  const result = await new MarkdownExportService(resolve('.')).export(documentPath, '# DOCX\n\nA **formatted** paragraph.', { type: 'docx' }, preferences)
  const bytes = await readFile(result.path)
  assert.equal(result.path, join(directory, 'Document.docx'))
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'PK')
  assert.ok(bytes.byteLength > 1000)
})
