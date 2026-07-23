import assert from 'node:assert/strict'
import test from 'node:test'
import { detectSensitiveContent } from '../../out/desktop/shared/sensitive-data.js'

test('sensitive content scanner detects private keys, tokens and assigned secrets', () => {
  const hits = detectSensitiveContent([
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA7',
    '-----END RSA PRIVATE KEY-----',
    'Authorization: Bearer abcdef1234567890',
    'api_key = "abcdef1234567890"',
  ].join('\n'))
  const rules = hits.map((hit) => hit.rule)
  assert.ok(rules.includes('private-key'))
  assert.ok(rules.includes('bearer-token'))
  assert.ok(rules.includes('secret-assignment'))
})

test('sensitive content scanner detects well-known API keys and AWS keys', () => {
  const hits = detectSensitiveContent('sk-proj-abcdef1234567890 和 AKIAIOSFODNN7EXAMPLE')
  const rules = hits.map((hit) => hit.rule)
  assert.ok(rules.includes('well-known-api-key'))
  assert.ok(rules.includes('aws-access-key'))
})

test('sensitive content scanner detects email addresses and valid id card numbers', () => {
  const hits = detectSensitiveContent('联系我 test@example.com，身份证 11010519491231002X')
  const rules = hits.map((hit) => hit.rule)
  assert.ok(rules.includes('email'))
  assert.ok(rules.includes('id-card'))
})

test('sensitive content scanner rejects id-card-like numbers with a bad checksum', () => {
  const hits = detectSensitiveContent('编号 110105194912310021 不是证件号')
  assert.equal(hits.some((hit) => hit.rule === 'id-card'), false)
})

test('sensitive content scanner masks samples and never echoes full secrets', () => {
  const secret = 'sk-proj-abcdef1234567890'
  const hits = detectSensitiveContent(`密钥是 ${secret}`)
  assert.equal(hits.length, 1)
  assert.equal(JSON.stringify(hits).includes(secret), false)
  assert.match(hits[0].sample, /^sk-…/)
})

test('sensitive content scanner reports each rule once and stays silent on clean text', () => {
  const hits = detectSensitiveContent('test@example.com 与 admin@example.com 两个邮箱')
  assert.equal(hits.filter((hit) => hit.rule === 'email').length, 1)
  assert.deepEqual(detectSensitiveContent('请帮我总结这段文字，联系电话 13800138000。'), [])
  assert.deepEqual(detectSensitiveContent(''), [])
})
