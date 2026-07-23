import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AiAssistantSettingsService } from '../../out/desktop/main/ai-assistant-settings-service.js'

test('AI assistant settings encrypt secrets and expose only hasApiKey to the renderer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AiAssistantSettingsService(directory, testProtector())
  const defaults = await service.load()
  assert.ok(defaults.providers.some((provider) => provider.kind === 'codex-cli'))
  assert.ok(defaults.providers.some((provider) => provider.id === 'kimi'))

  const saved = await service.save({
    activeProviderId: 'deepseek',
    contextCharacterLimit: 96_000,
    providers: defaults.providers.map((provider) => ({
      ...provider,
      enabled: provider.id === 'deepseek' || provider.kind.endsWith('-cli'),
      apiKey: provider.id === 'deepseek' ? 'super-secret-key' : undefined,
    })),
  })
  assert.equal(saved.activeProviderId, 'deepseek')
  assert.equal(saved.providers.find((provider) => provider.id === 'deepseek')?.hasApiKey, true)
  assert.equal(JSON.stringify(saved).includes('super-secret-key'), false)
  const settingsOnDisk = await readFile(join(directory, 'ai-assistant-settings.json'), 'utf8')
  assert.equal(settingsOnDisk.includes('super-secret-key'), false)
  assert.equal((await service.resolve('deepseek')).apiKey, 'super-secret-key')
})

test('AI assistant settings persist custom actions, prompt library, persona and the shortcut toggle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-settings-batch2-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AiAssistantSettingsService(directory, testProtector())
  const defaults = await service.load()
  assert.deepEqual(defaults.customActions, [])
  assert.deepEqual(defaults.promptLibrary, [])
  assert.deepEqual(defaults.promptProfile, {})
  assert.equal(defaults.globalShortcutEnabled, false)

  const saved = await service.save({
    activeProviderId: defaults.activeProviderId,
    providers: defaults.providers,
    customActions: [
      { id: 'action-polish', label: '润色段落', description: '更通顺', prompt: '请润色选中段落。', requiresSelection: true },
      { id: 'action-glossary', label: '生成术语表', prompt: '请从文档生成术语表。' },
    ],
    promptLibrary: [{ id: 'prompt-review', title: '代码审查', content: '请审查以下代码并给出问题清单。' }],
    promptProfile: { persona: '资深技术编辑', outputLanguage: '简体中文', style: '结论先行' },
    globalShortcutEnabled: true,
  })
  assert.equal(saved.customActions.length, 2)
  assert.equal(saved.customActions[0].requiresSelection, true)
  assert.equal(saved.promptLibrary[0].title, '代码审查')
  assert.equal(saved.promptProfile.persona, '资深技术编辑')
  assert.equal(saved.globalShortcutEnabled, true)

  // A partial save (e.g. model switch) keeps the previously saved batch-2 fields.
  const kept = await service.save({
    activeProviderId: defaults.activeProviderId,
    providers: defaults.providers,
  })
  assert.equal(kept.customActions.length, 2)
  assert.equal(kept.promptLibrary.length, 1)
  assert.equal(kept.promptProfile.style, '结论先行')
  assert.equal(kept.globalShortcutEnabled, true)

  await assert.rejects(
    service.save({
      activeProviderId: defaults.activeProviderId,
      providers: defaults.providers,
      customActions: [
        { id: 'action-dup', label: '一', prompt: 'a' },
        { id: 'action-dup', label: '二', prompt: 'b' },
      ],
    }),
    /Duplicate custom quick action id/,
  )
  await assert.rejects(
    service.save({
      activeProviderId: defaults.activeProviderId,
      providers: defaults.providers,
      promptLibrary: [{ id: 'prompt-x', title: 'x', content: '' }],
    }),
    /Prompt library entry content/,
  )
})

test('AI assistant settings migrate batch-1 files with batch-2 defaults', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-settings-migrate-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // A settings file written before custom actions / prompt library existed.
  await writeFile(join(directory, 'ai-assistant-settings.json'), JSON.stringify({
    version: 1,
    activeProviderId: 'codex-local',
    contextCharacterLimit: 96_000,
    providers: [{ id: 'codex-local', name: 'Codex（本地）', kind: 'codex-cli', enabled: true, executable: 'codex', builtIn: true }],
    customActions: [{ id: 'broken' }],
  }))
  const service = new AiAssistantSettingsService(directory, testProtector())
  const loaded = await service.load()
  assert.equal(loaded.contextCharacterLimit, 96_000)
  assert.deepEqual(loaded.customActions, [], 'malformed entries are dropped without discarding the file')
  assert.deepEqual(loaded.promptLibrary, [])
  assert.deepEqual(loaded.promptProfile, {})
  assert.equal(loaded.globalShortcutEnabled, false)
  assert.deepEqual(loaded.modelParameters, {}, 'batch-1/2 files migrate to empty model parameters')
})

test('AI assistant settings persist model parameters with validation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-settings-params-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AiAssistantSettingsService(directory, testProtector())
  const defaults = await service.load()
  assert.deepEqual(defaults.modelParameters, {})

  const saved = await service.save({
    activeProviderId: defaults.activeProviderId,
    providers: defaults.providers,
    modelParameters: { temperature: 0.3, maxTokens: 1024 },
  })
  assert.deepEqual(saved.modelParameters, { temperature: 0.3, maxTokens: 1024 })

  // A partial save (e.g. model switch) keeps the previously saved parameters.
  const kept = await service.save({ activeProviderId: defaults.activeProviderId, providers: defaults.providers })
  assert.deepEqual(kept.modelParameters, { temperature: 0.3, maxTokens: 1024 })

  await assert.rejects(
    service.save({ activeProviderId: defaults.activeProviderId, providers: defaults.providers, modelParameters: { temperature: 3 } }),
    /temperature must be between 0 and 2/,
  )
  await assert.rejects(
    service.save({ activeProviderId: defaults.activeProviderId, providers: defaults.providers, modelParameters: { maxTokens: 0 } }),
    /max tokens must be an integer/,
  )
  // Clearing the values persists an empty parameter set.
  const cleared = await service.save({
    activeProviderId: defaults.activeProviderId,
    providers: defaults.providers,
    modelParameters: {},
  })
  assert.deepEqual(cleared.modelParameters, {})
})

function testProtector() {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8').reverse(),
    decrypt: (value) => Buffer.from(value).reverse().toString('utf8'),
  }
}
