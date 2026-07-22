import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MarkdownSettingsService } from '../../out/desktop/main/markdown-settings-service.js'

class TestProtector {
  isAvailable() { return true }
  encrypt(value) { return Buffer.from(`protected:${Buffer.from(value).toString('base64')}`) }
  decrypt(value) { return Buffer.from(Buffer.from(value).toString('utf8').slice('protected:'.length), 'base64').toString('utf8') }
}

test('Markdown settings persist complete viewer settings while keeping AI keys out of JSON', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-markdown-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new MarkdownSettingsService(directory, new TestProtector())
  const model = { id: 'desktop-model', name: 'Desktop model', url: 'https://example.invalid/v1', key: 'secret-one' }

  await service.update({
    editMode: 'ir',
    editorTheme: 'Nord',
    codeMirrorTheme: 'Dracula',
    mermaidTheme: 'Forest',
    workspacePathAsImageBasePath: true,
    pasterImgPath: 'assets/${fileName}/${uuid}.${ext}',
    pdfMarginTop: 42,
  })
  await service.saveViewerSettings({
    globalSettings: { aiModels: JSON.stringify([model]), editor: { lineNumbers: true } },
    aiPreferences: { goal: 'clarity', outputLanguage: 'zh-CN' },
  })

  const settingsText = await readFile(join(directory, 'markdown-settings.json'), 'utf8')
  const secretsBytes = await readFile(join(directory, 'markdown-ai-secrets.bin'))
  assert.doesNotMatch(settingsText, /secret-one/)
  assert.doesNotMatch(secretsBytes.toString('utf8'), /secret-one/)
  const persistedModel = JSON.parse(JSON.parse(settingsText).viewerSettings.settings.globalSettings.aiModels)[0]
  assert.equal('key' in persistedModel, false)

  const reloaded = await new MarkdownSettingsService(directory, new TestProtector()).load()
  assert.equal(reloaded.editMode, 'ir')
  assert.equal(reloaded.editorTheme, 'Nord')
  assert.equal(reloaded.pdfMarginTop, 42)
  assert.deepEqual(reloaded.viewerSettings.settings.aiPreferences, { goal: 'clarity', outputLanguage: 'zh-CN' })
  assert.equal(JSON.parse(reloaded.viewerSettings.settings.globalSettings.aiModels)[0].key, 'secret-one')

  await service.saveViewerSettings({
    globalSettings: { aiModels: JSON.stringify([{ ...model, key: 'secret-two' }]) },
    aiPreferences: {},
  })
  assert.equal(JSON.parse((await service.load()).viewerSettings.settings.globalSettings.aiModels)[0].key, 'secret-two')
})

test('Markdown settings never fall back to plaintext credential persistence when safe storage is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-markdown-settings-unavailable-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new MarkdownSettingsService(directory, {
    isAvailable: () => false,
    encrypt: () => { throw new Error('must not encrypt') },
    decrypt: () => { throw new Error('must not decrypt') },
  })
  await service.saveViewerSettings({
    globalSettings: { aiModels: JSON.stringify([{ id: 'local', key: 'must-not-persist' }]) },
  })
  assert.doesNotMatch(await readFile(join(directory, 'markdown-settings.json'), 'utf8'), /must-not-persist/)
  await assert.rejects(() => stat(join(directory, 'markdown-ai-secrets.bin')), /ENOENT/)
  const model = JSON.parse((await service.load()).viewerSettings.settings.globalSettings.aiModels)[0]
  assert.equal(model.key, undefined)
})

test('Markdown settings serialize rapid preference and viewer-setting updates without losing state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-markdown-settings-concurrent-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new MarkdownSettingsService(directory, new TestProtector())

  await Promise.all([
    service.update({ editorTheme: 'Nord' }),
    service.update({ mermaidTheme: 'Forest' }),
    service.saveViewerSettings({ globalSettings: { uiFontSize: 15 }, aiPreferences: {} }),
    service.update({ codeMirrorTheme: 'Dracula' }),
  ])

  const reloaded = await new MarkdownSettingsService(directory, new TestProtector()).load()
  assert.equal(reloaded.editorTheme, 'Nord')
  assert.equal(reloaded.mermaidTheme, 'Forest')
  assert.equal(reloaded.codeMirrorTheme, 'Dracula')
  assert.equal(reloaded.viewerSettings.settings.globalSettings.uiFontSize, 15)
})
