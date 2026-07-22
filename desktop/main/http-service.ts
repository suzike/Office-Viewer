import { lookup } from 'node:dns/promises'
import { readFile, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  DesktopHttpPreviewOption,
  DesktopHttpRequestOptions,
  DesktopHttpResponse,
} from '../shared/desktop-api'

const MAX_DOCUMENT_CHARS = 2 * 1024 * 1024
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_REDIRECTS = 10
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Office-Viewer/4.1.6'
const REQUEST_LINE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(.+?)(?:\s+HTTP\/[\d.]+)?$/i
const FILE_VARIABLE = /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/
const NAME_DIRECTIVE = /^\s*(?:#|\/{2})+\s*@name\s+(\w+)\s*$/i
const NOTE_DIRECTIVE = /^\s*(?:#|\/{2})+\s*@note\s*$/i
const SENSITIVE_REDIRECT_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

export interface DesktopHttpRequestBlock {
  readonly index: number
  readonly startLine: number
  readonly endLine: number
  readonly name?: string
  readonly warnBeforeSend: boolean
  readonly text: string
}

interface ParsedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body?: string | Uint8Array
  readonly displayBody?: string
  readonly name?: string
}

interface CachedExchange {
  readonly request: ParsedRequest
  readonly response: DesktopHttpResponse
}

export class DesktopHttpService {
  private readonly activeRequests = new Map<string, AbortController>()
  private readonly namedExchanges = new Map<string, Map<string, CachedExchange>>()

  public constructor(private readonly getSessionPath: (sessionId: string) => string) {}

  public cancel(requestId: string): boolean {
    const controller = this.activeRequests.get(requireRequestId(requestId))
    if (!controller) return false
    controller.abort()
    return true
  }

  public async send(
    sessionId: string,
    source: string,
    requestIndex: number,
    requestId: string,
    options: DesktopHttpRequestOptions = {},
  ): Promise<DesktopHttpResponse> {
    requireRequestId(requestId)
    if (this.activeRequests.has(requestId)) throw new Error('This HTTP request id is already active.')
    if (typeof source !== 'string' || source.length > MAX_DOCUMENT_CHARS) {
      throw new RangeError('HTTP document exceeds the 2 MB limit.')
    }
    if (!Number.isSafeInteger(requestIndex) || requestIndex < 0) {
      throw new TypeError('A valid HTTP request block index is required.')
    }

    const documentPath = this.getSessionPath(sessionId)
    if (!/\.(?:http|rest)$/i.test(documentPath)) throw new Error('HTTP requests can only run from .http or .rest documents.')
    const blocks = parseHttpDocument(source)
    const block = blocks[requestIndex]
    if (!block) throw new RangeError('The selected HTTP request block does not exist.')

    const controller = new AbortController()
    const timeoutMs = normalizeTimeout(options.timeoutMs)
    const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms.`)), timeoutMs)
    this.activeRequests.set(requestId, controller)

    try {
      const variables = parseFileVariables(source)
      for (const [name, value] of Object.entries(normalizeEnvironment(options.environment))) {
        if (!variables.has(name)) variables.set(name, value)
      }
      const parsed = await parseRequestBlock(
        block,
        variables,
        this.namedExchanges.get(sessionId),
        documentPath,
        options,
      )
      const result = await this.execute(requestId, parsed, controller.signal, options)
      if (parsed.name) {
        let cache = this.namedExchanges.get(sessionId)
        if (!cache) {
          cache = new Map()
          this.namedExchanges.set(sessionId, cache)
        }
        cache.set(parsed.name, { request: parsed, response: result })
      }
      return result
    } finally {
      clearTimeout(timeout)
      this.activeRequests.delete(requestId)
    }
  }

  private async execute(
    requestId: string,
    parsed: ParsedRequest,
    signal: AbortSignal,
    options: DesktopHttpRequestOptions,
  ): Promise<DesktopHttpResponse> {
    let currentUrl = requireHttpUrl(parsed.url)
    let method = parsed.method
    let body = parsed.body
    let headers = { ...parsed.headers }
    let redirectCount = 0
    const startedAt = Date.now()

    while (true) {
      await validateNetworkTarget(currentUrl, options.allowPrivateNetwork === true)
      const response = await fetch(currentUrl, {
        method,
        headers,
        body: body as BodyInit | undefined,
        redirect: 'manual',
        signal,
      })

      if (isRedirect(response.status) && options.followRedirect !== false) {
        const location = response.headers.get('location')
        if (!location) return this.toResult(requestId, parsed, response, currentUrl, startedAt, redirectCount, options.previewOption)
        if (redirectCount >= MAX_REDIRECTS) throw new Error(`HTTP redirect limit of ${MAX_REDIRECTS} exceeded.`)
        const nextUrl = requireHttpUrl(new URL(location, currentUrl).href)
        if (nextUrl.origin !== currentUrl.origin) headers = stripSensitiveHeaders(headers)
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
          headers = removeEntityHeaders(headers)
        }
        currentUrl = nextUrl
        redirectCount++
        continue
      }

      return this.toResult(requestId, parsed, response, currentUrl, startedAt, redirectCount, options.previewOption, options.decodeEscapedUnicodeCharacters)
    }
  }

  private async toResult(
    requestId: string,
    parsed: ParsedRequest,
    response: Response,
    finalUrl: URL,
    startedAt: number,
    redirectCount: number,
    previewOption: DesktopHttpPreviewOption = 'body',
    decodeEscapedUnicodeCharacters = false,
  ): Promise<DesktopHttpResponse> {
    const bodyBytes = await readLimitedResponse(response)
    const contentType = response.headers.get('content-type') ?? undefined
    let body = decodeBody(bodyBytes, contentType)
    if (decodeEscapedUnicodeCharacters) {
      body = body.replace(/\\u([0-9a-fA-F]{4})/g, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    }
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value
    })
    const request = {
      method: parsed.method,
      url: parsed.url,
      headers: redactCredentialHeaders(parsed.headers),
      body: parsed.displayBody,
      name: parsed.name,
    }
    const resultBase = {
      requestId,
      request,
      finalUrl: finalUrl.href,
      statusCode: response.status,
      statusMessage: response.statusText,
      httpVersion: '1.1',
      headers: responseHeaders,
      body,
      bodyBytes,
      contentType,
      elapsedMs: Date.now() - startedAt,
      redirectCount,
    }
    return {
      ...resultBase,
      preview: formatHttpPreview(resultBase, previewOption),
    }
  }
}

export function parseHttpDocument(source: string): DesktopHttpRequestBlock[] {
  const lines = source.split(/\r?\n/)
  const delimiterRows = lines.flatMap((line, index) => /^#{3,}/.test(line) ? [index] : [])
  const boundaries = [-1, ...delimiterRows, lines.length]
  const blocks: DesktopHttpRequestBlock[] = []
  for (let cursor = 0; cursor < boundaries.length - 1; cursor++) {
    const from = boundaries[cursor] + 1
    const to = boundaries[cursor + 1] - 1
    const section = lines.slice(from, to + 1)
    const requestOffset = section.findIndex((line) => {
      const trimmed = line.trim()
      return REQUEST_LINE.test(trimmed) || /^curl(?:\s|$)/i.test(trimmed) || /^(?:https?):\/\//i.test(trimmed)
    })
    if (requestOffset < 0) continue
    let last = section.length - 1
    while (last >= requestOffset && section[last].trim() === '') last--
    const metadata = section.slice(0, requestOffset)
    blocks.push({
      index: blocks.length,
      startLine: from + requestOffset,
      endLine: from + last,
      name: metadata.map((line) => line.match(NAME_DIRECTIVE)?.[1]).find(Boolean),
      warnBeforeSend: metadata.some((line) => NOTE_DIRECTIVE.test(line)),
      text: section.slice(requestOffset, last + 1).filter((line) => !/^\s*(?:#|\/\/)/.test(line)).join('\n'),
    })
  }
  return blocks
}

async function parseRequestBlock(
  block: DesktopHttpRequestBlock,
  variables: Map<string, string>,
  cache: Map<string, CachedExchange> | undefined,
  documentPath: string,
  options: DesktopHttpRequestOptions,
): Promise<ParsedRequest> {
  const resolved = resolveVariables(block.text, variables, cache)
  if (/^\s*curl(?:\s|$)/i.test(resolved)) {
    return parseCurlRequest(resolved, block.name, documentPath)
  }
  const lines = resolved.split(/\r?\n/)
  const first = lines.shift()?.trim() ?? ''
  const requestMatch = first.match(REQUEST_LINE)
  const method = requestMatch?.[1]?.toUpperCase() ?? 'GET'
  let url = (requestMatch?.[2] ?? first).trim()
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT }
  while (lines.length > 0 && /^\s*[?&]/.test(lines[0])) url += lines.shift()!.trim()
  while (lines.length > 0 && lines[0].trim() !== '') {
    const line = lines.shift()!
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`Invalid HTTP header: ${line}`)
    appendHeader(headers, line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  removeHeader(headers, 'content-length')
  if (lines[0]?.trim() === '') lines.shift()
  let rawBody = lines.join('\n') || undefined
  if (getHeader(headers, 'x-request-type')?.toLowerCase() === 'graphql') {
    removeHeader(headers, 'x-request-type')
    const [query = '', ...variableParts] = (rawBody ?? '').split(/\r?\n\s*\r?\n/)
    const variables = variableParts.join('\n\n').trim()
    rawBody = JSON.stringify({ query, variables: variables ? JSON.parse(variables) : {} })
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json'
  }
  if (rawBody && getHeader(headers, 'content-type')?.toLowerCase().includes('application/x-www-form-urlencoded')) {
    rawBody = encodeFormBody(rawBody, options.formParamEncodingStrategy ?? 'automatic')
  }
  const body = await resolveBody(rawBody, documentPath)
  if (url.startsWith('/')) {
    const host = getHeader(headers, 'host')
    if (!host) throw new Error('A relative HTTP URL requires a Host header.')
    url = `${/:443$|:8443$/i.test(host) ? 'https' : 'http'}://${host}${url}`
  }
  normalizeBasicAuthorization(headers)
  return { method, url, headers, body, displayBody: rawBody, name: block.name }
}

async function parseCurlRequest(command: string, name: string | undefined, documentPath: string): Promise<ParsedRequest> {
  const tokens = tokenizeCurl(command.replace(/\\\r?\n/g, ' '))
  if (tokens.shift()?.toLowerCase() !== 'curl') throw new Error('Invalid cURL request.')
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT }
  let method: string | undefined
  let url: string | undefined
  let rawBody: string | undefined
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const next = () => {
      const value = tokens[++index]
      if (value === undefined) throw new Error(`Missing value after ${token}.`)
      return value
    }
    if (token === '-X' || token === '--request') method = next().toUpperCase()
    else if (/^-X[A-Za-z]+$/.test(token)) method = token.slice(2).toUpperCase()
    else if (token === '-H' || token === '--header') {
      const header = next()
      const separator = header.indexOf(':')
      if (separator < 1) throw new Error(`Invalid cURL header: ${header}`)
      appendHeader(headers, header.slice(0, separator).trim(), header.slice(separator + 1).trim())
    } else if (['-d', '--data', '--data-ascii', '--data-binary', '--data-raw'].includes(token)) {
      const value = next()
      rawBody = rawBody === undefined ? value : `${rawBody}&${value}`
    } else if (token === '-b' || token === '--cookie') appendHeader(headers, 'Cookie', next())
    else if (token === '-u' || token === '--user') appendHeader(headers, 'Authorization', `Basic ${Buffer.from(next()).toString('base64')}`)
    else if (token === '-I' || token === '--head') method = 'HEAD'
    else if (token === '--url') url = next()
    else if (!token.startsWith('-')) url = token
  }
  if (!url) throw new Error('cURL request has no URL.')
  const body = rawBody?.startsWith('@')
    ? await readBodyFile(rawBody.slice(1), documentPath)
    : rawBody
  if (body !== undefined && !hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  normalizeBasicAuthorization(headers)
  return { method: method ?? (body === undefined ? 'GET' : 'POST'), url, headers, body, displayBody: rawBody, name }
}

