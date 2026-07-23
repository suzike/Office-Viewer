import assert from 'node:assert/strict'
import test from 'node:test'
import { validateHtmlDocument } from '../../out/desktop/shared/html-validate.js'

test('HTML validator accepts a well-formed document without issues', () => {
  const html = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>t</title><link rel="stylesheet" href="a.css"></head>',
    '<body><p id="a">text <img src="a.png" alt=""></p><ul><li>one<li>two</ul></body></html>',
  ].join('\n')
  assert.deepEqual(validateHtmlDocument(html), [])
})

test('HTML validator reports unclosed tags with their opening line', () => {
  const html = '<div>\n  <section>\n    <p>text</p>\n  </section>'
  const issues = validateHtmlDocument(html)
  assert.deepEqual(issues, [{ line: 1, rule: 'unclosed-tag', message: '标签 <div> 未闭合' }])
})

test('HTML validator reports unmatched closing tags and tags truncated by an ancestor close', () => {
  const html = '<div><span></div></article>'
  const issues = validateHtmlDocument(html)
  assert.equal(issues.length, 2)
  assert.deepEqual(issues[0], { line: 1, rule: 'unclosed-tag', message: '标签 <span> 未闭合（被 </div> 截断）' })
  assert.deepEqual(issues[1], { line: 1, rule: 'unmatched-close', message: '闭合标签 </article> 没有匹配的开始标签' })
})

test('HTML validator reports duplicate ids with the first occurrence line', () => {
  const html = '<p id="x">1</p>\n<div>\n  <span id="x">2</span>\n</div>'
  const issues = validateHtmlDocument(html)
  assert.deepEqual(issues, [{ line: 3, rule: 'duplicate-id', message: '重复的 id "x"（首次出现在第 1 行）' }])
})

test('HTML validator reports deprecated tags', () => {
  const issues = validateHtmlDocument('<center>old</center>\n<font size="3">f</font>')
  assert.deepEqual(issues.map((issue) => [issue.line, issue.rule]), [
    [1, 'deprecated-tag'],
    [2, 'deprecated-tag'],
  ])
})

test('HTML validator ignores markup inside script, style and comments', () => {
  const html = [
    '<script>if (a < b) { document.write("<div id=\\"x\\">"); }</script>',
    '<style>@media (prefers-color-scheme: dark) { body { color: red; } }</style>',
    '<!-- <div id="y"> -->',
    '<div id="x">not a duplicate</div>',
  ].join('\n')
  assert.deepEqual(validateHtmlDocument(html), [])
})

test('HTML validator handles implied end tags and self-closing syntax', () => {
  assert.deepEqual(validateHtmlDocument('<ul><li>a<li>b</ul><table><tr><td>1<td>2<tr><td>3</table>'), [])
  assert.deepEqual(validateHtmlDocument('<div/><custom-element>ok</custom-element>'), [])
})
