import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MarkdownTemplateService } from '../../out/desktop/main/markdown-template-service.js'

test('MarkdownTemplateService returns built-in templates even without a user directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'office-markdown-templates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const templates = await new MarkdownTemplateService(root).list()
  assert.equal(templates.length, 4)
  assert.deepEqual(templates.map((template) => template.name), ['空白文档', '会议纪要', '周报', 'README'])
  assert.equal(templates[0].content, '')
  assert.match(templates[1].content, /# 会议纪要/)
})

test('MarkdownTemplateService merges user templates from markdown-templates directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'office-markdown-templates-'))
  const directory = join(root, 'markdown-templates')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, '读书笔记.md'), '# 读书笔记\n\n- 书名：\n')
  await writeFile(join(directory, 'ignore.txt'), 'not markdown')
  t.after(() => rm(root, { recursive: true, force: true }))

  const templates = await new MarkdownTemplateService(root).list()
  assert.equal(templates.length, 5)
  const userTemplate = templates.at(-1)
  assert.equal(userTemplate.id, 'user:读书笔记.md')
  assert.equal(userTemplate.name, '读书笔记')
  assert.match(userTemplate.content, /# 读书笔记/)
})