function parseFileVariables(source: string): Map<string, string> {
  const variables = new Map<string, string>()
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(FILE_VARIABLE)
    if (match) variables.set(match[1], unescapeVariable(match[2]))
  }
  for (let pass = 0; pass < variables.size; pass++) {
    let changed = false
    for (const [name, value] of variables) {
      const next = value.replace(/\{\{\s*([^{}]+?)\s*}}/g, (whole, reference: string) => variables.get(reference) ?? whole)
      if (next !== value) {
        variables.set(name, next)
        changed = true
      }
    }
    if (!changed) break
  }
  return variables
}

function resolveVariables(source: string, variables: Map<string, string>, cache?: Map<string, CachedExchange>): string {
  return source.replace(/\{\{\s*([^{}]+?)\s*}}/g, (_whole, rawReference: string) => {
    const reference = rawReference.trim()
    if (reference === '$timestamp') return String(Date.now())
    const random = reference.match(/^\$randomInt(?:\s+(-?\d+)\s+(-?\d+))?$/)
    if (random) {
      const min = random[1] === undefined ? 0 : Number.parseInt(random[1], 10)
      const max = random[2] === undefined ? 1000 : Number.parseInt(random[2], 10)
      if (max <= min) throw new Error('$randomInt requires max to be greater than min.')
      return String(Math.floor(Math.random() * (max - min)) + min)
    }
    const direct = variables.get(reference)
    if (direct !== undefined) return direct
    const cached = resolveCachedVariable(reference, cache)
    if (cached !== undefined) return cached
    if (reference.startsWith('$processEnv') || reference.startsWith('$dotenv')) {
      throw new Error(`${reference.split(/\s+/)[0]} is disabled in the desktop app to prevent implicit credential disclosure. Use an explicit HTTP environment variable instead.`)
    }
    throw new Error(`Unresolved HTTP variable: {{${reference}}}`)
  })
}

