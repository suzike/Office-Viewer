import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AiAssistantService } from '../../out/desktop/main/ai-assistant-service.js'
import { AiAssistantSettingsService } from '../../out/desktop/main/ai-assistant-settings-service.js'
import { AiDocumentContextService } from '../../out/desktop/main/ai-document-context-service.js'
import { FileSessionManager } from '../../out/desktop/main/file-session-manager.js'

test('AI assistant streams an OpenAI-compatible answer with protected document context', async (t) => {
  let captured
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    captured = { authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"文档"}}]}\n\n')
    response.end('data: {"choices":[{"delta":{"content":"回答"}}]}\n\ndata: [DONE]\n\n')
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-service-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const path = join(directory, 'requirements.md')
  await writeFile(path, '# 要求\n系统需要支持离线查看。')
  const [session] = await sessions.registerPaths([path])
  const settings = new AiAssistantSettingsService(directory, testProtector())
  const defaults = await settings.load()
  await settings.save({
    activeProviderId: 'mock-api',
    providers: [
      ...defaults.providers.map((provider) => ({ ...provider, enabled: false })),
      { id: 'mock-api', name: 'Mock API', kind: 'openai-compatible', enabled: true, model: 'mock-model', baseUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetwork: true, apiKey: 'test-key' },
    ],
  })
  const service = new AiAssistantService(settings, new AiDocumentContextService(sessions), join(directory, 'sandbox'))
  const events = []
  await service.stream({
    requestId: 'assistant-test-123',
    sessionId: session.id,
    providerId: 'mock-api',
    messages: [{ role: 'user', content: '核心要求是什么？' }],
  }, (event) => events.push(event))

  assert.equal(events.filter((event) => event.type === 'chunk').map((event) => event.content).join(''), '文档回答')
  assert.equal(captured.authorization, 'Bearer test-key')
  assert.match(captured.body.messages[0].content, /系统需要支持离线查看/)
  assert.match(captured.body.messages[0].content, /不可信数据/)
  assert.equal(JSON.stringify(events).includes('test-key'), false)
})

test('AI provider detection is lazy, concurrent-safe, cached, and refreshable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-provider-probe-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const settings = new AiAssistantSettingsService(directory, testProtector())
  let probeCalls = 0
  let releaseProbe
  const probeGate = new Promise((resolve) => { releaseProbe = resolve })
  const service = new AiAssistantService(
    settings,
    new AiDocumentContextService(sessions),
    join(directory, 'sandbox'),
    async (kind) => {
      probeCalls += 1
      await probeGate
      return { detail: `${kind}.exe`, version: `${kind}-test` }
    },
  )

  assert.equal(probeCalls, 0, 'constructing the assistant service must not probe local CLIs')
  const first = service.probeProviders()
  const concurrent = service.probeProviders()
  releaseProbe()
  const [firstStatuses, concurrentStatuses] = await Promise.all([first, concurrent])
  assert.equal(probeCalls, 2, 'one detection pass should probe each enabled local CLI once')
  assert.deepEqual(concurrentStatuses, firstStatuses)

  await service.probeProviders()
  assert.equal(probeCalls, 2, 'reopening the assistant should reuse provider statuses')
  await service.probeProviders(true)
  assert.equal(probeCalls, 4, 'an explicit refresh should start a new detection pass')
})

test('AI provider HTTP probe measures latency and pulls model lists only on explicit refresh', async (t) => {
  const requests = []
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url })
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other-model' }] }))
      return
    }
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ models: [{ name: 'qwen3:latest' }] }))
      return
    }
    response.writeHead(404).end()
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-http-probe-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const settings = new AiAssistantSettingsService(directory, testProtector())
  const defaults = await settings.load()
  await settings.save({
    activeProviderId: 'mock-openai',
    providers: [
      ...defaults.providers.map((provider) => ({ ...provider, enabled: false })),
      { id: 'mock-openai', name: 'Mock OpenAI', kind: 'openai-compatible', enabled: true, model: 'mock-model', baseUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetwork: true, apiKey: 'test-key' },
      { id: 'mock-ollama', name: 'Mock Ollama', kind: 'ollama', enabled: true, model: 'qwen3', baseUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetwork: true },
    ],
  })
  const service = new AiAssistantService(settings, new AiDocumentContextService(sessions), join(directory, 'sandbox'))

  const lazyStatuses = await service.probeProviders()
  assert.equal(requests.length, 0, 'opening the panel must not send HTTP probe requests')
  assert.equal(lazyStatuses.find((status) => status.providerId === 'mock-openai')?.detail, '配置完整（未发送网络探测）')

  const probed = await service.probeProviders(true)
  const openai = probed.find((status) => status.providerId === 'mock-openai')
  assert.equal(openai?.available, true)
  assert.equal(typeof openai?.latencyMs, 'number')
  assert.deepEqual(openai?.models, ['mock-model', 'other-model'])
  assert.match(openai?.detail ?? '', /2 个模型 · 当前模型可用/)
  const ollama = probed.find((status) => status.providerId === 'mock-ollama')
  assert.equal(ollama?.available, true)
  assert.deepEqual(ollama?.models, ['qwen3:latest'])
  assert.deepEqual(requests.map((entry) => entry.url).sort(), ['/api/tags', '/v1/models'])
})

