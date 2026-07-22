import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HttpSettingsService } from '../../out/desktop/main/http-settings-service.js'

class TestProtector {
  isAvailable() { return true }
  encrypt(value) { return Buffer.from(`protected:${Buffer.from(value).toString('base64')}`) }
  decrypt(value) { return Buffer.from(value.toString('utf8').slice('protected:'.length), 'base64').toString('utf8') }
}

const settings = {
  followRedirect: false,
  environmentSource: '{"$shared":{"token":"super-secret"},"staging":{"host":"https://example.invalid"}}',
  previewOption: 'exchange',
  previewColumn: 'current',
  formParamEncodingStrategy: 'always',
  addRequestBodyLineIndentationAroundBrackets: false,
  decodeEscapedUnicodeCharacters: true,
  logLevel: 'verbose',
  enableCustomVariableReferencesCodeLens: false,
  timeoutSeconds: 45,
  allowPrivateNetwork: true,
  activeEnvironment: 'staging',
}

test('HTTP settings persist the complete original option matrix and encrypt environments', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-http-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new HttpSettingsService(directory, new TestProtector())
  assert.deepEqual(await service.save(settings), settings)
  const stored = await readFile(join(directory, 'http-settings.json'), 'utf8')
  assert.doesNotMatch(stored, /super-secret|example\.invalid/)
  assert.match(stored, /encryptedEnvironmentSource/)
  assert.deepEqual(await new HttpSettingsService(directory, new TestProtector()).load(), settings)
})

test('HTTP settings never persist environment secrets as plaintext without safe storage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-http-settings-unavailable-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new HttpSettingsService(directory, {
    isAvailable: () => false,
    encrypt: () => { throw new Error('must not encrypt') },
    decrypt: () => { throw new Error('must not decrypt') },
  })
  await service.save(settings)
  const stored = await readFile(join(directory, 'http-settings.json'), 'utf8')
  assert.doesNotMatch(stored, /super-secret|environmentSource/)
  const loaded = await service.load()
  assert.match(loaded.environmentSource, /"local"/)
  assert.equal(loaded.previewColumn, 'current')
})

test('HTTP settings reject invalid ranges, enums and malformed environment JSON', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-http-settings-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new HttpSettingsService(directory, new TestProtector())
  await assert.rejects(() => service.save({ ...settings, timeoutSeconds: 0 }), /timeoutSeconds/)
  await assert.rejects(() => service.save({ ...settings, previewColumn: 'third' }), /previewColumn/)
  await assert.rejects(() => service.save({ ...settings, environmentSource: '[]' }), /JSON object/)
})
