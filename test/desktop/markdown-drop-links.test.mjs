import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { buildMarkdownFileLinks } from '../../out/desktop/main/markdown-resource-service.js'

const normalize = (value) => value.replace(/\\/g, '/')

test('buildMarkdownFileLinks creates relative links next to the document', () => {
  const documentPath = resolve('docs', 'note.md')
  const links = buildMarkdownFileLinks(documentPath, [
    resolve('docs', 'assets', 'spec sheet.pdf'),
    resolve('docs', 'readme.txt'),
  ])
  assert.equal(
    normalize(links),
    ['[spec sheet.pdf](./assets/spec sheet.pdf)', '[readme.txt](./readme.txt)'].join('\n'),
  )
})

test('buildMarkdownFileLinks walks up to files outside the document directory', () => {
  const documentPath = join(resolve('workspace'), 'docs', 'note.md')
  const links = buildMarkdownFileLinks(documentPath, [join(resolve('workspace'), 'data.csv')])
  assert.equal(normalize(links), '[data.csv](../data.csv)')
})

test('buildMarkdownFileLinks sanitizes brackets in file names', () => {
  const documentPath = resolve('docs', 'note.md')
  const links = buildMarkdownFileLinks(documentPath, [resolve('docs', 'a[1].txt')])
  assert.equal(normalize(links), '[a_1_.txt](./a%5B1%5D.txt)')
})
