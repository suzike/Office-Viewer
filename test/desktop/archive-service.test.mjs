import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const serviceUrl = pathToFileURL(resolve('out/desktop/main/archive-service.js')).href

test('archive service extracts safely and preserves add/remove ZIP edits', async (t) => {
  const service = await import(serviceUrl)
  const source = new JSZip()
  source.file('folder/original.txt', 'original')
  const input = await source.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })

  const destination = await mkdtemp(join(tmpdir(), 'office-viewer-extract-test-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  const extracted = await service.extractZipArchive(input, destination)
  assert.equal(extracted.fileCount, 1)
  assert.equal((await readFile(join(destination, 'folder', 'original.txt'))).toString(), 'original')

  const added = await service.rewriteZipArchive(input, {
    add: { entryName: 'folder/added.txt', contents: new TextEncoder().encode('added') },
  })
  assert.equal(new TextDecoder().decode(await service.readZipArchiveEntry(added, 'folder/added.txt')), 'added')

  const removed = await service.rewriteZipArchive(added, { exclude: 'folder/original.txt' })
  await assert.rejects(() => service.readZipArchiveEntry(removed, 'folder/original.txt'), /not found/i)
})

test('archive service rejects traversal, symbolic links, and suspicious compression ratios', async () => {
  const service = await import(serviceUrl)

  const traversal = new JSZip()
  traversal.file('aaa/evil.txt', 'escape')
  const traversalBytes = Buffer.from(await traversal.generateAsync({ type: 'uint8array' }))
  replaceAll(traversalBytes, Buffer.from('aaa/evil.txt'), Buffer.from('../xevil.txt'))
  await assert.rejects(() => service.inspectZipArchive(traversalBytes, 'unsafe.zip'), /Unsafe archive entry path/i)

  const link = new JSZip()
  link.file('link.txt', 'target', { unixPermissions: 0o120777 })
  const linkBytes = await link.generateAsync({ type: 'uint8array', platform: 'UNIX' })
  await assert.rejects(() => service.inspectZipArchive(linkBytes, 'link.zip'), /Symbolic-link/i)

  const bomb = new JSZip()
  bomb.file('zeros.bin', new Uint8Array(2 * 1024 * 1024))
  const bombBytes = await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  await assert.rejects(() => service.inspectZipArchive(bombBytes, 'bomb.zip'), /compression ratio/i)
})

function replaceAll(buffer, from, to) {
  assert.equal(from.length, to.length)
  let count = 0
  for (let offset = buffer.indexOf(from); offset >= 0; offset = buffer.indexOf(from, offset + to.length)) {
    to.copy(buffer, offset)
    count += 1
  }
  assert.equal(count, 2)
}
