import assert from 'node:assert/strict'
import test from 'node:test'
import { BoundedLruCache } from '../../out/desktop/shared/bounded-lru-cache.js'

test('parsed document cache refreshes LRU order and records hits', () => {
  const cache = new BoundedLruCache({ maxEntries: 2, maxWeight: 20, weigh: value => value })
  cache.set('word:a:1', 4)
  cache.set('excel:b:1', 4)
  assert.equal(cache.get('word:a:1'), 4)
  cache.set('ppt:c:1', 4)
  assert.equal(cache.peek('excel:b:1'), undefined)
  assert.equal(cache.peek('word:a:1'), 4)
  assert.deepEqual(cache.stats(), { entries: 2, weight: 8, hits: 1, misses: 0, evictions: 1 })
})

test('parsed document cache is bounded by weight and disposes invalidated values', () => {
  const disposed = []
  const cache = new BoundedLruCache({
    maxEntries: 4,
    maxWeight: 10,
    weigh: value => value.weight,
    dispose: (_value, key) => disposed.push(key),
  })
  cache.set('old', { weight: 6 })
  cache.set('new', { weight: 6 })
  assert.equal(cache.has('old'), false)
  assert.equal(cache.delete('new'), true)
  assert.deepEqual(disposed, ['old', 'new'])
})
