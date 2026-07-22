import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { DesktopMarkdownAiOptions } from '../shared/desktop-api'

const MAX_MARKDOWN_CHARS = 2 * 1024 * 1024
const MAX_AI_OUTPUT_CHARS = 2 * 1024 * 1024
const MAX_PROVIDER_RESPONSE_CHARS = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000

type Provider = 'openai' | 'anthropic' | 'gemini' | 'ollama'

export class MarkdownAiService {
  private readonly active = new Map<string, AbortController>()

  public cancel(requestId: string): boolean {
    const controller = this.active.get(requireRequestId(requestId))
    if (!controller) return false
    controller.abort()
    return true
  }

  public async stream(
    requestId: string,
    markdown: string,
    options: DesktopMarkdownAiOptions,
    onChunk: (chunk: string) => void,
  ): Promise<void> {
    requireRequestId(requestId)
    if (this.active.has(requestId)) throw new Error('This Markdown AI request is already active.')
    if (typeof markdown !== 'string' || markdown.length === 0 || markdown.length > MAX_MARKDOWN_CHARS) {
      throw new RangeError('Markdown AI input must contain between 1 character and 2 MB.')
    }
    if (options.engine === 'vscode') throw new Error('VS Code language models are unavailable in the standalone desktop app. Select a configured model provider.')

    const providerUrl = requireProviderUrl(options.customUrl)
    await rejectMetadataTarget(providerUrl)
    const provider = detectProvider(providerUrl, options.customApiFormat)
    const model = normalizeModel(options.customModel, provider)
    const prompt = buildPolishPrompt(markdown, options)
    const request = buildProviderRequest(providerUrl, provider, model, prompt, options.customKey)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Markdown AI request timed out.')), REQUEST_TIMEOUT_MS)
    this.active.set(requestId, controller)
    let total = 0
    const push = (chunk: string) => {
      if (!chunk) return
      total += chunk.length
      if (total > MAX_AI_OUTPUT_CHARS) throw new RangeError('Markdown AI output exceeds the 2 MB limit.')
      onChunk(chunk)
    }
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(await readProviderError(response))
      await readProviderStream(response, provider, push)
    } finally {
      clearTimeout(timeout)
      this.active.delete(requestId)
    }
  }
}

function buildPolishPrompt(markdown: string, options: DesktopMarkdownAiOptions): string {
  const parts = ['You are a writing assistant.']
  parts.push(options.prompt?.trim() || 'Polish the following Markdown text: improve clarity, fix grammar, and enhance readability.')
  if (options.goal?.trim()) parts.push(`Focus on: ${options.goal.trim()}`)
  parts.push(outputLanguageInstruction(options.outputLanguage, options.uiLanguage))
  parts.push(`Return ONLY the polished Markdown with no extra commentary.\n\n${markdown}`)
  return parts.join('\n')
}

function outputLanguageInstruction(outputLanguage?: string, uiLanguage?: string): string {
  const value = outputLanguage && outputLanguage !== 'auto' ? outputLanguage : uiLanguage
  const names: Record<string, string> = {
    en: 'English', 'en-US': 'English', en_US: 'English',
    zh: 'Simplified Chinese', 'zh-CN': 'Simplified Chinese', zh_CN: 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese', zh_TW: 'Traditional Chinese',
    ja: 'Japanese', 'ja-JP': 'Japanese', ja_JP: 'Japanese',
    ko: 'Korean', 'ko-KR': 'Korean', ko_KR: 'Korean',
    ru: 'Russian', 'ru-RU': 'Russian', ru_RU: 'Russian',
  }
  return `Write the result in ${names[value ?? ''] ?? 'the same language as the input'}.`
}

