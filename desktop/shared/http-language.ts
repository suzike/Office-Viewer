export interface DesktopHttpRange {
  readonly from: number
  readonly to: number
  readonly line: number
}

export interface DesktopHttpVariableDefinition extends DesktopHttpRange {
  readonly name: string
  readonly value: string
  readonly references: readonly DesktopHttpRange[]
}

export interface DesktopHttpRequestSymbol extends DesktopHttpRange {
  readonly kind: 'request'
  readonly name: string
  readonly detail: string
  readonly requestIndex: number
}

export interface DesktopHttpVariableSymbol extends DesktopHttpRange {
  readonly kind: 'variable'
  readonly name: string
  readonly detail: string
}

export type DesktopHttpSymbol = DesktopHttpRequestSymbol | DesktopHttpVariableSymbol

export interface DesktopHttpDocumentLink extends DesktopHttpRange {
  readonly target: string
}

export interface DesktopHttpDiagnostic extends DesktopHttpRange {
  readonly severity: 'error' | 'information'
  readonly message: string
}

export interface DesktopHttpLanguageModel {
  readonly definitions: Readonly<Record<string, DesktopHttpVariableDefinition>>
  readonly requestDefinitions: Readonly<Record<string, DesktopHttpRange>>
  readonly requestReferences: Readonly<Record<string, readonly DesktopHttpRange[]>>
  readonly symbols: readonly DesktopHttpSymbol[]
  readonly links: readonly DesktopHttpDocumentLink[]
  readonly diagnostics: readonly DesktopHttpDiagnostic[]
}

export interface DesktopHttpCompletion {
  readonly label: string
  readonly detail: string
  readonly apply?: string
  readonly type: 'keyword' | 'property' | 'variable' | 'text'
}