test('AI assistant injects the configured persona ahead of the document prompt', async (t) => {
  let captured
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    captured = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.end('{"message":{"content":"好的"}}\n')
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-persona-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const path = join(directory, 'notes.md')
  await writeFile(path, '# 笔记\n一些内容。')
  const [session] = await sessions.registerPaths([path])
  const settings = new AiAssistantSettingsService(directory, testProtector())
  const defaults = await settings.load()
  await settings.save({
    activeProviderId: 'mock-ollama',
    providers: [
      ...defaults.providers.map((provider) => ({ ...provider, enabled: false })),
      { id: 'mock-ollama', name: 'Mock Ollama', kind: 'ollama', enabled: true, model: 'qwen3', baseUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetwork: true },
    ],
    promptProfile: { persona: '资深技术编辑', outputLanguage: '简体中文', style: '结论先行' },
  })
  const service = new AiAssistantService(settings, new AiDocumentContextService(sessions), join(directory, 'sandbox'))
  await service.stream({
    requestId: 'assistant-persona-1',
    sessionId: session.id,
    providerId: 'mock-ollama',
    messages: [{ role: 'user', content: '你好' }],
  }, () => undefined)

  const prompt = captured?.messages?.[0]?.content ?? ''
  assert.match(prompt, /角色设定：资深技术编辑/)
  assert.match(prompt, /输出语言：简体中文/)
  assert.match(prompt, /回答风格：结论先行/)
  assert.ok(prompt.indexOf('角色设定') < prompt.indexOf('安全规则'), 'persona must be injected before the safety rules')
})

test('AI assistant applies configured model parameters to HTTP request bodies', async (t) => {
  const bodies = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    bodies.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.end('{"message":{"content":"好"}}\n')
  })
  await listen(server)
  t.after(() => close(server))
  const address = server.address()
  const directory = await mkdtemp(join(tmpdir(), 'office-ai-params-'))
  const sessions = new FileSessionManager()
  t.after(() => { sessions.dispose(); return rm(directory, { recursive: true, force: true }) })
  const path = join(directory, 'notes.md')
  await writeFile(path, '# 笔记\n一些内容。')
  const [session] = await sessions.registerPaths([path])
  const settings = new AiAssistantSettingsService(directory, testProtector())
  const defaults = await settings.load()
  await settings.save({
    activeProviderId: 'mock-ollama',
    providers: [
      ...defaults.providers.map((provider) => ({ ...provider, enabled: false })),
      { id: 'mock-ollama', name: 'Mock Ollama', kind: 'ollama', enabled: true, model: 'qwen3', baseUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetwork: true },
      { id: 'mock-openai', name: 'Mock OpenAI', kind: 'openai-compatible', enabled: true, model: 'mock-model', baseUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetwork: true, apiKey: 'test-key' },
    ],
    modelParameters: { temperature: 0.3, maxTokens: 1024 },
  })
  const service = new AiAssistantService(settings, new AiDocumentContextService(sessions), join(directory, 'sandbox'))
  for (const [index, providerId] of ['mock-ollama', 'mock-openai'].entries()) {
    await service.stream({
      requestId: `assistant-params-${index}`,
      sessionId: session.id,
      providerId,
      messages: [{ role: 'user', content: '你好' }],
    }, () => undefined)
  }

  const ollama = bodies.find((entry) => entry.url === '/api/chat')
  assert.equal(ollama?.body.options.temperature, 0.3)
  assert.equal(ollama?.body.options.num_predict, 1024)
  const openai = bodies.find((entry) => entry.url === '/v1/chat/completions')
  assert.equal(openai?.body.temperature, 0.3)
  assert.equal(openai?.body.max_tokens, 1024)
})

function testProtector() {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8').reverse(),
    decrypt: (value) => Buffer.from(value).reverse().toString('utf8'),
  }
}

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
