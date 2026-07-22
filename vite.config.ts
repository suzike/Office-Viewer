import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { vditorDevPlugin, vditorProdBuildPlugin } from './vite/vditorPlugin'

const cwd = process.cwd()
const argv = process.argv
const isProdBuild = argv.includes('build') && argv.some((arg) => arg.includes('production'))

if (isProdBuild) {
  // The repository now has two independent products under `out`: the VS Code
  // extension and the Electron desktop application. Clean only extension-owned
  // outputs so an extension regression build cannot invalidate a desktop test
  // or a freshly assembled Windows application.
  for (const output of [
    'extension.js',
    'extension.web.js',
    'node_modules',
    'styles',
    'template',
    'webview',
    '7zz.wasm',
    'unrar.wasm',
  ]) {
    rmSync(resolve(cwd, 'out', output), { recursive: true, force: true })
  }
}

if (argv.join(',').includes('mode')) {
  void import('./build')
}

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => ({
  plugins: [
    react(),
    command === 'serve' ?
      vditorDevPlugin() : vditorProdBuildPlugin()
  ],
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      stream: resolve(cwd, 'src/react/shims/nodeStream.ts'),
      util: resolve(cwd, 'src/react/shims/nodeUtil.ts'),
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  server: {
    cors: {
      origin: true,
    },
    host: '127.0.0.1',
    port: 5739,
    fs: {
      allow: ['..'],
    },
  },
  base: '',
  build: {
    outDir: 'out/webview',
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        // 只把 main chunk 静态依赖到的通用部分拆成稳定 vendor chunk，
        // 避免把 lazy viewer 的重依赖提前到首屏。
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // react/react-dom/scheduler 每个 viewer 都依赖，且版本稳定
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor'
          // antd 核心：仅 main.tsx 静态依赖的 ConfigProvider/theme/cssinjs 基础设施，
          // 不包含具体组件（table/picker 等仍随各 lazy viewer 分包）
          if (/[\\/]node_modules[\\/]antd[\\/]es[\\/](config-provider|theme|version)[\\/]/.test(id)) return 'antd-vendor'
          if (/[\\/]node_modules[\\/]@ant-design[\\/](cssinjs|colors|fast-color)[\\/]/.test(id)) return 'antd-vendor'
          return undefined
        },
      },
    },
  }
}))
