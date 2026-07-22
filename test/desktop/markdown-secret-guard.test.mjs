import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

class TestStorage {
  values = new Map()
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null }
  setItem(key, value) { this.values.set(String(key), String(value)) }
  removeItem(key) { this.values.delete(String(key)) }
}

test('desktop Markdown guard rehydrates AI keys only in memory and scrubs pre-existing plaintext', async () => {
  const source = await readFile(resolve('resource/markdown/desktop-secret-guard.js'), 'utf8')
  const localStorage = new TestStorage()
  localStorage.setItem('vditor-global-settings', JSON.stringify({
    aiModels: JSON.stringify([{ id: 'legacy', key: 'legacy-plaintext' }]),
  }))
  vm.runInNewContext(source, { Storage: TestStorage, localStorage, Map, JSON, String })
  assert.doesNotMatch(localStorage.values.get('vditor-global-settings'), /legacy-plaintext/)

  localStorage.setItem('vditor-global-settings', JSON.stringify({
    aiModels: JSON.stringify([{ id: 'desktop-model', url: 'https://example.invalid/v1', key: 'runtime-secret' }]),
  }))
  assert.match(localStorage.getItem('vditor-global-settings'), /runtime-secret/)
  assert.doesNotMatch(localStorage.values.get('vditor-global-settings'), /runtime-secret/)
})
