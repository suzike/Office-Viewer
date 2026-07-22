(() => {
  'use strict'

  const channel = 'office-viewer:woff2-decoder'
  const parentWindow = window.parent
  const maxFontBytes = 64 * 1024 * 1024
  let ready = false

  function isSupportedSfnt(bytes) {
    if (bytes.length < 4) return false
    const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
    return signature === 'OTTO' || signature === 'true' || signature === 'typ1' ||
      (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
  }

  window.Module = {
    onRuntimeInitialized() {
      ready = true
      parentWindow.postMessage({ channel, type: 'ready' }, '*')
    },
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parentWindow) return
    const message = event.data
    if (!ready || message?.channel !== channel || message?.type !== 'decode') return
    if (typeof message.id !== 'string' || !(message.buffer instanceof ArrayBuffer)) return

    try {
      if (message.buffer.byteLength === 0 || message.buffer.byteLength > maxFontBytes) {
        throw new Error('WOFF2 input exceeds the isolated decoder limit')
      }
      const decoded = Uint8Array.from(window.Module.decompress(message.buffer))
      if (decoded.byteLength > maxFontBytes || !isSupportedSfnt(decoded)) {
        throw new Error('WOFF2 decoder returned an invalid font')
      }
      parentWindow.postMessage({
        channel,
        type: 'decoded',
        id: message.id,
        buffer: decoded.buffer,
      }, '*', [decoded.buffer])
    } catch (reason) {
      parentWindow.postMessage({
        channel,
        type: 'error',
        id: message.id,
        error: reason instanceof Error ? reason.message : 'WOFF2 decoding failed',
      }, '*')
    }
  })
})()