function buildProviderRequest(url: URL, provider: Provider, model: string, prompt: string, rawKey?: string) {
  const key = normalizeApiKey(rawKey)
  const base = url.href.replace(/\/+$/, '')
  if (provider === 'anthropic') {
    const endpoint = base.endsWith('/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
    return {
      url: endpoint,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) },
      body: { model, max_tokens: 8192, stream: true, messages: [{ role: 'user', content: prompt }] },
    }
  }
  if (provider === 'gemini') {
    const endpoint = base.includes(':streamGenerateContent')
      ? base
      : base.includes(':generateContent')
        ? base.replace(':generateContent', ':streamGenerateContent')
        : base.includes('/models/')
          ? `${base}:streamGenerateContent`
          : `${base.includes('googleapis.com') ? base : `${base}/v1beta`}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    return {
      url: endpoint,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(key ? { 'x-goog-api-key': key } : {}) },
      body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
    }
  }
  if (provider === 'ollama') {
    const endpoint = base.endsWith('/api/chat') ? base : base.endsWith('/api') ? `${base}/chat` : `${base}/api/chat`
    return {
      url: endpoint,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: { model, stream: true, messages: [{ role: 'user', content: prompt }] },
    }
  }
  const endpoint = base.endsWith('/chat/completions') ? base : /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  return {
    url: endpoint,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: { model, stream: true, messages: [{ role: 'user', content: prompt }] },
  }
}

async function readProviderStream(response: Response, provider: Provider, onChunk: (chunk: string) => void): Promise<void> {
  if (!response.body) throw new Error('AI provider returned no response body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let rawResponse = ''
  let emitted = false
  while (true) {
    const { done, value } = await reader.read()
    const decoded = decoder.decode(value, { stream: !done })
    buffer += decoded
    if (!emitted) {
      rawResponse += decoded
      if (rawResponse.length > MAX_PROVIDER_RESPONSE_CHARS) throw new RangeError('AI provider response exceeds the 8 MB limit.')
    }
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const chunk = parseStreamLine(provider, line)
      if (chunk) {
        emitted = true
        rawResponse = ''
        onChunk(chunk)
      }
    }
    if (done) break
  }
  if (buffer.trim()) {
    const chunk = parseStreamLine(provider, buffer)
    if (chunk) { emitted = true; onChunk(chunk) }
  }
  if (!emitted) {
    const fallback = parseNonStreamingResponse(provider, rawResponse)
    if (fallback) onChunk(fallback)
  }
}

function parseStreamLine(provider: Provider, line: string): string {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':')) return ''
  const raw = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
  if (!raw || raw === '[DONE]') return ''
  try {
    const data = JSON.parse(raw)
    if (provider === 'anthropic') return data?.delta?.text ?? data?.content_block?.text ?? ''
    if (provider === 'gemini') return data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('') ?? ''
    if (provider === 'ollama') return data?.message?.content ?? data?.response ?? ''
    return data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? ''
  } catch {
    return ''
  }
}

function parseNonStreamingResponse(provider: Provider, text: string): string {
  try {
    const data = JSON.parse(text)
    if (provider === 'anthropic') return data?.content?.map((part: { text?: string }) => part.text ?? '').join('') ?? ''
    if (provider === 'gemini') return data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('') ?? ''
    if (provider === 'ollama') return data?.message?.content ?? data?.response ?? ''
    return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? ''
  } catch {
    return text.trim()
  }
}

async function readProviderError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 64 * 1024)
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.detail
    if (typeof message === 'string' && message.trim()) return `AI provider rejected the request: ${message.trim()}`
  } catch {
    // Return status only so HTML error pages and credentials are never copied into logs/UI.
  }
  return `AI provider rejected the request with HTTP ${response.status} ${response.statusText}.`
}

function detectProvider(url: URL, requested?: DesktopMarkdownAiOptions['customApiFormat']): Provider {
  if (requested && requested !== 'auto') return requested
  const value = url.href.toLowerCase()
  if (value.includes('anthropic.com') || value.includes('/v1/messages')) return 'anthropic'
  if (value.includes('googleapis.com') || value.includes(':generatecontent') || value.includes('/gemini')) return 'gemini'
  if (value.includes('ollama') || value.includes(':11434') || value.includes('/api/chat')) return 'ollama'
  return 'openai'
}

function normalizeModel(value: string | undefined, provider: Provider): string {
  const fallback: Record<Provider, string> = { openai: 'gpt-4o', anthropic: 'claude-3-5-sonnet-20241022', gemini: 'gemini-1.5-flash', ollama: 'llama3.2' }
  const model = value?.trim() || fallback[provider]
  if (model.length > 256 || /[\0\r\n]/.test(model)) throw new TypeError('AI model name is invalid.')
  return model
}

function normalizeApiKey(value?: string): string | undefined {
  const key = value?.trim()
  if (!key) return undefined
  if (key.length > 64 * 1024 || /[\0\r\n]/.test(key)) throw new TypeError('AI API key is invalid.')
  return key
}

function requireProviderUrl(value?: string): URL {
  if (!value || value.length > 4096) throw new TypeError('A configured AI provider URL is required.')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('AI provider URL must be a credential-free HTTP(S) URL.')
  for (const name of url.searchParams.keys()) {
    if (/^(?:key|api[_-]?key|token|access[_-]?token|authorization)$/i.test(name)) {
      throw new Error('AI credentials must be entered in the API key field so they can be protected by Windows safe storage.')
    }
  }
  return url
}

async function rejectMetadataTarget(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|]$/g, '')
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true })
  for (const { address } of addresses) {
    const normalized = address.toLowerCase().split('%')[0]
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? normalized
    if (mapped.startsWith('169.254.') || /^(?:fe8|fe9|fea|feb)/.test(normalized)) throw new Error('Cloud metadata and link-local AI provider targets are blocked.')
  }
}

function requireRequestId(value: string): string {
  if (typeof value !== 'string' || !/^[\w-]{8,128}$/.test(value)) throw new TypeError('A valid Markdown AI request id is required.')
  return value
}
