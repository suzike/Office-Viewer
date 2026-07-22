import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node,
  type Pair,
  type ParsedNode,
  type YAMLMap,
} from 'yaml'
import type { DesktopTextLanguage } from './text-language-routing'
export { isDesktopTextFile, resolveDesktopTextLanguage } from './text-language-routing'
export type { DesktopTextLanguage } from './text-language-routing'

export interface DesktopTextSnippet {
  readonly label: string
  readonly detail: string
  readonly template: string
}

export interface YamlOutlineSymbol {
  readonly name: string
  readonly kind: 'document' | 'field' | 'object' | 'item'
  readonly from: number
  readonly to: number
  readonly selectionFrom: number
  readonly selectionTo: number
  readonly children: readonly YamlOutlineSymbol[]
}

export interface YamlAnchorDefinition {
  readonly name: string
  readonly from: number
  readonly to: number
}

export interface YamlAliasReference {
  readonly source: string
  readonly from: number
  readonly to: number
}

export interface YamlDesktopModel {
  readonly symbols: readonly YamlOutlineSymbol[]
  readonly anchors: Readonly<Record<string, YamlAnchorDefinition>>
  readonly aliases: readonly YamlAliasReference[]
}

const SNIPPETS: Readonly<Record<DesktopTextLanguage, readonly DesktopTextSnippet[]>> = {
  yaml: [
    { label: 'anchor', detail: 'YAML anchor and alias', template: '${name}: &${anchor}\n  ${key}: ${value}\n${reference}: *${anchor}' },
    { label: 'document', detail: 'YAML document separator', template: '---\n${content}\n...' },
  ],
  xml: [
    { label: 'element', detail: 'XML element', template: '<${name}>\n  ${content}\n</${name}>' },
    { label: 'declaration', detail: 'XML declaration', template: '<?xml version="1.0" encoding="UTF-8"?>' },
  ],
  nginx: [
    { label: 'server', detail: 'NGINX server block', template: 'server {\n  listen ${80};\n  server_name ${example.com};\n\n  location / {\n    ${directive}\n  }\n}' },
    { label: 'location', detail: 'NGINX location block', template: 'location ${/} {\n  ${directive}\n}' },
  ],
  kotlin: [
    { label: 'fun', detail: 'Kotlin function', template: 'fun ${name}(${parameters})${returnType} {\n  ${body}\n}' },
    { label: 'main', detail: 'Kotlin main function', template: 'fun main() {\n  ${body}\n}' },
    { label: 'class', detail: 'Kotlin class', template: 'class ${Name}(${parameters}) {\n  ${body}\n}' },
  ],
  reg: [
    { label: 'header', detail: 'Windows Registry file header', template: 'Windows Registry Editor Version 5.00\n\n[${HKEY_CURRENT_USER\\Software\\Vendor}]' },
    { label: 'string', detail: 'Registry string value', template: '"${Name}"="${Value}"' },
  ],
  toml: [
    { label: 'table', detail: 'TOML table', template: '[${table}]\n${key} = "${value}"' },
    { label: 'array-table', detail: 'TOML array of tables', template: '[[${items}]]\n${key} = "${value}"' },
  ],
  kusto: [
    { label: 'let', detail: 'Kusto let binding', template: 'let ${name} = ${expression};' },
    { label: 'summarize', detail: 'Kusto summarize pipeline', template: '| summarize ${count = count()} by ${dimension}' },
  ],
  plaintext: [],
}

export function getDesktopTextSnippets(language: DesktopTextLanguage): readonly DesktopTextSnippet[] {
  return SNIPPETS[language]
}

export function parseYamlDesktopModel(text: string): YamlDesktopModel {
  const symbols: YamlOutlineSymbol[] = []
  const anchors: Record<string, YamlAnchorDefinition> = {}
  const aliases: YamlAliasReference[] = []
  try {
    const documents = parseAllDocuments(text, { strict: false, prettyErrors: false })
    for (let index = 0; index < documents.length; index += 1) {
      const contents = documents[index].contents as Node | null
      if (!contents) continue
      const documentSymbols = buildYamlSymbols(contents)
      collectYamlReferences(contents, anchors, aliases)
      if (documents.length <= 1 || !contents.range) symbols.push(...documentSymbols)
      else {
        symbols.push({
          name: `Document ${index + 1}`,
          kind: 'document',
          from: contents.range[0],
          to: contents.range[2],
          selectionFrom: contents.range[0],
          selectionTo: contents.range[2],
          children: documentSymbols,
        })
      }
    }
  } catch {
    // Match the original provider: malformed YAML produces an empty model.
  }
  return { symbols, anchors, aliases }
}

export function findYamlAliasAtOffset(offset: number, aliases: readonly YamlAliasReference[]): YamlAliasReference | undefined {
  return aliases.find((alias) => offset >= alias.from && offset <= alias.to)
}

