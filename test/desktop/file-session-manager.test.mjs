import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const managerModuleUrl = pathToFileURL(
  resolve('out/desktop/main/file-session-manager.js'),
).href

test('FileSessionManager deduplicates sessions and atomically replaces file contents', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-session-test-'))
  const sourcePath = join(temporaryDirectory, 'session-source.bin')
  const initialContents = Buffer.from('original-content', 'utf8')
  const replacementContents = Buffer.from('replacement-content-is-complete', 'utf8')
  await writeFile(sourcePath, initialContents)

  const { FileSessionManager } = await import(managerModuleUrl)
  const manager = new FileSessionManager()
  t.after(async () => {
    manager.dispose()
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  const [first, duplicateInBatch] = await manager.registerPaths([sourcePath, sourcePath])
  const [duplicateInLaterCall] = await manager.registerPaths([sourcePath])

  assert.equal(duplicateInBatch.id, first.id)
  assert.equal(duplicateInLaterCall.id, first.id)
  assert.equal(duplicateInLaterCall.path, first.path)

  const readBuffer = Buffer.from(await manager.read(first.id))
  assert.deepEqual(readBuffer, initialContents)

  const writeResult = await manager.write(first.id, replacementContents)
  assert.equal(writeResult.session.id, first.id)
  assert.equal(writeResult.bytesWritten, replacementContents.byteLength)
  assert.deepEqual(await readFile(sourcePath), replacementContents)

  const directoryEntries = await readdir(temporaryDirectory)
  assert.deepEqual(directoryEntries, ['session-source.bin'])
})

test('FileSessionManager writeAs creates a reusable session with intact bytes', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-write-as-test-'))
  const targetPath = join(temporaryDirectory, 'saved-copy.bin')
  const contents = Uint8Array.from([0, 1, 2, 3, 254, 255])

  const { FileSessionManager } = await import(managerModuleUrl)
  const manager = new FileSessionManager()
  t.after(async () => {
    manager.dispose()
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  const writeResult = await manager.writeAs(targetPath, contents)
  const [registeredAgain] = await manager.registerPaths([targetPath])

  assert.equal(registeredAgain.id, writeResult.session.id)
  assert.equal(writeResult.bytesWritten, contents.byteLength)
  assert.deepEqual(await readFile(targetPath), Buffer.from(contents))
  assert.deepEqual(Buffer.from(await manager.read(registeredAgain.id)), Buffer.from(contents))
})

test('FileSessionManager resumes suspended sessions and rejects oversized sparse files', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-lifecycle-test-'))
  const sourcePath = join(temporaryDirectory, 'suspended-session.bin')
  const oversizedPath = join(temporaryDirectory, 'oversized-session.bin')
  await writeFile(sourcePath, Buffer.from('before-suspend'))

  const oversizedHandle = await open(oversizedPath, 'w')
  await oversizedHandle.truncate(512 * 1024 * 1024 + 1)
  await oversizedHandle.close()

  const { FileSessionManager } = await import(managerModuleUrl)
  const manager = new FileSessionManager()
  t.after(async () => {
    manager.dispose()
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  const [session] = await manager.registerPaths([sourcePath])
  manager.suspend(session.id)
  assert.equal(Buffer.from(await manager.read(session.id)).toString('utf8'), 'before-suspend')

  await manager.write(session.id, Buffer.from('after-resume'))
  assert.equal((await readFile(sourcePath)).toString('utf8'), 'after-resume')
  await assert.rejects(() => manager.registerPaths([oversizedPath]), RangeError)
})

test('FileSessionManager exposes only bounded raster siblings through session tokens', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-image-list-test-'))
  const sourcePath = join(temporaryDirectory, 'image-10.png')
  const siblingPath = join(temporaryDirectory, 'image-2.jpg')
  const ignoredPath = join(temporaryDirectory, 'notes.txt')
  const oversizedPath = join(temporaryDirectory, 'image-99.png')
  await writeFile(sourcePath, Uint8Array.from([1, 2, 3]))
  await writeFile(siblingPath, Uint8Array.from([4, 5, 6]))
  await writeFile(ignoredPath, 'not an image')
  const oversizedHandle = await open(oversizedPath, 'w')
  await oversizedHandle.truncate(512 * 1024 * 1024 + 1)
  await oversizedHandle.close()

  const { FileSessionManager } = await import(managerModuleUrl)
  const manager = new FileSessionManager()
  t.after(async () => {
    manager.dispose()
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  const [source] = await manager.registerPaths([sourcePath])
  const collection = await manager.listSiblingImages(source.id)

  assert.deepEqual(collection.images.map((image) => image.session.name), [
    'image-2.jpg',
    'image-10.png',
  ])
  assert.equal(collection.images[collection.current].session.id, source.id)
  assert.deepEqual(collection.images.map((image) => image.mime), ['image/jpeg', 'image/png'])
  assert.deepEqual(
    Buffer.from(await manager.read(collection.images[0].session.id)),
    Buffer.from([4, 5, 6]),
  )
})

test('FileSessionManager restricts Markdown resources and WikiLinks to the document directory', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-markdown-access-'))
  const notesDirectory = join(temporaryDirectory, 'notes')
  const sourcePath = join(notesDirectory, 'index.md')
  const linkedPath = join(notesDirectory, 'Linked Note.md')
  const imagePath = join(notesDirectory, 'pixel.png')
  const outsidePath = join(temporaryDirectory, 'outside.md')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(notesDirectory)
  await Promise.all([
    writeFile(sourcePath, '# Index'),
    writeFile(linkedPath, '# Linked'),
    writeFile(imagePath, Buffer.from([1, 2, 3])),
    writeFile(outsidePath, '# Outside'),
  ])

  const { FileSessionManager } = await import(managerModuleUrl)
  const manager = new FileSessionManager()
  t.after(async () => {
    manager.dispose()
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  const [source] = await manager.registerPaths([sourcePath])
  assert.equal(await manager.resolveDocumentResource(source.id, 'pixel.png'), imagePath)
  const linked = await manager.resolveMarkdownLink(source.id, 'wiki:Linked%20Note#Section')
  assert.equal(linked?.path, linkedPath)
  assert.equal(await manager.resolveMarkdownLink(source.id, 'wiki:Missing'), null)
  await assert.rejects(() => manager.resolveDocumentResource(source.id, '../outside.md'))
  await assert.rejects(() => manager.resolveMarkdownLink(source.id, 'wiki:../outside'))
})
