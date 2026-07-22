import type {
  DesktopFileSession,
  DesktopFilesOpenedEvent,
} from '../../desktop/shared/desktop-api'

export async function requestOpenFiles(): Promise<readonly DesktopFileSession[]> {
  const result = await window.officeDesktop.openFiles()
  return result.canceled ? [] : result.files
}

export function subscribeToOpenFiles(
  listener: (event: DesktopFilesOpenedEvent) => void,
): () => void {
  if (!window.officeDesktop) return () => undefined
  return window.officeDesktop.onFilesOpened(listener)
}

export function subscribeToFileChanges(
  listener: (sessionId: string, lastModified: number, byteLength: number) => void,
): () => void {
  if (!window.officeDesktop) return () => undefined
  return window.officeDesktop.onFileChanged((event) => {
    listener(event.sessionId, event.lastModified, event.byteLength)
  })
}
