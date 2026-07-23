import assert from 'node:assert/strict'
import test from 'node:test'
import { HTML_INSPECTOR_SOURCE, injectHtmlInspector } from '../../out/desktop/main/html-inspector-script.js'

test('HTML inspector script is injected immediately after the head tag', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body></body></html>'
  const output = injectHtmlInspector(html)
  const headAt = output.indexOf('<head>')
  const scriptAt = output.indexOf('<script>')
  assert.ok(headAt >= 0)
  assert.ok(scriptAt > headAt, 'inspector script must follow the head tag')
  assert.ok(scriptAt < output.indexOf('<meta'), 'inspector script must run before any other head content')
  assert.ok(output.includes(HTML_INSPECTOR_SOURCE))
})

test('HTML inspector script falls back to the doctype or document start without a head tag', () => {
  const withDoctype = injectHtmlInspector('<!doctype html><p>fragment</p>')
  assert.ok(withDoctype.startsWith('<!doctype html><script>'))
  const bare = injectHtmlInspector('<p>fragment</p>')
  assert.ok(bare.startsWith('<script>'))
})

test('HTML inspector script bridges console, errors, resources and paint metrics', () => {
  assert.match(HTML_INSPECTOR_SOURCE, /office-html-inspector/)
  assert.match(HTML_INSPECTOR_SOURCE, /unhandledrejection/)
  assert.match(HTML_INSPECTOR_SOURCE, /getEntriesByType\('resource'\)/)
  assert.match(HTML_INSPECTOR_SOURCE, /largest-contentful-paint/)
  assert.match(HTML_INSPECTOR_SOURCE, /first-contentful-paint/)
  assert.match(HTML_INSPECTOR_SOURCE, /collect-resources/)
})

test('HTML inspector script is safe to embed in an inline script tag', () => {
  assert.doesNotMatch(HTML_INSPECTOR_SOURCE, /<\/script/i)
  assert.doesNotMatch(HTML_INSPECTOR_SOURCE, /<!--/)
})