const METHOD_PATTERN = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(.+?)(?:\s+HTTP\/[\d.]+)?$/i
const FILE_DEFINITION_PATTERN = /^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/
const REQUEST_NAME_PATTERN = /^\s*(?:#{1,}|\/{2,})\s+@name\s+(\w+)\s*$/i
const REFERENCE_PATTERN = /\{\{(\w[^\s.{}]*)(?:\.([^{}]*?))?\}\}/g
const LINK_PATTERN = /^\s*<(?:@\w+)?\s+(.+?)\s*$/

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'] as const
const HEADERS = [
  'Accept', 'Accept-Charset', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control',
  'Connection', 'Content-Length', 'Content-MD5', 'Content-Type', 'Cookie', 'Date', 'Expect', 'Forwarded',
  'From', 'Host', 'If-Match', 'If-Modified-Since', 'If-None-Match', 'If-Range', 'If-Unmodified-Since',
  'Max-Forwards', 'Origin', 'Pragma', 'Proxy-Authorization', 'Range', 'Referer', 'TE', 'Upgrade',
  'User-Agent', 'Via', 'Warning', 'X-Http-Method-Override',
] as const
const MIME_TYPES = [
  'application/json', 'application/xml', 'application/javascript', 'application/xhtml+xml',
  'application/octet-stream', 'application/soap+xml', 'application/zip', 'application/gzip',
  'application/x-www-form-urlencoded', 'image/gif', 'image/jpeg', 'image/png', 'message/http',
  'multipart/form-data', 'text/css', 'text/csv', 'text/html', 'text/plain', 'text/xml',
] as const

export function parseDesktopHttpLanguage(
  source: string,
  environment: Readonly<Record<string, string>> = {},
  activeRequestNames: ReadonlySet<string> = new Set(),
): DesktopHttpLanguageModel {
  const lines = source.split(/\r?\n/)
  const starts = lineStarts(source)
  const rawDefinitions: Record<string, Omit<DesktopHttpVariableDefinition, 'references'>> = {}
  const requestDefinitions: Record<string, DesktopHttpRange> = {}
  const requestReferences: Record<string, DesktopHttpRange[]> = {}
  const references: Record<string, DesktopHttpRange[]> = {}
  const symbols: DesktopHttpSymbol[] = []
  const links: DesktopHttpDocumentLink[] = []
  let pendingRequestName: string | undefined
  let requestIndex = 0

  lines.forEach((line, lineNumber) => {
    const lineFrom = starts[lineNumber]
    const requestName = line.match(REQUEST_NAME_PATTERN)
    if (requestName) {
      pendingRequestName = requestName[1]
      const nameFrom = lineFrom + line.indexOf(requestName[1])
      requestDefinitions[requestName[1]] = { from: nameFrom, to: nameFrom + requestName[1].length, line: lineNumber }
    }

    const definition = line.match(FILE_DEFINITION_PATTERN)
    if (definition) {
      const name = definition[1]
      const nameFrom = lineFrom + line.indexOf(name)
      rawDefinitions[name] = { name, value: definition[2], from: nameFrom, to: nameFrom + name.length, line: lineNumber }
      symbols.push({ kind: 'variable', name, detail: definition[2], from: lineFrom, to: lineFrom + line.length, line: lineNumber })
    }

    const method = line.trim().match(METHOD_PATTERN)
    if (method) {
      const resolvedUrl = method[2].replace(/\{\{([^{}.\s]+)\}\}/g, (_match, name: string) => rawDefinitions[name]?.value ?? environment[name] ?? _match)
      const label = pendingRequestName ?? `${method[1].toUpperCase()} ${safeUrlPath(resolvedUrl)}`
      symbols.push({ kind: 'request', name: label, detail: method[2], requestIndex, from: lineFrom, to: lineFrom + line.length, line: lineNumber })
      requestIndex++
      pendingRequestName = undefined
    }

    const link = line.match(LINK_PATTERN)
    if (link) {
      const targetFrom = lineFrom + line.indexOf(link[1])
      links.push({ target: link[1], from: targetFrom, to: targetFrom + link[1].length, line: lineNumber })
    }

    if (/^\s*(?:#|\/\/)/.test(line)) return
    for (const match of line.matchAll(REFERENCE_PATTERN)) {
      const full = match[0]
      const name = match[1]
      const range = { from: lineFrom + match.index, to: lineFrom + match.index + full.length, line: lineNumber }
      ;(references[name] ??= []).push(range)
      if (match[2]) (requestReferences[name] ??= []).push(range)
    }
  })

  const definitions: Record<string, DesktopHttpVariableDefinition> = {}
  for (const [name, definition] of Object.entries(rawDefinitions)) {
    definitions[name] = { ...definition, references: references[name] ?? [] }
  }

  const diagnostics: DesktopHttpDiagnostic[] = []
  for (const [name, ranges] of Object.entries(references)) {
    const isRequest = Boolean(requestDefinitions[name])
    const found = Boolean(definitions[name]) || Object.hasOwn(environment, name) || isSystemVariable(name) || isRequest
    for (const range of ranges) {
      if (!found) diagnostics.push({ ...range, severity: 'error', message: `${name} is not found` })
      else if (isRequest && !activeRequestNames.has(name)) {
        diagnostics.push({ ...range, severity: 'information', message: `Request '${name}' has not been sent` })
      }
    }
  }

  return { definitions, requestDefinitions, requestReferences, symbols, links, diagnostics }
}

export function getDesktopHttpCompletions(
  source: string,
  offset: number,
  environment: Readonly<Record<string, string>>,
  model: DesktopHttpLanguageModel,
): readonly DesktopHttpCompletion[] {
  const lineStart = Math.max(source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1, 0)
  const line = source.slice(lineStart, offset)
  const path = line.match(/\{\{(\w+)\.([^{}]*)$/)
  if (path && model.requestDefinitions[path[1]]) {
    const rest = path[2]
    if (!rest.includes('.')) return ['request', 'response'].map((label) => ({ label, detail: 'HTTP Request Variable', type: 'property' as const }))
    if (/^(?:request|response)\.[^.]*$/.test(rest)) return ['body', 'headers'].map((label) => ({ label, detail: 'HTTP Request Variable', type: 'property' as const }))
  }
  if (/^\s*(?:Content-Type|Accept)\s*:\s*[^\s]*$/i.test(line)) {
    return MIME_TYPES.map((label) => ({ label, detail: 'HTTP MIME', type: 'text' as const }))
  }
  if (/^\s*Authorization\s*:\s*[^\s]*$/i.test(line)) {
    return [
      { label: 'Basic Base64', apply: 'Basic ${base64-user-password}', detail: 'HTTP Authentication', type: 'text' },
      { label: 'Basic Raw Credential', apply: 'Basic ${username}:${password}', detail: 'HTTP Authentication', type: 'text' },
      { label: 'Digest', apply: 'Digest ${username} ${password}', detail: 'HTTP Authentication', type: 'text' },
    ]
  }
  const variables: DesktopHttpCompletion[] = [
    { label: '$timestamp', apply: '{{$timestamp}}', detail: 'HTTP System Variable', type: 'variable' },
    { label: '$randomInt', apply: '{{$randomInt 1 100}}', detail: 'HTTP System Variable', type: 'variable' },
    { label: '$processEnv', apply: '{{$processEnv NAME}}', detail: 'HTTP System Variable', type: 'variable' },
    { label: '$dotenv', apply: '{{$dotenv NAME}}', detail: 'HTTP System Variable', type: 'variable' },
    ...Object.entries(environment).map(([label, value]) => ({ label, apply: `{{${label}}}`, detail: `HTTP Environment Variable · ${value}`, type: 'variable' as const })),
    ...Object.values(model.definitions).map(({ name, value }) => ({ label: name, apply: `{{${name}}}`, detail: `HTTP File Variable · ${value}`, type: 'variable' as const })),
    ...Object.keys(model.requestDefinitions).map((name) => ({ label: name, apply: `{{${name}.response.body.$}}`, detail: 'HTTP Request Variable', type: 'variable' as const })),
  ]
  if (/\{\{[^}]*$/.test(line)) return variables
  if (/^\s*[A-Za-z-]*$/.test(line) && !line.includes(':')) {
    return [...METHODS.map((label) => ({ label, detail: 'HTTP Method', type: 'keyword' as const })), ...variables]
  }
  if (/^\s*[A-Za-z-]*$/.test(line) || /^\s*[A-Za-z-]+:\s*$/.test(line)) {
    return [...HEADERS.map((label) => ({ label, apply: `${label}: `, detail: 'HTTP Header', type: 'property' as const })), ...variables]
  }
  return variables
}

export function findDesktopHttpToken(model: DesktopHttpLanguageModel, offset: number) {
  for (const definition of Object.values(model.definitions)) {
    if (contains(definition, offset)) return { name: definition.name, kind: 'file' as const, definition, references: definition.references }
    const reference = definition.references.find((item) => contains(item, offset))
    if (reference) return { name: definition.name, kind: 'file' as const, definition, references: definition.references }
  }
  for (const [name, definition] of Object.entries(model.requestDefinitions)) {
    if (contains(definition, offset) || model.requestReferences[name]?.some((item) => contains(item, offset))) {
      return { name, kind: 'request' as const, definition, references: model.requestReferences[name] ?? [] }
    }
  }
  return undefined
}

function lineStarts(source: string): number[] {
  const result = [0]
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) result.push(i + 1)
  return result
}

function contains(range: DesktopHttpRange, offset: number) {
  return offset >= range.from && offset <= range.to
}

function isSystemVariable(name: string) {
  return /^\$(?:timestamp|randomInt|processEnv|dotenv)$/i.test(name)
}

function safeUrlPath(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return `${decodeURIComponent(url.pathname)}${url.search}` || '/'
  } catch {
    return rawUrl
  }
}
