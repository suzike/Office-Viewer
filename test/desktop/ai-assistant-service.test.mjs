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