function resolveCachedVariable(reference: string, cache?: Map<string, CachedExchange>): string | undefined {
  const match = reference.match(/^(\w+)\.(request|response)\.(headers|body)(?:\.(.+))?$/)
  if (!match || !cache) return undefined
  const exchange = cache.get(match[1])
  if (!exchange) return undefined
  const entity = match[2] === 'request' ? exchange.request : exchange.response
  if (match[3] === 'headers') {
    if (!match[4]) return JSON.stringify(entity.headers)
    const entry = Object.entries(entity.headers).find(([name]) => name.toLowerCase() === match[4]!.toLowerCase())
    return entry?.[1]
  }
  const body = entity.body
  if (typeof body !== 'string') return body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : undefined
  if (!match[4] || match[4] === '*') return body
  try {
    let value: unknown = JSON.parse(body)
    for (const segment of match[4].replace(/^\$\.?/, '').replace(/\[(\d+)]/g, '.$1').split('.').filter(Boolean)) {
      value = (value as Record<string, unknown>)?.[segment]
    }
    return typeof value === 'string' ? value : value === undefined ? undefined : JSON.stringify(value)
  } catch {
    return undefined
  }
}

async function resolveBody(rawBody: string | undefined, documentPath: string): Promise<string | Uint8Array | undefined> {
  if (!rawBody) return undefined
  const match = rawBody.match(/^<@?(?:\w+)?\s+(.+?)\s*$/)
  return match ? readBodyFile(match[1], documentPath) : rawBody
}

