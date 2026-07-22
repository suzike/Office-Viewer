import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { MarkdownAiService } from '../../out/desktop/main/markdown-ai-service.js'

test('Markdown AI streams OpenAI-compatible chunks without exposing the key in the URL', async (t) => {
  let request
  const server = createServer(async (incoming, response) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    request = { url: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"Polished "}}]}\n\n')
    response.end('data: {"choices":[{"delta":{"content":"Markdown"}}]}\n\ndata: [DONE]\n\n')
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  const output = []
  await new MarkdownAiService().stream('request-openai', '# rough', {
    engine: 'custom', customApiFormat: 'openai', customUrl: `http://127.0.0.1:${address.port}`,
    customKey: 'safe-key', customModel: 'test-model', outputLanguage: 'zh-CN',
  }, (chunk) => output.push(chunk))

  assert.equal(output.join(''), 'Polished Markdown')
  assert.equal(request.url, '/v1/chat/completions')
  assert.equal(request.authorization, 'Bearer safe-key')
  assert.equal(request.body.model, 'test-model')
  assert.match(request.body.messages[0].content, /Simplified Chinese/)
})

test('Markdown AI preserves non-streaming Anthropic JSON responses', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"content":[{"type":"text","text":"完整润色结果"}]}')
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  const output = []
  await new MarkdownAiService().stream('request-anthropic', '原文', {
    customApiFormat: 'anthropic', customUrl: `http://127.0.0.1:${address.port}`,
  }, (chunk) => output.push(chunk))
  assert.equal(output.join(''), '完整润色结果')
})

test('Markdown AI cancellation aborts the provider request and credential query parameters are rejected', async (t) => {
  let requestStarted
  const started = new Promise((resolve) => { requestStarted = resolve })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': waiting\n\n')
    requestStarted()
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  const service = new MarkdownAiService()
  const running = service.stream('request-cancel', 'cancel me', {
    customApiFormat: 'openai', customUrl: `http://127.0.0.1:${address.port}`,
  }, () => undefined)
  await started
  assert.equal(service.cancel('request-cancel'), true)
  await assert.rejects(running, /abort/i)
  await assert.rejects(
    () => service.stream('request-secret-url', 'text', { customUrl: 'https://example.invalid/v1?api_key=plaintext' }, () => undefined),
    /API key field/,
  )
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
