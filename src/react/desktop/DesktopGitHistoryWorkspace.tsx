import { Alert, Button, Empty, Spin } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import type {
  DesktopFileSession,
  DesktopGitHistoryInit,
  DesktopGitHistoryPreview,
} from '../../../desktop/shared/desktop-api'
import GitHistory from '../view/gitHistory/GitHistory'
import {
  dispatchHostMessage,
  installOfficeHostBridge,
  type OfficeHostBridge,
} from '../util/vscode'
import './DesktopGitHistoryWorkspace.css'

export default function DesktopGitHistoryWorkspace({ currentFile }: { currentFile?: DesktopFileSession }) {
  const [init, setInit] = useState<DesktopGitHistoryInit | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [preview, setPreview] = useState<DesktopGitHistoryPreview>()
  const [bridgeReady, setBridgeReady] = useState(false)

  const selectRepositories = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const selected = await window.officeDesktop.selectGitRepositories()
      if (selected) setInit(selected)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  const selectFileHistory = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const selected = await window.officeDesktop.selectGitFileHistory()
      if (selected) setInit(selected)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  const openCurrentFileHistory = useCallback(async () => {
    if (!currentFile) return
    setLoading(true)
    setError(undefined)
    try {
      setInit(await window.officeDesktop.openGitFileHistory(currentFile.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [currentFile])

  useEffect(() => {
    if (!init) {
      setBridgeReady(false)
      return
    }
    let disposed = false
    const bridge: OfficeHostBridge = {
      postMessage(message) {
        void window.officeDesktop.gitHistoryRequest(message.type, message.content)
          .then((response) => {
            if (disposed) return
            for (const event of response.events) dispatchHostMessage(event)
            if (response.preview) setPreview(response.preview)
          })
          .catch((reason: unknown) => {
            if (disposed) return
            dispatchHostMessage({
              type: 'error',
              content: reason instanceof Error ? reason.message : String(reason),
            })
          })
      },
    }
    const uninstall = installOfficeHostBridge(bridge)
    setBridgeReady(true)
    return () => {
      disposed = true
      setBridgeReady(false)
      uninstall()
    }
  }, [init])

  useEffect(() => {
    if (!init) return
    return window.officeDesktop.onGitHistoryChanged((event) => {
      dispatchHostMessage({ type: 'refresh', content: { repos: [...event.repos] } })
    })
  }, [init])

  if (!init) {
    return (
      <div className="desktop-git-launcher">
        <div className="desktop-git-launcher__card">
          <span className="codicon codicon-git-commit desktop-git-launcher__icon" aria-hidden />
          <h2>Git History</h2>
          <p>选择一个 Git 仓库或工作区文件夹，打开原版提交图、筛选器、提交详情和 Git 操作界面。</p>
          <div className="desktop-git-launcher__actions">
            <Button type="primary" size="large" loading={loading} onClick={() => void selectRepositories()}>
              选择 Git 仓库
            </Button>
            <Button size="large" disabled={loading} onClick={() => void selectFileHistory()}>
              查看文件历史
            </Button>
            {currentFile && (
              <Button size="large" disabled={loading} onClick={() => void openCurrentFileHistory()}>
                当前文件历史：{currentFile.name}
              </Button>
            )}
          </div>
          {error && <Alert type="error" showIcon message={error} />}
        </div>
      </div>
    )
  }

  return (
    <div className="desktop-git-workspace">
      {bridgeReady
        ? <GitHistory desktopInit={{ ...init, repos: [...init.repos] }} />
        : <Spin fullscreen />}
      {loading && <Spin fullscreen />}
      {preview && (
        <div className="desktop-git-preview" role="dialog" aria-modal="true" aria-label={preview.title}>
          <div className="desktop-git-preview__header">
            <div><span className="codicon codicon-diff" aria-hidden /><strong>{preview.title}</strong></div>
            <button type="button" onClick={() => setPreview(undefined)} aria-label="关闭预览"><span className="codicon codicon-close" /></button>
          </div>
          <div className={`desktop-git-preview__content${preview.left ? ' is-diff' : ''}`}>
            {preview.left && <CodePane label={preview.left.label} content={preview.left.content} />}
            <CodePane label={preview.right.label} content={preview.right.content} />
          </div>
        </div>
      )}
    </div>
  )
}

function CodePane({ label, content }: { label: string; content: string }) {
  return (
    <section className="desktop-git-preview__pane">
      <header>{label}</header>
      {content.length ? <pre><code>{content}</code></pre> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此侧没有内容" />}
    </section>
  )
}
