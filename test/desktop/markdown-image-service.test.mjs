import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveMarkdownImage } from '../../out/desktop/main/markdown-image-service.js'

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const preferences = {
  editMode: 'wysiwyg', editorTheme: 'Auto', codeMirrorTheme: 'Auto', mermaidTheme: 'Auto',
  workspacePathAsImageBasePath: false, pasterImgPath: 'assets/${fileName}/${date}-${uuid}.${ext}',
  pdfMarginTop: 25, viewerSettings: { enabled: false },
}

test('Markdown image paste expands the original path variables and writes verified image bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-markdown-image-'))
  const documentPath = join(directory, 'My Note.md')
  await writeFile(documentPath, '# image')
  t.after(() => rm(directory, { recursive: true, force: true }))

  const result = await saveMarkdownImage(documentPath, pixel, 'jpg', preferences)
  assert.match(result.relativePath, /^assets\/MyNote\/\d{8}-[a-f0-9]{32}\.png$/)
  assert.match(result.markdown, /^!\[[^\]]+]\(assets\/MyNote\/.+\.png\)$/)
  assert.deepEqual(await readFile(join(directory, ...result.relativePath.split('/'))), pixel)
})

test('Markdown image paste rejects traversal and extension-only disguised content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-markdown-image-security-'))
  const documentPath = join(directory, 'note.md')
  await writeFile(documentPath, '# image')
  t.after(() => rm(directory, { recursive: true, force: true }))

  await assert.rejects(
    () => saveMarkdownImage(documentPath, pixel, 'png', { ...preferences, pasterImgPath: '../outside.${ext}' }),
    /remain inside the document workspace/,
  )
  await assert.rejects(
    () => saveMarkdownImage(documentPath, Buffer.from('<script>not an image</script>'), 'png', preferences),
    /invalid image contents/,
  )
})

test('Markdown workspace image base stores and references pasted images from the project root', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-markdown-workspace-image-'))
  const documentDirectory = join(directory, 'docs', 'guide')
  const documentPath = join(documentDirectory, 'Nested Note.md')
  await mkdir(join(directory, '.git'))
  await mkdir(documentDirectory, { recursive: true })
  await writeFile(documentPath, '# workspace image')
  t.after(() => rm(directory, { recursive: true, force: true }))

  const result = await saveMarkdownImage(documentPath, pixel, 'png', {
    ...preferences,
    workspacePathAsImageBasePath: true,
    pasterImgPath: 'shared/${fileName}/${now}.${ext}',
  })

  assert.match(result.relativePath, /^shared\/NestedNote\/\d+\.png$/)
  assert.deepEqual(await readFile(join(directory, ...result.relativePath.split('/'))), pixel)
})
