(() => {
  'use strict'

  const channel = 'office-viewer:heic-decoder'
  const parentWindow = window.parent
  const maxInputBytes = 64 * 1024 * 1024
  const maxOutputBytes = 128 * 1024 * 1024

  function hasHeifContainer(bytes) {
    if (bytes.length < 12) return false
    return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp'
  }

  function hasJpegSignature(bytes) {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== parentWindow) return
    const message = event.data
    if (message?.channel !== channel || message?.type !== 'decode') return
    if (typeof message.id !== 'string' || !(message.buffer instanceof ArrayBuffer)) return

    try {
      const input = new Uint8Array(message.buffer)
      if (input.byteLength === 0 || input.byteLength > maxInputBytes || !hasHeifContainer(input)) {
        throw new Error('HEIC input failed isolated decoder validation')
      }
      if (typeof window.heic2any !== 'function') throw new Error('HEIC decoder runtime is unavailable')
      const converted = await window.heic2any({
        blob: new Blob([input], { type: 'image/heic' }),
        toType: 'image/jpeg',
        quality: 0.92,
      })
      const outputBlob = Array.isArray(converted) ? converted[0] : converted
      if (!(outputBlob instanceof Blob)) throw new Error('HEIC decoder returned no image')
      const output = new Uint8Array(await outputBlob.arrayBuffer())
      if (output.byteLength === 0 || output.byteLength > maxOutputBytes || !hasJpegSignature(output)) {
        throw new Error('HEIC decoder returned an invalid JPEG image')
      }
      parentWindow.postMessage({
        channel,
        type: 'decoded',
        id: message.id,
        mime: 'image/jpeg',
        buffer: output.buffer,
      }, '*', [output.buffer])
    } catch (reason) {
      parentWindow.postMessage({
        channel,
        type: 'error',
        id: message.id,
        error: reason instanceof Error ? reason.message : 'HEIC decoding failed',
      }, '*')
    }
  })

  parentWindow.postMessage({ channel, type: 'ready' }, '*')
})()
