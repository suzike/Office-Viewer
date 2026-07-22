import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DesktopHttpService, parseHttpDocument } from '../../out/desktop/main/http-service.js'

test('parseHttpDocument preserves delimiter, name and confirmation semantics', () => {
  const blocks = parseHttpDocument([
    '@host = https://example.com',
    '# @name first',
    '# @note',
    'GET {{host}}/one HTTP/1.1',
    '',
    '###',
    'curl -X POST -H "Content-Type: application/json" -d \'{"ok":true}\' https://example.com/two',
  ].join('\n'))

  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].name, 'first')
  assert.equal(blocks[0].warnBeforeSend, true)
  assert.equal(blocks[0].startLine, 3)
  assert.match(blocks[1].text, /^curl -X POST/)
})

test('DesktopHttpService executes named requests, environments and response variables', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'office-http-test-'))
  const documentPath = join(workspace, 'requests.http')
  await writeFile(documentPath, '')
  t.after(() => rm(workspace, { recursive: true, force: true }))

  const server = createServer((request, response) => {
    if (request.url === '/token') {
      response.setHeader('content-type', 'application/json')
      response.end('{"value":"resolved"}')
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ url: request.url, environment: request.headers['x-environment'] }))
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const source = [
    '# @name token',
    `GET ${origin}/token`,
    '',
    '###',
    `GET ${origin}/{{token.response.body.value}}`,
    'X-Environment: {{target}}',
  ].join('\n')
  const service = new DesktopHttpService(() => documentPath)

  await assert.rejects(
    service.send('session', source, 0, 'request-default-blocked', {}),
    /Private and local network HTTP targets are blocked/,
  )
  const first = await service.send('session', source, 0, 'request-token-one', { allowPrivateNetwork: true })
  assert.equal(first.statusCode, 200)
  assert.equal(first.request.name, 'token')
  const second = await service.send('session', source, 1, 'request-token-two', {
    allowPrivateNetwork: true,
    environment: { target: 'desktop' },
    previewOption: 'full',
  })
  assert.match(second.body, /"url":"\/resolved"/)
  assert.match(second.body, /"environment":"desktop"/)
  assert.match(second.preview, /^HTTP\/1\.1 200/)
})

test('DesktopHttpService strips credentials on cross-origin redirects', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'office-http-redirect-'))
  const documentPath = join(workspace, 'redirect.rest')
  await writeFile(documentPath, '')
  t.after(() => rm(workspace, { recursive: true, force: true }))

  const target = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null }))
  })
  await listen(target)
  t.after(() => close(target))
  const targetAddress = target.address()
  assert.ok(targetAddress && typeof targetAddress === 'object')

  const redirect = createServer((_request, response) => {
    response.statusCode = 302
    response.setHeader('location', `http://127.0.0.1:${targetAddress.port}/target`)
    response.end()
  })
  await listen(redirect)
  t.after(() => close(redirect))
  const redirectAddress = redirect.address()
  assert.ok(redirectAddress && typeof redirectAddress === 'object')

  const source = [
    `GET http://127.0.0.1:${redirectAddress.port}/redirect`,
    'Authorization: Bearer should-not-cross-origin',
    'Cookie: session=should-not-cross-origin',
  ].join('\n')
  const service = new DesktopHttpService(() => documentPath)
  const result = await service.send('session', source, 0, 'request-redirect-safe', {
    allowPrivateNetwork: true,
    followRedirect: true,
  })
  assert.equal(result.redirectCount, 1)
  assert.deepEqual(JSON.parse(result.body), { authorization: null, cookie: null })
})

test('DesktopHttpService restricts body files to the request directory', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'office-http-files-'))
  const documentPath = join(workspace, 'body.http')
  const outsidePath = join(workspace, '..', `outside-${Date.now()}.txt`)
  await writeFile(documentPath, '')
  await writeFile(outsidePath, 'secret')
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(outsidePath, { force: true })
  })
  const service = new DesktopHttpService(() => documentPath)
  const source = `POST http://example.com/upload\n\n< ../${outsidePath.split(/[\\/]/).at(-1)}`
  await assert.rejects(
    service.send('session', source, 0, 'request-file-traversal', {}),
    /escapes the request document directory/,
  )
})

test('DesktopHttpService preserves GraphQL, form encoding and Basic raw credential syntax', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'office-http-parsing-'))
  const documentPath = join(workspace, 'parsing.http')
  await writeFile(documentPath, '')
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
    response.setHeader('content-type', 'application/json')
    response.end('{"ok":true}')
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const source = [
    `POST ${origin}/graphql`,
    'X-Request-Type: GraphQL',
    'Authorization: Basic user password',
    '',
    'query ($id: ID!) { node(id: $id) { id } }',
    '',
    '{"id":"1"}',
    '###',
    `POST ${origin}/form`,
    'Content-Type: application/x-www-form-urlencoded',
    '',
    'message=hello world&symbol=a/b',
  ].join('\n')
  const service = new DesktopHttpService(() => documentPath)
  await service.send('session', source, 0, 'request-graphql', { allowPrivateNetwork: true })
  await service.send('session', source, 1, 'request-form-encoded', {
    allowPrivateNetwork: true,
    formParamEncodingStrategy: 'always',
  })
  assert.deepEqual(JSON.parse(requests[0].body), {
    query: 'query ($id: ID!) { node(id: $id) { id } }',
    variables: { id: '1' },
  })
  assert.equal(requests[0].headers.authorization, `Basic ${Buffer.from('user:password').toString('base64')}`)
  assert.equal(requests[1].body, 'message=hello%20world&symbol=a%2Fb')
})

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