export function formatXmlText(text: string, indent = '  '): string {
  if (!text.trim()) return text
  const shifts = ['\n']
  for (let index = 0; index < 100; index += 1) shifts.push(shifts[index] + indent)
  const parts = text.replace(/>\s{0,}</g, '><')
    .replace(/</g, '~::~<')
    .replace(/xmlns\:/g, '~::~xmlns:')
    .replace(/xmlns\=/g, '~::~xmlns=')
    .split('~::~')
  let inComment = false
  let depth = 0
  let output = ''
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index]
    if (line.search(/<!/) > -1) {
      output += shifts[Math.max(0, depth)] + line
      inComment = true
      if (line.search(/-->/) > -1 || line.search(/\]>/) > -1 || line.search(/!DOCTYPE/) > -1) inComment = false
    } else if (line.search(/-->/) > -1 || line.search(/\]>/) > -1) {
      output += line
      inComment = false
    } else if (
      /^<\w/.test(parts[index - 1] ?? '') && /^<\/\w/.test(line) &&
      /^<[\w:\-.,]+/.exec(parts[index - 1] ?? '')?.[0] === /^<\/[\w:\-.,]+/.exec(line)?.[0].replace('/', '')
    ) {
      output += line
      if (!inComment) depth = Math.max(0, depth - 1)
    } else if (line.search(/<\w/) > -1 && line.search(/<\//) === -1 && line.search(/\/>/) === -1) {
      output += inComment ? line : shifts[Math.min(depth++, shifts.length - 1)] + line
    } else if (line.search(/<\w/) > -1 && line.search(/<\//) > -1) {
      output += inComment ? line : shifts[Math.min(depth, shifts.length - 1)] + line
    } else if (line.search(/<\//) > -1) {
      if (!inComment) depth = Math.max(0, depth - 1)
      output += inComment ? line : shifts[Math.min(depth, shifts.length - 1)] + line
    } else if (line.search(/\/>/) > -1 || line.search(/<\?/) > -1 || line.search(/xmlns\:/) > -1 || line.search(/xmlns\=/) > -1) {
      output += shifts[Math.min(depth, shifts.length - 1)] + line
    } else output += line
  }
  return output.startsWith('\n') ? output.slice(1) : output
}

function nodeBounds(node: { range?: [number, number, number] | null } | null | undefined): [number, number] | undefined {
  return node?.range ? [node.range[0], node.range[2]] : undefined
}

function pairKeyBounds(pair: Pair): [number, number] | undefined {
  const key = pair.key
  if (isScalar(key) && key.range) return [key.range[0], key.range[2]]
  if (key && typeof key === 'object' && 'range' in key) {
    const range = (key as ParsedNode).range
    if (range) return [range[0], range[2]]
  }
  return undefined
}

function pairName(pair: Pair): string {
  if (pair.key == null) return '<null>'
  if (isScalar(pair.key)) return String(pair.key.value ?? '')
  return String(pair.key)
}

function mapDisplayName(map: YAMLMap): string {
  for (const preferred of ['name', 'id', 'key', 'title']) {
    for (const pair of map.items) {
      if (isScalar(pair.key) && pair.key.value === preferred && isScalar(pair.value) && pair.value.value != null) {
        return String(pair.value.value)
      }
    }
  }
  return '[item]'
}

function buildYamlSymbols(node: Node): YamlOutlineSymbol[] {
  if (isMap(node)) {
    const result: YamlOutlineSymbol[] = []
    for (const pair of node.items) {
      const selection = pairKeyBounds(pair)
      const value = pair.value ? nodeBounds(pair.value as ParsedNode) : undefined
      const range = selection && value
        ? [Math.min(selection[0], value[0]), Math.max(selection[1], value[1])] as [number, number]
        : selection ?? value
      if (!selection || !range) continue
      const children = pair.value ? buildYamlSymbols(pair.value as Node) : []
      result.push({
        name: pairName(pair), kind: children.length ? 'object' : 'field',
        from: range[0], to: range[1], selectionFrom: selection[0], selectionTo: selection[1], children,
      })
    }
    return result
  }
  if (isSeq(node)) {
    const result: YamlOutlineSymbol[] = []
    for (let index = 0; index < node.items.length; index += 1) {
      const item = node.items[index] as Node | null
      const range = nodeBounds(item as ParsedNode)
      if (!item || !range) continue
      const display = isMap(item) ? mapDisplayName(item) : '[item]'
      result.push({
        name: display === '[item]' ? `[${index}]` : display,
        kind: isMap(item) ? 'object' : 'item',
        from: range[0], to: range[1], selectionFrom: range[0], selectionTo: range[1],
        children: isMap(item) ? buildYamlSymbols(item) : [],
      })
    }
    return result
  }
  return []
}

function collectYamlReferences(
  node: Node,
  anchors: Record<string, YamlAnchorDefinition>,
  aliases: YamlAliasReference[],
): void {
  const range = nodeBounds(node as ParsedNode)
  if (isAlias(node)) {
    if (range) aliases.push({ source: node.source, from: range[0], to: range[1] })
    return
  }
  if ('anchor' in node && node.anchor && range) {
    anchors[node.anchor] = { name: node.anchor, from: range[0], to: range[1] }
  }
  if (isMap(node)) {
    for (const pair of node.items) if (pair.value) collectYamlReferences(pair.value as Node, anchors, aliases)
  } else if (isSeq(node)) {
    for (const item of node.items) if (item) collectYamlReferences(item as Node, anchors, aliases)
  }
}
