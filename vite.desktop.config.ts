import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const packageVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version as string

function copyOriginalPdfViewer() {
  return {
    name: 'copy-original-pdf-viewer',
    closeBundle() {
      const outputRoot = resolve(__dirname, 'out/desktop-renderer')
      const pdfOutput = resolve(outputRoot, 'pdf')
      cpSync(resolve(__dirname, 'resource/pdf'), pdfOutput, { recursive: true })
      mkdirSync(resolve(outputRoot, 'lib'), { recursive: true })
      cpSync(resolve(__dirname, 'resource/lib/vscode.js'), resolve(outputRoot, 'lib/vscode.js'))
      cpSync(resolve(__dirname, 'node_modules/heic2any/dist/heic2any.min.js'), resolve(outputRoot, 'heic2any.min.js'))

      const bridgePath = resolve(outputRoot, 'lib/vscode.js')
      const bridgeScript = readFileSync(bridgePath, 'utf8')
        .replace(
          'const postMessage = (message) => { if (vscode) { vscode.postMessage(message) } }',
          'const postMessage = (message) => { if (vscode) { vscode.postMessage(message) } else if (window.parent !== window) { window.parent.postMessage({ __officePdfViewer: true, message }, "*") } }',
        )
      writeFileSync(bridgePath, bridgeScript)

      const viewerPath = resolve(pdfOutput, 'viewer.html')
      const viewerHtml = readFileSync(viewerPath, 'utf8')
        .replace('{{baseUrl}}', '.')
        .replace(
          '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
          '<meta http-equiv="X-UA-Compatible" content="IE=edge">\n' +
          '  <meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\' \'unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\'; worker-src \'self\' blob:; frame-src \'none\'; object-src \'none\'; base-uri \'self\'; form-action \'none\'">',
        )
      writeFileSync(viewerPath, viewerHtml)

      const markdownOutput = resolve(outputRoot, 'markdown')
      cpSync(resolve(__dirname, 'resource/markdown'), markdownOutput, { recursive: true })
      cpSync(resolve(__dirname, 'resource/lib/vscode.js'), resolve(markdownOutput, 'vscode.js'))

      const markdownBridgePath = resolve(markdownOutput, 'vscode.js')
      const markdownBridge = readFileSync(markdownBridgePath, 'utf8')
        .replace(
          'const postMessage = (message) => { if (vscode) { vscode.postMessage(message) } }',
          'const postMessage = (message) => { if (vscode) { vscode.postMessage(message) } else if (window.parent !== window) { window.parent.postMessage({ __officeMarkdownViewer: true, message }, "*") } }',
        )
        .replace(
          /function receive\(\{ data \}\) \{\r?\n    if \(!data\)/,
          'function receive(event) {\n    if (window.parent !== window && event.source !== window.parent) return;\n    const { data } = event;\n    if (!data)',
        )
        .replace(
          'const isMac = navigator.userAgent.includes(\'Mac OS\');',
          'window.__officeDesktopMarkdown = !vscode && window.parent !== window;\nconst isMac = navigator.userAgent.includes(\'Mac OS\');',
        )
        .replace(
          'else if ((isCompose(e) && e.code == \'KeyV\')',
          'else if (vscode && (isCompose(e) && e.code == \'KeyV\')',
        )
      writeFileSync(markdownBridgePath, markdownBridge)

      const markdownUtilPath = resolve(markdownOutput, 'util.js')
      const markdownUtil = readFileSync(markdownUtilPath, 'utf8')
        .replace(
          /case 'KeyV':\r?\n                    if \(isInsideCodeMirrorTarget/,
          "case 'KeyV':\n                    if (window.__officeDesktopMarkdown) return;\n                    if (isInsideCodeMirrorTarget",
        )
      writeFileSync(markdownUtilPath, markdownUtil)

      const markdownIndexPath = resolve(markdownOutput, 'index.html')
      const markdownIndex = readFileSync(markdownIndexPath, 'utf8')
        .replace('<script src="dist/index.min.js"></script>', '<script src="/assets/desktop-secret-guard.js"></script>\n<script src="dist/index.min.js"></script>')
        .replace('href="dist/index.css"', 'href="/assets/dist/index.css"')
        .replace('href="index.css"', 'href="/assets/index.css"')
        .replace('src="dist/index.min.js"', 'src="/assets/dist/index.min.js"')
        .replace('src="../lib/vscode.js"', 'src="/assets/vscode.js"')
        .replace('src="index.js"', 'src="/assets/index.js"')
      writeFileSync(markdownIndexPath, markdownIndex)
    },
  }
}

export default defineConfig({
  plugins: [react(), copyOriginalPdfViewer()],
  base: './',
  define: {
    global: 'globalThis',
    __OFFICE_DESKTOP_VERSION__: JSON.stringify(packageVersion),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      buffer: 'buffer',
      stream: resolve(__dirname, 'src/react/shims/nodeStream.ts'),
      util: resolve(__dirname, 'src/react/shims/nodeUtil.ts'),
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  build: {
    outDir: 'out/desktop-renderer',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: resolve(__dirname, 'index.desktop.html'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5740,
    strictPort: true,
  },
})
