import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

function testProtector() {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8').reverse(),
    decrypt: (value) => Buffer.from(value).reverse().toString('utf8'),
  }
}
