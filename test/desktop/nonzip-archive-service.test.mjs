import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import test from 'node:test'

const require = createRequire(import.meta.url)
const SevenZip = require('7z-wasm').default ?? require('7z-wasm')
const serviceUrl = pathToFileURL(resolve('out/desktop/main/nonzip-archive-service.js')).href
const RAR_FIXTURE = Buffer.from(
  'UmFyIRoHAM+QcwAADQAAAAAAAABE/XoAgCMAgAAAAHoAAAACz49u6RBWg0odMwMAAQAAAENNVAmRgUj+DP8lkhMHmASQ/weSuB6qBLpR5hAVgRbmhpQWpwFwlqcBRG9wBoQb3AUVFEaPLh/UcHHZN9gfx3H2G+QkNBsch2H4MKM+zftKitd/U8v3gxvoX2/UcRvxeGKIAjgjoh5Na88O461qTz+RPsmM0mwzF0ymRT9FY9y5doe1zHl0IJAuAAAAAAAAAAAAAgAAAAA1VYNKHTAJACAAAAAxRmlsZS50eHQAsCZjiozxdCCSNAAAAAAAAAAAAAIAAAAAOlWDSh0wDwAgAAAAMj8/LnR4dABOGzIth2UCALAgORXEPXsAQAcA',
  'base64',
)