async function readBodyFile(reference: string, documentPath: string): Promise<Uint8Array> {
  if (reference.includes('\0') || isAbsolute(reference)) throw new Error('HTTP request body files must use a relative path.')
  const base = await realpath(dirname(documentPath))
  const candidate = await realpath(resolve(base, reference))
  const traversal = relative(base, candidate)
  if (traversal === '..' || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) {
    throw new Error('HTTP request body file escapes the request document directory.')
  }
  const data = await readFile(candidate)
  if (data.byteLength > MAX_BODY_BYTES) throw new RangeError('HTTP request body file exceeds the 16 MB limit.')
  return data
}

async function validateNetworkTarget(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0) throw new Error('HTTP host did not resolve to an address.')
  for (const { address } of addresses) {
    if (isMetadataAddress(address)) throw new Error('Cloud metadata and link-local HTTP targets are blocked.')
    if (!allowPrivateNetwork && isPrivateAddress(address)) {
      throw new Error('Private and local network HTTP targets are blocked. Enable local network access explicitly to continue.')
    }
  }
}

function requireHttpUrl(value: string): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) throw new TypeError('A valid HTTP URL is required.')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free HTTP(S) request URLs are allowed.')
  }
  return url
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const value = mapped ?? normalized
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some(Number.isNaN)) return false
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function isMetadataAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  return (mapped ?? normalized).startsWith('169.254.')
}

