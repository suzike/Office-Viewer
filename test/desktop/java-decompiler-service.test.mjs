import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { JavaDecompilerService } from '../../out/desktop/main/java-decompiler-service.js'

test('JavaDecompilerService decompiles a real class and removes its temporary output', async (t) => {
  if (!await hasJavaRuntime()) {
    t.skip('A system Java runtime is required for the original FernFlower feature.')
    return
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-java-test-'))
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }))

  const decompilerJar = resolve('resource/java-decompiler.jar')
  const jar = await JSZip.loadAsync(await readFile(decompilerJar))
  const fixture = jar.file('org/jetbrains/java/decompiler/main/decompiler/ConsoleDecompiler.class')
  assert.ok(fixture, 'The bundled decompiler must contain the real class fixture.')
  const classPath = join(temporaryDirectory, 'ConsoleDecompiler.class')
  await writeFile(classPath, await fixture.async('nodebuffer'))

  const service = new JavaDecompilerService(decompilerJar)
  const first = await service.decompile(classPath)
  const second = await service.decompile(classPath)
  assert.equal(first.fileName, 'ConsoleDecompiler.java')
  assert.match(first.source, /class ConsoleDecompiler/)
  assert.equal(second, first, 'An unchanged class should use the mtime cache.')
})

async function hasJavaRuntime() {
  const child = spawn('java', ['-version'], { stdio: 'ignore', windowsHide: true })
  const [code] = await once(child, 'exit')
  return code === 0
}
