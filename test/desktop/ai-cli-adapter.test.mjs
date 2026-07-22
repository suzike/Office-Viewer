import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAiCliLine } from '../../out/desktop/main/ai-assistant-service.js'

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
