import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownToPlainText } from '../../out/desktop/main/markdown-plain-text.js'

test('markdownToPlainText strips headings, emphasis, links and list markers', () => {
  const markdown = [
    '# 标题一',
    '',
    '## 带闭合标记的标题 ##',
    '',
    '- **加粗** 和 *斜体* 以及 ~~删除线~~',
    '1. [链接文字](https://example.com) 与 `inline code`',
    '- [x] 已完成任务',
    '',
    '> 引用 **粗体** 内容',
  ].join('\n')
  const text = markdownToPlainText(markdown)
  assert.equal(text, [
    '标题一',
    '',
    '带闭合标记的标题',
    '',
    '加粗 和 斜体 以及 删除线',
    '链接文字 与 inline code',
    '已完成任务',
    '',
    '引用 粗体 内容',
  ].join('\n'))
})

test('markdownToPlainText strips front-matter by default and keeps it on request', () => {
  const markdown = '---\ntitle: 文档\ntags: [a]\n---\n# 正文\n\n内容。'
  assert.equal(markdownToPlainText(markdown), '正文\n\n内容。')
  const kept = markdownToPlainText(markdown, { keepFrontMatter: true })
  assert.match(kept, /title: 文档/)
  assert.match(kept, /正文/)
})

test('markdownToPlainText keeps fenced code contents but drops the fences', () => {
  const markdown = '前文\n\n```js\nconst a = "# 不是标题";\n// **不是加粗**\n```\n\n后文'
  const text = markdownToPlainText(markdown)
  assert.equal(text, '前文\n\nconst a = "# 不是标题";\n// **不是加粗**\n\n后文')
})

test('markdownToPlainText strips images, wikilinks, tables, html and reference definitions', () => {
  const markdown = [
    '![本地图片](./image/pic.png)',
    '[[Linked Note]] 与 [[page|别名]]',
    '',
    '| 名称 | 数量 |',
    '| --- | --- |',
    '| 苹果 | **3** |',
    '',
    '[ref]: https://example.com "title"',
    '使用[引用链接][ref]。',
    '',
    '---',
    '',
    '<div>html <b>加粗</b></div>',
  ].join('\n')
  const text = markdownToPlainText(markdown)
  assert.equal(text, [
    '本地图片',
    'Linked Note 与 别名',
    '',
    '名称  数量',
    '苹果  3',
    '',
    '使用引用链接。',
    '',
    'html 加粗',
  ].join('\n'))
})

test('markdownToPlainText strips setext underline and collapses blank runs', () => {
  const markdown = '标题\n===\n\n\n\n段落。'
  assert.equal(markdownToPlainText(markdown), '标题\n\n段落。')
})
