import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAiCliError, parseAiCliLine } from '../../out/desktop/main/ai-assistant-service.js'

test('local AI CLI parser accepts bounded Codex and Claude text events without rendering diagnostics', () => {
  assert.equal(parseAiCliLine('codex-cli', JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'Codex result' },
  })), 'Codex result')
  assert.equal(parseAiCliLine('codex-cli', JSON.stringify({ type: 'turn.started' })), '')
  assert.equal(parseAiCliLine('claude-cli', JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { text: 'Claude delta' } },
  })), 'Claude delta')
  assert.equal(parseAiCliLine('claude-cli', JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Claude message' }] },
  })), 'Claude message')
  assert.equal(parseAiCliLine('claude-cli', 'not-json'), '')
})

test('local AI CLI error parser surfaces Codex stdout failures and ignores transient reconnect notices', () => {
  assert.deepEqual(parseAiCliError('codex-cli', JSON.stringify({
    type: 'turn.failed',
    error: { message: 'stream disconnected before completion' },
  })), { message: 'stream disconnected before completion', fatal: true })
  assert.deepEqual(parseAiCliError('codex-cli', JSON.stringify({
    type: 'error',
    message: 'stream disconnected before completion',
  })), { message: 'stream disconnected before completion', fatal: false })
  assert.equal(parseAiCliError('codex-cli', JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (request timed out)' })), undefined)
  assert.equal(parseAiCliError('codex-cli', JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Falling back' } })), undefined)
  assert.equal(parseAiCliError('codex-cli', JSON.stringify({ type: 'turn.started' })), undefined)
})

test('local AI CLI error parser surfaces Claude error results', () => {
  assert.deepEqual(parseAiCliError('claude-cli', JSON.stringify({
    type: 'result',
    is_error: true,
    result: 'Credit balance is too low',
  })), { message: 'Credit balance is too low', fatal: true })
  assert.equal(parseAiCliError('claude-cli', JSON.stringify({ type: 'result', is_error: false, result: 'ok' })), undefined)
  assert.equal(parseAiCliError('claude-cli', 'not-json'), undefined)
})
