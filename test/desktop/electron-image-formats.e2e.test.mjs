import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'
import UTIF from 'utif'

const repositoryRoot = resolve('.')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const applicationEntry = resolve('out/desktop/main/index.js')

test('desktop original image gallery renders every declared image suffix including real HEIC and TIFF', { timeout: 180_000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'This desktop E2E gate currently requires Windows.')

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-viewer-image-formats-test-'))
  const profileDirectory = join(temporaryDirectory, 'electron-profile')
  const imagesDirectory = join(temporaryDirectory, 'images')
  await writeFile(join(temporaryDirectory, '.keep'), '')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(imagesDirectory))

  const pngSource = resolve('image/logo.png')
  const heicSource = resolve('test/desktop/fixtures/heic2any-demo-1.heic')
  const nativeAliases = ['apng', 'bmp', 'cur', 'gif', 'ico', 'jpeg', 'jpg', 'pjp', 'pjpeg', 'png', 'webp']
  for (const extension of nativeAliases) {
    await copyFile(pngSource, join(imagesDirectory, `gallery-${extension}.${extension}`))
  }
  await copyFile(heicSource, join(imagesDirectory, 'gallery-heic.heic'))
  await copyFile(heicSource, join(imagesDirectory, 'gallery-heif.heif'))
  const tiff = UTIF.encodeImage(new Uint8Array([
    232, 83, 45, 255, 36, 122, 83, 255,
    38, 91, 154, 255, 244, 186, 54, 255,
  ]), 2, 2)
  await writeFile(join(imagesDirectory, 'gallery-tif.tif'), new Uint8Array(tiff))
  await writeFile(join(imagesDirectory, 'gallery-tiff.tiff'), new Uint8Array(tiff))

  const firstPath = join(imagesDirectory, 'gallery-png.png')
  const remoteDebuggingPort = await reservePort()
  const processOutput = []
  const applicationProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    applicationEntry,
    firstPath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  collectProcessOutput(applicationProcess, processOutput)

  let browser
  let page
  t.after(async () => {
    if (page && !page.isClosed()) await page.close().catch(() => undefined)
    browser?.disconnect()
    await stopProcess(applicationProcess)
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await connectToElectron(remoteDebuggingPort, applicationProcess, processOutput)
  page = await waitForApplicationPage(browser)
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message))

  await page.waitForSelector('.image-viewer .image-gallery', { timeout: 30_000 })
  await page.waitForFunction((expected) => (
    document.querySelectorAll('.image-gallery-thumbnail').length === expected &&
    document.querySelector('.image-viewer__loading') === null
  ), { timeout: 60_000 }, nativeAliases.length + 4).catch(() => undefined)
  const galleryDebug = await page.evaluate(() => ({
    thumbnails: document.querySelectorAll('.image-gallery-thumbnail').length,
    slides: document.querySelectorAll('.image-gallery-slide').length,
    loading: document.querySelector('.image-viewer__loading')?.textContent,
    alert: document.querySelector('.ant-alert')?.textContent,
  }))
  assert.ok(galleryDebug.thumbnails > 0, `Image gallery did not populate: ${JSON.stringify({ galleryDebug, consoleErrors, pageErrors })}`)

  const thumbnailCount = await page.$$eval('.image-gallery-thumbnail', (items) => items.length)
  assert.equal(thumbnailCount, nativeAliases.length + 4, `Unexpected gallery entries: ${await page.$$eval('.image-gallery-thumbnail img', (images) => images.map((image) => image.alt || image.title).join(', '))}`)
  await page.$eval('[title="Scroll wheel to switch images"]', (button) => button.click())
  const visitedIndexes = new Set()
  for (let step = 0; step < thumbnailCount; step += 1) {
    try {
      await page.waitForFunction(() => {
        const image = document.querySelector('.image-gallery-slide.image-gallery-center .image-gallery-image')
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
      }, { timeout: 10_000 })
      const currentIndex = await page.$$eval('.image-gallery-thumbnail', (items) => items.findIndex((item) => item.classList.contains('active')))
      assert.ok(currentIndex >= 0, 'The original gallery did not expose its active image')
      visitedIndexes.add(currentIndex)
      if (step + 1 < thumbnailCount) {
        await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })))
        await page.waitForFunction((previous) => {
          return [...document.querySelectorAll('.image-gallery-thumbnail')].findIndex((item) => item.classList.contains('active')) !== previous
        }, { timeout: 10_000 }, currentIndex)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100))
      }
    } catch (reason) {
      const state = await page.evaluate(() => {
        const active = [...document.querySelectorAll('.image-gallery-thumbnail')].findIndex((item) => item.classList.contains('active'))
        const image = document.querySelector('.image-gallery-slide.image-gallery-center .image-gallery-image')
        return {
          active,
          alt: image instanceof HTMLImageElement ? image.alt : undefined,
          complete: image instanceof HTMLImageElement ? image.complete : undefined,
          naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : undefined,
        }
      })
      assert.fail(`Gallery image step ${step} failed: ${JSON.stringify({ state, consoleErrors, pageErrors, reason: String(reason) })}`)
    }
  }
  assert.equal(visitedIndexes.size, thumbnailCount, 'The original gallery did not navigate through every image item')
  assert.deepEqual(consoleErrors, [], `Renderer console errors:\n${consoleErrors.join('\n')}`)
  assert.deepEqual(pageErrors, [], `Renderer page errors:\n${pageErrors.join('\n')}`)
})

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
  return address.port
}

async function connectToElectron(port, child, output) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early.\n${output.join('')}`)
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` })
    } catch (error) {
      lastError = error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  throw new Error(`Timed out connecting to Electron: ${lastError}\n${output.join('')}`)
}

async function waitForApplicationPage(browser) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const page = (await browser.pages()).find((candidate) => candidate.url().includes('index.desktop.html'))
    if (page) return page
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Timed out waiting for the Office Viewer renderer page.')
}

function collectProcessOutput(child, output) {
  child.stdout?.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr?.on('data', (chunk) => output.push(chunk.toString()))
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  let timeout
  try {
    return await Promise.race([
      once(child, 'exit').then(([code, signal]) => ({ code, signal })),
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error('Timed out waiting for Electron process exit.')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill()
  try {
    await waitForExit(child, 5_000)
  } catch {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      await once(killer, 'exit').catch(() => undefined)
    }
  }
}
