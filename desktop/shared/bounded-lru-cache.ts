export interface BoundedLruCacheOptions<K, V> {
  maxEntries: number
  maxWeight: number
  weigh?: (value: V, key: K) => number
  dispose?: (value: V, key: K) => void
}

export interface BoundedLruCacheStats {
  entries: number
  weight: number
  hits: number
  misses: number
  evictions: number
}

interface CacheEntry<V> {
  value: V
  weight: number
}

/**
 * A deliberately small LRU used for parsed Office documents. It is bounded by
 * both entry count and an approximate byte weight so one large file cannot
 * leave an unbounded renderer-side cache behind.
 */
export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>()
  private totalWeight = 0
  private hitCount = 0
  private missCount = 0
  private evictionCount = 0

  constructor(private readonly options: BoundedLruCacheOptions<K, V>) {
    if (!Number.isFinite(options.maxEntries) || options.maxEntries < 1) {
      throw new Error('maxEntries must be at least 1')
    }
    if (!Number.isFinite(options.maxWeight) || options.maxWeight < 1) {
      throw new Error('maxWeight must be at least 1')
    }
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.missCount += 1
      return undefined
    }
    this.hitCount += 1
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  peek(key: K): V | undefined {
    return this.entries.get(key)?.value
  }

  set(key: K, value: V): void {
    const previous = this.entries.get(key)
    if (previous) {
      this.entries.delete(key)
      this.totalWeight -= previous.weight
      if (previous.value !== value) this.options.dispose?.(previous.value, key)
    }

    const rawWeight = this.options.weigh?.(value, key) ?? 1
    const weight = Math.max(1, Number.isFinite(rawWeight) ? rawWeight : 1)
    this.entries.set(key, { value, weight })
    this.totalWeight += weight
    this.trim()
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.totalWeight -= entry.weight
    this.options.dispose?.(entry.value, key)
    return true
  }

  clear(): void {
    if (this.options.dispose) {
      for (const [key, entry] of this.entries) this.options.dispose(entry.value, key)
    }
    this.entries.clear()
    this.totalWeight = 0
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  stats(): BoundedLruCacheStats {
    return {
      entries: this.entries.size,
      weight: this.totalWeight,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
    }
  }

  private trim(): void {
    while (
      this.entries.size > this.options.maxEntries
      || (this.totalWeight > this.options.maxWeight && this.entries.size > 1)
    ) {
      const oldest = this.entries.entries().next().value as [K, CacheEntry<V>] | undefined
      if (!oldest) return
      const [key, entry] = oldest
      this.entries.delete(key)
      this.totalWeight -= entry.weight
      this.evictionCount += 1
      this.options.dispose?.(entry.value, key)
    }
  }
}
