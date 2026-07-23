import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findMissingMarkdownReferences, scanMarkdownReferences } from '../../out/desktop/main/markdown-link-scanner.js'

test('scanMarkdownReferences collects inline relative links and images with line numbers', () => {
  const markdown = [
    '# 标题',
    '',
    '![截图](./image/pic.png)',
    '[规范](assets/spec sheet.pdf)',
    '同段 [一](a.txt) 和 [二](b.txt)',
  ].join('\n')
  assert.deepEqual(scanMarkdownReferences(markdown), [
    { kind: 'image', target: './image/pic.png', line: 3 },
    { kind: 'link', target: 'assets/spec sheet.pdf', line: 4 },
    { kind: 'link', target: 'a.txt', line: 5 },
    { kind: 'link', target: 'b.txt', line: 5 },
  ])
})

test('scanMarkdownReferences skips external URLs, anchors, absolute paths and wiki links', () => {
  const markdown = [
    '[站点](https://example.com/x.md)',
    '[邮箱](mailto:a@b.com)',
    '[数据](data:image/png;base64,AA==)',
    '[锚点](#标题)',
    '[仅片段](./doc.md#小节)',
    '[绝对](/root/file.md)',
    '[视窗](C:\\docs\\file.md)',
    '[[Wiki Page]] 与 [[page|别名]]',
  ].join('\n')
  assert.deepEqual(scanMarkdownReferences(markdown), [
    { kind: 'link', target: './doc.md', line: 5 },
  ])
})

test('scanMarkdownReferences ignores fenced code and reference-style definitions', () => {
  const markdown = [
    '[ref]: ./ignored.md "title"',
    '',
    '```md',
    '![inside](./fence.png)',
    '```',
    '',
    '~~~',
    '[also](./fence2.md)',
    '~~~',
    '',
    '使用[引用链接][ref]。',
    '[真实](./real.md)',
  ].join('\n')
  assert.deepEqual(scanMarkdownReferences(markdown), [
    { kind: 'link', target: './real.md', line: 12 },
  ])
})

test('scanMarkdownReferences strips titles, angle brackets, fragments and decodes escapes', () => {
  const markdown = [
    '[标题](<./dir/my file.md> "可选标题")',
    '[普通](./plain.md \'标题\')',
    '[编码](./%E6%96%87%E4%BB%B6.md)',
    '[查询](./report.md?raw=1#top)',
  ].join('\n')
  assert.deepEqual(scanMarkdownReferences(markdown), [
    { kind: 'link', target: './dir/my file.md', line: 1 },
    { kind: 'link', target: './plain.md', line: 2 },
    { kind: 'link', target: './文件.md', line: 3 },
    { kind: 'link', target: './report.md', line: 4 },
  ])
})

test('findMissingMarkdownReferences reports only targets missing from document and workspace roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'office-markdown-links-'))
  const docs = join(root, 'docs')
  await mkdir(docs, { recursive: true })
  await mkdir(join(root, '.git'))
  await writeFile(join(docs, 'exists.png'), 'x')
  await writeFile(join(root, 'workspace-file.md'), 'x')
  t.after(() => rm(root, { recursive: true, force: true }))

  const markdown = [
    '![存在](./exists.png)',
    '[工作区](workspace-file.md)',
    '![缺失](images/gone.png)',
    '[死链](../nowhere/file.pdf)',
  ].join('\n')
  const missing = await findMissingMarkdownReferences(join(docs, 'note.md'), markdown)
  assert.deepEqual(missing, [
    { kind: 'image', target: 'images/gone.png', line: 3 },
    { kind: 'link', target: '../nowhere/file.pdf', line: 4 },
  ])
})
