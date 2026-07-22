import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const serviceUrl = pathToFileURL(resolve('out/desktop/shared/http-language.js')).href

test('HTTP language model exposes definitions, references, symbols, links and diagnostics', async () => {
  const service = await import(serviceUrl)
  const source = [
    '@host = https://example.com',
    '# @name login',
    'POST {{host}}/login HTTP/1.1',
    'Content-Type: application/json',
    '',
    '< ./payload.json',
    '###',
    'GET {{host}}/users/{{login.response.headers.x-user}}/{{missing}}',
    'Authorization: Bearer {{token}}',
  ].join('\n')
  const model = service.parseDesktopHttpLanguage(source, { token: 'secret' })

  assert.equal(model.definitions.host.value, 'https://example.com')
  assert.equal(model.definitions.host.references.length, 2)
  assert.ok(model.requestDefinitions.login)
  assert.equal(model.requestReferences.login.length, 1)
  assert.deepEqual(model.symbols.map(symbol => [symbol.kind, symbol.name]), [
    ['variable', 'host'], ['request', 'login'], ['request', 'GET /users/{{login.response.headers.x-user}}/{{missing}}'],
  ])
  assert.equal(model.links[0].target, './payload.json')
  assert.deepEqual(model.diagnostics.map(diagnostic => [diagnostic.severity, diagnostic.message]), [
    ['information', "Request 'login' has not been sent"], ['error', 'missing is not found'],
  ])
  const loginOffset = source.indexOf('{{login.') + 4
  const login = service.findDesktopHttpToken(model, loginOffset)
  assert.equal(login.name, 'login')
  assert.equal(login.kind, 'request')
})

test('HTTP completion service covers methods, MIME values, all variable kinds and request paths', async () => {
  const service = await import(serviceUrl)
  const source = '@host = https://example.com\n# @name login\nGET {{host}}\n\n{{'
  const model = service.parseDesktopHttpLanguage(source, { token: 'abc' })
  const variables = service.getDesktopHttpCompletions(source, source.length, { token: 'abc' }, model)
  assert.ok(variables.some(item => item.label === '$timestamp'))
  assert.ok(variables.some(item => item.label === 'host' && item.apply === '{{host}}'))
  assert.ok(variables.some(item => item.label === 'token' && item.detail.includes('Environment')))
  assert.ok(variables.some(item => item.label === 'login' && item.apply.includes('response.body')))

  const mimeSource = `${source}\nContent-Type: application/`
  const mime = service.getDesktopHttpCompletions(mimeSource, mimeSource.length, {}, model)
  assert.ok(mime.some(item => item.label === 'application/json'))

  const pathSource = `${source}\n{{login.response.`
  const path = service.getDesktopHttpCompletions(pathSource, pathSource.length, {}, model)
  assert.deepEqual(path.map(item => item.label), ['body', 'headers'])
})

test('HTTP diagnostics ignore comment references and clear sent request information', async () => {
  const service = await import(serviceUrl)
  const source = '# @name ready\nGET https://example.com\n# {{ignored}}\nGET {{ready.response.body.id}}'
  const before = service.parseDesktopHttpLanguage(source)
  assert.deepEqual(before.diagnostics.map(item => item.message), ["Request 'ready' has not been sent"])
  const after = service.parseDesktopHttpLanguage(source, {}, new Set(['ready']))
  assert.deepEqual(after.diagnostics, [])
})