test('7z service lists, reads, and safely extracts a real archive', async (t) => {
  const service = await import(serviceUrl)
  const input = await createSevenZip()
  const info = await service.inspectNonZipArchive(input, 'valid.7z')
  assert.equal(info.extension, '7z')
  assert.equal(info.folderMap.folder.children[0].entryName, 'folder/hello.txt')
  assert.equal(new TextDecoder().decode(await service.readNonZipArchiveEntry(input, 'valid.7z', 'folder/hello.txt')), 'hello 7z')

  const destination = await mkdtemp(join(tmpdir(), 'office-viewer-7z-extract-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  assert.equal((await service.extractNonZipArchive(input, 'valid.7z', destination)).fileCount, 1)
  assert.equal((await readFile(join(destination, 'folder', 'hello.txt'))).toString(), 'hello 7z')
  await assert.rejects(() => service.inspectNonZipArchive(Buffer.from('broken'), 'broken.7z'), /Invalid or damaged 7z archive/i)
})

test('RAR service lists and reads an official node-unrar-js fixture and rejects damaged data', async () => {
  const service = await import(serviceUrl)
  const info = await service.inspectNonZipArchive(RAR_FIXTURE, 'valid.rar')
  assert.equal(info.extension, 'rar')
  assert.deepEqual(info.files.map((file) => file.entryName), ['1File.txt', '2中文.txt'])
  assert.equal((await service.readNonZipArchiveEntry(RAR_FIXTURE, 'valid.rar', '1File.txt')).byteLength, 0)
  await assert.rejects(() => service.inspectNonZipArchive(Buffer.from('broken'), 'broken.rar'), /Invalid or damaged RAR archive/i)
})

test('TAR service supports valid files and rejects traversal and symbolic-link entries', async (t) => {
  const service = await import(serviceUrl)
  const input = createTar([{ name: 'folder/hello.txt', contents: Buffer.from('hello tar') }])
  const info = await service.inspectNonZipArchive(input, 'valid.tar')
  assert.equal(info.extension, 'tar')
  assert.equal(new TextDecoder().decode(await service.readNonZipArchiveEntry(input, 'valid.tar', 'folder/hello.txt')), 'hello tar')

  const destination = await mkdtemp(join(tmpdir(), 'office-viewer-tar-extract-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  await writeFile(join(destination, 'existing.txt'), 'do not replace')
  await assert.rejects(
    () => service.extractNonZipArchive(createTar([{ name: 'existing.txt', contents: Buffer.from('replacement') }]), 'valid.tar', destination),
    /exist/i,
  )
  assert.equal((await readFile(join(destination, 'existing.txt'))).toString(), 'do not replace')

  await assert.rejects(
    () => service.inspectNonZipArchive(createTar([{ name: '../escape.txt', contents: Buffer.from('escape') }]), 'unsafe.tar'),
    /Unsafe archive entry path/i,
  )
  await assert.rejects(
    () => service.inspectNonZipArchive(createTar([{ name: 'link', type: '2', linkName: '../outside' }]), 'link.tar'),
    /Unsupported TAR entry type|Symbolic-link/i,
  )
})

test('TAR extraction rejects a pre-existing symbolic-link ancestor', async (t) => {
  const service = await import(serviceUrl)
  const root = await mkdtemp(join(tmpdir(), 'office-viewer-tar-link-'))
  const destination = join(root, 'destination')
  const outside = join(root, 'outside')
  await mkdir(destination)
  await mkdir(outside)
  await symlink(outside, join(destination, 'folder'), 'junction')
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = createTar([{ name: 'folder/sub/escape.txt', contents: Buffer.from('escape') }])
  await assert.rejects(() => service.extractNonZipArchive(input, 'unsafe.tar', destination), /link|non-directory ancestor/i)
  await assert.rejects(() => readFile(join(outside, 'escape.txt')), /ENOENT/)
  await assert.rejects(() => readFile(join(outside, 'sub')), /ENOENT/)
})

test('TAR.GZ and TGZ service variants read valid data and reject damaged streams', async () => {
  const service = await import(serviceUrl)
  const tar = createTar([{ name: 'hello.txt', contents: Buffer.from('hello gzip tar') }])
  const compressed = gzipSync(tar)
  for (const name of ['valid.tar.gz', 'valid.tgz']) {
    const info = await service.inspectNonZipArchive(compressed, name)
    assert.equal(info.extension, 'tar.gz')
    assert.equal(new TextDecoder().decode(await service.readNonZipArchiveEntry(compressed, name, 'hello.txt')), 'hello gzip tar')
  }
  await assert.rejects(() => service.inspectNonZipArchive(Buffer.from('broken'), 'broken.tar.gz'), /Invalid or damaged compressed TAR archive/i)
  await assert.rejects(() => service.inspectNonZipArchive(compressed.subarray(0, 12), 'broken.tgz'), /Invalid or damaged compressed TAR archive/i)
})

async function createSevenZip() {
  const module = await SevenZip({ stdout: () => undefined, stderr: () => undefined })
  module.FS.mkdir('folder')
  module.FS.writeFile('folder/hello.txt', Buffer.from('hello 7z'))
  module.callMain(['a', 'valid.7z', 'folder/hello.txt'])
  return module.FS.readFile('valid.7z')
}

function createTar(entries) {
  const chunks = []
  for (const entry of entries) {
    const contents = entry.contents ?? Buffer.alloc(0)
    const header = Buffer.alloc(512)
    writeTarString(header, entry.name, 0, 100)
    writeTarOctal(header, entry.type === '5' ? 0o755 : 0o644, 100, 8)
    writeTarOctal(header, 0, 108, 8)
    writeTarOctal(header, 0, 116, 8)
    writeTarOctal(header, contents.byteLength, 124, 12)
    writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12)
    header.fill(0x20, 148, 156)
    header[156] = (entry.type ?? '0').charCodeAt(0)
    if (entry.linkName) writeTarString(header, entry.linkName, 157, 100)
    writeTarString(header, 'ustar', 257, 6)
    writeTarString(header, '00', 263, 2)
    writeTarString(header, 'office-viewer', 265, 32)
    writeTarString(header, 'office-viewer', 297, 32)
    const checksum = header.reduce((sum, value) => sum + value, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    chunks.push(header, contents)
    const padding = (512 - (contents.byteLength % 512)) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function writeTarString(header, value, offset, length) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

function writeTarOctal(header, value, offset, length) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}