async function readLimitedResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const declared = Number.parseInt(response.headers.get('content-length') ?? '0', 10)
  if (declared > MAX_RESPONSE_BYTES) throw new RangeError('HTTP response exceeds the 32 MB limit.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new RangeError('HTTP response exceeds the 32 MB limit.')
    }
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function decodeBody(bytes: Uint8Array, contentType?: string): string {
  const charset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase()
  try {
    return new TextDecoder(charset === 'gb2312' ? 'gbk' : charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function formatHttpPreview(
  response: Omit<DesktopHttpResponse, 'preview'>,
  option: DesktopHttpPreviewOption,
): string {
  const headers = Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join('\n')
  const status = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`.trimEnd()
  if (option === 'body') return prettyBody(response.body, response.contentType)
  if (option === 'headers') return `${status}\n${headers}`
  const responseText = `${status}\n${headers}\n\n${prettyBody(response.body, response.contentType)}`
  if (option !== 'exchange') return responseText
  const requestHeaders = Object.entries(response.request.headers).map(([name, value]) => `${name}: ${value}`).join('\n')
  return `${response.request.method} ${response.request.url} HTTP/1.1\n${requestHeaders}${response.request.body ? `\n\n${response.request.body}` : ''}\n\n${responseText}`
}

function prettyBody(body: string, contentType?: string): string {
  if (contentType?.toLowerCase().includes('json')) {
    try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
  }
  return body
}

function tokenizeCurl(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const character of command) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\' && quote !== "'") escaped = true
    else if (quote) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === '"' || character === "'") quote = character
    else if (/\s/.test(character)) {
      if (current) { tokens.push(current); current = '' }
    } else current += character
  }
  if (quote) throw new Error('Unterminated quote in cURL request.')
  if (escaped) current += '\\'
  if (current) tokens.push(current)
  return tokens
}

function appendHeader(headers: Record<string, string>, name: string, value: string): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error(`Invalid HTTP header: ${name}`)
  const existingName = Object.keys(headers).find((current) => current.toLowerCase() === name.toLowerCase())
  if (existingName) headers[existingName] += `${name.toLowerCase() === 'cookie' ? ';' : ','}${value}`
  else headers[name] = value
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((current) => current.toLowerCase() === name.toLowerCase())
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((current) => current.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

function removeHeader(headers: Record<string, string>, name: string): void {
  const key = Object.keys(headers).find((current) => current.toLowerCase() === name.toLowerCase())
  if (key) delete headers[key]
}

function normalizeBasicAuthorization(headers: Record<string, string>): void {
  const key = Object.keys(headers).find((current) => current.toLowerCase() === 'authorization')
  if (!key) return
  const match = headers[key].match(/^Basic\s+(.+)$/i)
  if (!match || (!match[1].includes(':') && !/\s/.test(match[1]))) return
  const separator = match[1].includes(':') ? ':' : ' '
  const [user, ...password] = match[1].split(separator)
  headers[key] = `Basic ${Buffer.from(`${user}:${password.join(separator)}`).toString('base64')}`
}

function encodeFormBody(body: string, strategy: NonNullable<DesktopHttpRequestOptions['formParamEncodingStrategy']>): string {
  if (strategy === 'never') return body
  const pairs = body.split('&').map((pair) => {
    const [name, ...values] = pair.split('=')
    const value = values.join('=')
    if (strategy === 'always') return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    const encodeMissing = (part: string) => encodeURI(part).replace(/%25([0-9A-F]{2})/gi, '%$1')
    return `${encodeMissing(name)}=${encodeMissing(value)}`
  })
  return pairs.join('&')
}

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase())))
}

function redactCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase()) || /(?:api[-_]?key|secret|token)/i.test(name)
      ? '<redacted>'
      : value,
  ]))
}

function removeEntityHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !['content-length', 'content-type'].includes(name.toLowerCase())))
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

function normalizeEnvironment(value: DesktopHttpRequestOptions['environment']): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200) throw new TypeError('HTTP environment must be a string dictionary.')
  const result: Record<string, string> = {}
  for (const [name, variable] of Object.entries(value)) {
    if (!/^[\w.-]{1,128}$/.test(name) || typeof variable !== 'string' || variable.length > 64 * 1024 || /[\0\r\n]/.test(name)) {
      throw new TypeError('HTTP environment contains an invalid variable.')
    }
    result[name] = variable
  }
  return result
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) throw new RangeError('HTTP timeout must be between 1 and 120 seconds.')
  return value
}

function requireRequestId(value: string): string {
  if (typeof value !== 'string' || !/^[\w-]{8,128}$/.test(value)) throw new TypeError('A valid HTTP request id is required.')
  return value
}

function unescapeVariable(value: string): string {
  return value.replace(/\\([nrt\\])/g, (_match, character: string) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[character]!)
}
