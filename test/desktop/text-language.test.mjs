import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const serviceUrl = pathToFileURL(resolve('out/desktop/shared/text-language.js')).href

test('desktop text language routing covers contributed languages and NGINX special names', async () => {
  const service = await import(serviceUrl)
  const cases = [
    ['settings.yaml', 'yaml', 'yaml'], ['settings.yml', 'yml', 'yaml'],
    ['schema.xsd', 'xsd', 'xml'], ['Main.kt', 'kt', 'kotlin'],
    ['query.kql', 'kql', 'kusto'], ['values.reg', 'reg', 'reg'],
    ['Cargo.toml', 'toml', 'toml'], ['nginx.conf', 'conf', 'nginx'],
    ['mime.types', 'types', 'nginx'], ['fastcgi_params', '', 'nginx'],
    ['site.conf.template', 'template', 'nginx'], ['notes.txt', 'txt', 'plaintext'],
  ]
  for (const [name, extension, expected] of cases) {
    assert.equal(service.resolveDesktopTextLanguage(name, extension), expected, name)
    assert.equal(service.isDesktopTextFile(name, extension), true, name)
  }
  assert.equal(service.isDesktopTextFile('unknown.bin', 'bin'), false)
})

test('YAML desktop model preserves multi-document outlines and anchor/alias definitions', async () => {
  const service = await import(serviceUrl)
  const text = [
    '---',
    'defaults: &common',
    '  retries: 3',
    'service:',
    '  <<: *common',
    '  name: api',
    '---',
    'items:',
    '  - id: first',
    '    enabled: true',
  ].join('\n')
  const model = service.parseYamlDesktopModel(text)
  assert.deepEqual(model.symbols.map((symbol) => symbol.name), ['Document 1', 'Document 2'])
  assert.equal(model.symbols[0].children[0].name, 'defaults')
  assert.equal(model.symbols[1].children[0].children[0].name, 'first')
  assert.ok(model.anchors.common)
  assert.equal(model.aliases[0].source, 'common')
  const aliasOffset = text.indexOf('*common') + 2
  assert.equal(service.findYamlAliasAtOffset(aliasOffset, model.aliases)?.source, 'common')
})

test('XML formatter supports the original two/four-space and tab indentation semantics', async () => {
  const service = await import(serviceUrl)
  const source = '<?xml version="1.0"?><root><item id="1">value</item><empty/></root>'
  assert.equal(
    service.formatXmlText(source, '  '),
    '<?xml version="1.0"?>\n<root>\n  <item id="1">value</item>\n  <empty/>\n</root>',
  )
  assert.match(service.formatXmlText('<root><child/></root>', '\t'), /\n\t<child\/>/)
  assert.equal(service.formatXmlText('  \n', '    '), '  \n')
})

test('text languages expose bounded built-in completion templates', async () => {
  const service = await import(serviceUrl)
  for (const language of ['yaml', 'xml', 'nginx', 'kotlin', 'reg', 'toml', 'kusto']) {
    const snippets = service.getDesktopTextSnippets(language)
    assert.ok(snippets.length >= 2, language)
    assert.ok(snippets.every((snippet) => snippet.label.length > 0 && snippet.template.length < 1_000))
  }
  assert.deepEqual(service.getDesktopTextSnippets('plaintext'), [])
})
