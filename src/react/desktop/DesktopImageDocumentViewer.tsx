import { Alert, Spin } from 'antd'
import { lazy, Suspense, useLayoutEffect, useState } from 'react'
import type { DesktopFileSession } from '../../../desktop/shared/desktop-api'
import {
  dispatchHostMessage,
  installOfficeHostBridge,
  type OfficeHostBridge,
} from '../util/vscode'

const ImageViewer = lazy(() => import('../view/image/Image'))

export default function DesktopImageDocumentViewer({ session }: { session: DesktopFileSession }) {
  const [error, setError] = useState<string>()

  useLayoutEffect(() => {
    let disposed = false

    const loadImages = async () => {
      try {
        setError(undefined)
        const collection = await window.officeDesktop.listSiblingImages(session.id)
        const images = new Array(collection.images.length)
        let nextImageIndex = 0
        const readers = Array.from({ length: Math.min(4, collection.images.length) }, async () => {
          while (nextImageIndex < collection.images.length) {
            const index = nextImageIndex++
            const image = collection.images[index]
            const buffer = await window.officeDesktop.readFile(image.session.id)
            images[index] = {
            title: image.session.name,
            ext: image.session.extension,
            mime: image.mime,
            buffer,
            documentCacheKey: `desktop:${image.session.id}:${image.session.lastModified}:${image.session.byteLength}`,
            }
          }
        })
        await Promise.all(readers)
        if (disposed) return
        dispatchHostMessage({
          type: 'images',
          content: { images, current: collection.current },
        })
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }
    }

    const bridge: OfficeHostBridge = {
      postMessage(message) {
        switch (message.type) {
          case 'images':
            void loadImages()
            break
          case 'developerTool':
            void window.officeDesktop.toggleDevTools()
            break
          case 'slideTitle':
            // The desktop tab already exposes the selected file group; the original
            // gallery title remains visible inside the unmodified image viewer.
            break
        }
      },
    }

    const uninstall = installOfficeHostBridge(bridge)
    return () => {
      disposed = true
      uninstall()
    }
  }, [session.id])

  if (error) {
    return <Alert type="error" showIcon message="图像无法打开" description={error} />
  }

  return (
    <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
      <ImageViewer />
    </Suspense>
  )
}
