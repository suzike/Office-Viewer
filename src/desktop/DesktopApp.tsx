import {
  Activity,
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type ErrorInfo,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { App as AntdApp, ConfigProvider, Input } from 'antd'
import type { DesktopFileSession } from '../../desktop/shared/desktop-api'
import { isDesktopTextFile } from '../../desktop/shared/text-language-routing'
import { requestOpenFiles, subscribeToFileChanges, subscribeToOpenFiles } from './desktopApi'
import { AiAssistantController } from './assistant'
import { $t } from '../react/i18n/i18nConfig'
import { getDesktopAntThemeConfig } from '../react/antThemeConfig'
import {
  AppMark,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  MoonIcon,
  MoreIcon,
  ReloadIcon,
  SunIcon,
  WarningIcon,
} from './icons'

const DesktopDocumentViewer = lazy(() => import('../react/desktop/DesktopDocumentViewer'))
const DesktopGitHistoryWorkspace = lazy(() => import('../react/desktop/DesktopGitHistoryWorkspace'))

// Injected from package.json at build time (see vite.desktop.config.ts define).
declare const __OFFICE_DESKTOP_VERSION__: string

const desktopVersion = __OFFICE_DESKTOP_VERSION__

type Theme = 'light' | 'dark'
type MenuName = 'file' | 'view' | 'help'

const supportedHostExtensions = new Set([
  '7z', 'apk', 'crx', 'gz', 'jar', 'rar', 'tar', 'tgz', 'vsix', 'zip',
  'apng', 'bmp', 'cur', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'pjp', 'pjpeg', 'png',
  'csv', 'ods', 'tsv', 'xls', 'xlsm', 'xlsx',
  'docx', 'dotx', 'epub', 'icns', 'otf', 'parquet', 'pptm', 'pptx', 'pdf', 'psd', 'svg',
  'htm', 'html', 'xhtml',
  'http', 'rest',
  'markdown', 'md',
  'class',
  'tif', 'tiff', 'ttf', 'webp', 'woff', 'woff2', 'xmind',
])

interface HostDocument {
  session: DesktopFileSession
  dirty: boolean
  revision: number
  forceText?: boolean
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** order
  return `${value >= 10 || order === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[order]}`
}

function formatDate(timestamp: number): string {
  if (!timestamp) return $t('desktop.time.unknown')
  return new Intl.DateTimeFormat(navigator.language, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(timestamp)
}

function detectTheme(): Theme {
  const stored = localStorage.getItem('office-desktop-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

class ViewerErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Document viewer failed', error, info)
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string; children: ReactNode }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return <StatePanel kind="error" title={$t('desktop.statePanel.cannotRender')} detail={this.state.error.message} />
    }
    return this.props.children
  }
}

function StatePanel({
  kind,
  title,
  detail,
  onRetry,
}: {
  kind: 'loading' | 'error' | 'unsupported'
  title: string
  detail: string
  onRetry?: () => void
}) {
  const eyebrow = kind === 'loading'
    ? $t('desktop.statePanel.processing')
    : kind === 'error'
      ? $t('desktop.statePanel.renderError')
      : $t('desktop.statePanel.unsupportedFormat')
  return (
    <section className={`state-panel state-panel--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="state-panel__index">{kind === 'loading' ? '···' : kind === 'error' ? '!' : '?'}</div>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{detail}</p>
        {onRetry && <button className="button button--quiet" type="button" onClick={onRetry}><ReloadIcon />{$t('desktop.statePanel.reload')}</button>}
      </div>
    </section>
  )
}

function ViewerSurface({
  document,
  active,
  onDirtyChange,
  onSessionReplaced,
}: {
  document: HostDocument
  active: boolean
  onDirtyChange: (documentId: string, dirty: boolean) => void
  onSessionReplaced: (documentId: string, session: DesktopFileSession) => void
}) {
  const documentId = document.session.id
  const handleDirtyChange = useCallback(
    (dirty: boolean) => onDirtyChange(documentId, dirty),
    [documentId, onDirtyChange],
  )
  const handleSessionReplaced = useCallback(
    (session: DesktopFileSession) => onSessionReplaced(documentId, session),
    [documentId, onSessionReplaced],
  )

  if (
    !supportedHostExtensions.has(document.session.extension.replace(/^\./, '').toLowerCase()) &&
    !isDesktopTextFile(document.session.name, document.session.extension)
  ) {
    return (
      <StatePanel
        kind="unsupported"
        title={$t('desktop.statePanel.unsupportedTitle', {
          extension: document.session.extension || $t('desktop.statePanel.unknownFormat'),
        })}
        detail={$t('desktop.statePanel.unsupportedDetail')}
      />
    )
  }
  return (
    <ViewerErrorBoundary resetKey={`${document.session.id}:${document.revision}`}>
      <Suspense fallback={<StatePanel kind="loading" title={$t('desktop.statePanel.loadingTitle')} detail={$t('desktop.statePanel.loadingDetail')} />}>
        <DesktopDocumentViewer
          key={`${document.session.id}:${document.revision}`}
          session={document.session}
          forceText={document.forceText}
          active={active}
          onDirtyChange={handleDirtyChange}
          onSessionReplaced={handleSessionReplaced}
        />
      </Suspense>
    </ViewerErrorBoundary>
  )
}

export function DesktopApp() {
  const [theme, setTheme] = useState<Theme>(detectTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('office-desktop-theme', theme)
  }, [theme])

  useEffect(() => {
    if (window.officeDesktop.windowMaterial) {
      document.documentElement.dataset.material = window.officeDesktop.windowMaterial
    }
  }, [])

  return (
    <ConfigProvider theme={getDesktopAntThemeConfig(theme === 'dark')}>
      <AntdApp>
        <DesktopAppShell theme={theme} setTheme={setTheme} />
      </AntdApp>
    </ConfigProvider>
  )
}

function DesktopAppShell({
  theme,
  setTheme,
}: {
  theme: Theme
  setTheme: Dispatch<SetStateAction<Theme>>
}) {
  const { message, modal } = AntdApp.useApp()
  const [documents, setDocuments] = useState<HostDocument[]>([])
  const [recentSessions, setRecentSessions] = useState<DesktopFileSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [activeMenu, setActiveMenu] = useState<MenuName | null>(null)
  const [gitHistoryOpen, setGitHistoryOpen] = useState(false)
  const [showQuickSync, setShowQuickSync] = useState(() => localStorage.getItem('office-desktop-git-quick-sync') === 'true')
  const dragDepth = useRef(0)
  const documentsRef = useRef<HostDocument[]>([])

  const activeDocument = useMemo(
    () => documents.find((document) => document.session.id === activeId) ?? null,
    [activeId, documents],
  )

  const keepAliveDocumentIds = useMemo(() => {
    const retained = new Set<string>()
    if (activeId) retained.add(activeId)
    // Parsed clean documents live in the bounded Word/Excel/PPT caches. Only
    // dirty editors are pinned as live Activity trees: several simultaneous
    // third-party Office DOM instances share global listeners and can otherwise
    // deactivate the newly selected editor when an older Activity is hidden.
    for (const document of documents) {
      if (document.dirty) retained.add(document.session.id)
    }
    return retained
  }, [activeId, documents])

  const addHostSessions = useCallback((sessions: readonly DesktopFileSession[]) => {
    if (!sessions.length) return
    setDocuments((current) => {
      const byId = new Map(current.map((document) => [document.session.id, document]))
      for (const session of sessions) {
        const previous = byId.get(session.id)
        byId.set(session.id, previous ? { ...previous, session } : {
          session, dirty: false, revision: 0,
        })
      }
      return Array.from(byId.values())
    })
    setRecentSessions((current) => {
      const incomingIds = new Set(sessions.map((session) => session.id))
      return [...sessions, ...current.filter((session) => !incomingIds.has(session.id))].slice(0, 8)
    })
    setActiveId(sessions[sessions.length - 1].id)
    setGitHistoryOpen(false)
    setOpenError(null)
  }, [])

  const openFiles = useCallback(async () => {
    setOpening(true)
    setActiveMenu(null)
    try {
      addHostSessions(await requestOpenFiles())
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOpening(false)
    }
  }, [addHostSessions])

  const closeDocument = useCallback((id: string) => {
    const index = documents.findIndex((document) => document.session.id === id)
    const target = documents[index]
    if (!target) return

    const performClose = () => {
      // Read the freshest documents: the confirm dialog is async and the list
      // (or other tabs' state) may have changed while it was open.
      const current = documentsRef.current
      const freshIndex = current.findIndex((document) => document.session.id === id)
      if (freshIndex === -1) return
      const next = current.filter((document) => document.session.id !== id)
      setDocuments(next)
      setActiveId((previous) => previous === id
        ? next[Math.min(freshIndex, next.length - 1)]?.session.id ?? null
        : previous)
      void window.officeDesktop.closeFile(id).catch((reason: unknown) => {
        setOpenError(reason instanceof Error ? reason.message : String(reason))
      })
    }

    if (!target.dirty) {
      performClose()
      return
    }
    modal.confirm({
      content: $t('desktop.confirm.closeDirty', { name: target.session.name }),
      okText: $t('common.confirm'),
      cancelText: $t('common.cancel'),
      onOk: performClose,
    })
  }, [activeId, documents, modal])

  useEffect(() => subscribeToOpenFiles((event) => addHostSessions(event.files)), [addHostSessions])

  // Close the app menu when clicking anywhere outside of it (Escape already handled).
  useEffect(() => {
    if (!activeMenu) return
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.menu-wrap')) setActiveMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [activeMenu])

  useEffect(() => {
    documentsRef.current = documents
  }, [documents])

  useEffect(() => subscribeToFileChanges((sessionId, lastModified, byteLength) => {
    const changedDocument = documentsRef.current.find((document) => document.session.id === sessionId)
    if (!changedDocument) return

    const applyChange = (reload: boolean) => {
      setDocuments((current) => current.map((document) => {
        if (document.session.id !== sessionId) return document

        const session = { ...document.session, lastModified, byteLength }
        if (!reload) {
          return { ...document, session }
        }

        return { ...document, session, dirty: false, revision: document.revision + 1 }
      }))
    }

    if (!changedDocument.dirty) {
      applyChange(true)
      return
    }
    modal.confirm({
      content: $t('desktop.confirm.reloadModified', { name: changedDocument.session.name }),
      okText: $t('common.confirm'),
      cancelText: $t('common.cancel'),
      onOk: () => applyChange(true),
      onCancel: () => applyChange(false),
    })
  }), [modal])

  useEffect(() => {
    window.officeDesktop.setDirtyState(documents.some((document) => document.dirty))
  }, [documents])

  const handleDocumentDirtyChange = useCallback((documentId: string, dirty: boolean) => {
    setDocuments((current) => current.map((document) => document.session.id === documentId
      ? { ...document, dirty }
      : document))
  }, [])

  const handleDocumentSessionReplaced = useCallback((documentId: string, session: DesktopFileSession) => {
    setDocuments((current) => {
      const replaced = current.map((document) => document.session.id === documentId
        ? { ...document, session, dirty: false }
        : document)
      const seen = new Set<string>()
      return replaced.filter((document) => {
        if (seen.has(document.session.id)) return false
        seen.add(document.session.id)
        return true
      })
    })
    setActiveId((current) => current === documentId ? session.id : current)
  }, [])

  const toggleActiveCsvMode = useCallback(() => {
    if (!activeId) return
    const target = documentsRef.current.find((document) => document.session.id === activeId)
    if (!target || !['csv', 'tsv'].includes(target.session.extension.replace(/^\./, '').toLowerCase())) return

    const performToggle = () => {
      setDocuments((current) => current.map((document) => document.session.id === activeId
        ? { ...document, dirty: false, forceText: !document.forceText, revision: document.revision + 1 }
        : document))
    }

    if (!target.dirty) {
      performToggle()
      return
    }
    modal.confirm({
      content: $t('desktop.confirm.switchCsvEditor', { name: target.session.name }),
      okText: $t('common.confirm'),
      cancelText: $t('common.cancel'),
      onOk: performToggle,
    })
  }, [activeId, modal])

  useEffect(() => {
    const update = (event: Event) => setShowQuickSync(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener('office-desktop-git-quick-sync', update)
    return () => window.removeEventListener('office-desktop-git-quick-sync', update)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openFiles()
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'w' && activeId) {
        event.preventDefault()
        closeDocument(activeId)
      }
      if (event.key === 'Escape') setActiveMenu(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeId, closeDocument, openFiles])

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (!files.length) return
    setOpening(true)
    try {
      const result = await window.officeDesktop.openDroppedFiles(files)
      if (!result.canceled) addHostSessions(result.files)
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOpening(false)
    }
  }

  const runQuickSync = async (commitMessage: string) => {
    try {
      const response = await window.officeDesktop.gitHistoryRequest('quickSyncCommand', { commitMessage })
      const result = response.events.find((event) => event.type === 'quickSyncCommand')?.content as {
        error?: string | null
        cancelled?: boolean
        branch?: string
        remote?: string | null
      } | undefined
      if (result?.error) throw new Error(result.error)
      if (!result?.cancelled) {
        const target = `${result?.branch ?? ''}${result?.remote ? ` → ${result.remote}` : $t('desktop.quickSync.localOnly')}`
        message.success($t('desktop.quickSync.done', { target }))
      }
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const quickSync = () => {
    let commitMessage = $t('desktop.quickSync.defaultMessage')
    modal.confirm({
      title: $t('desktop.quickSync.promptTitle'),
      content: (
        <Input
          defaultValue={commitMessage}
          onChange={(event) => { commitMessage = event.target.value }}
        />
      ),
      okText: $t('common.confirm'),
      cancelText: $t('common.cancel'),
      onOk: () => runQuickSync(commitMessage),
    })
  }

  return (
    <div
      className={`desktop-shell${dragging ? ' is-dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); if (!event.dataTransfer.types.includes('Files')) return; dragDepth.current += 1; setDragging(true) }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDragLeave={(event) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) setDragging(false) }}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="title-row">
          <div className="window-controls" aria-label={$t('desktop.aria.appMenu')}>
            <button
              className="window-control window-control--close"
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => void window.officeDesktop.windowClose()}
            ><svg viewBox="0 0 12 12" aria-hidden><path d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8" /></svg></button>
            <button
              className="window-control window-control--minimize"
              type="button"
              aria-label="Minimize"
              title="Minimize"
              onClick={() => void window.officeDesktop.windowMinimize()}
            ><svg viewBox="0 0 12 12" aria-hidden><path d="M2.5 6h7" /></svg></button>
            <button
              className="window-control window-control--maximize"
              type="button"
              aria-label="Maximize"
              title="Maximize"
              onClick={() => void window.officeDesktop.windowToggleMaximize()}
            ><svg viewBox="0 0 12 12" aria-hidden><path d="M3.5 3.5h5v5h-5z" /></svg></button>
          </div>
          <div className="brand" aria-label="Office Viewer">
            <AppMark className="brand__mark" />
            <span className="brand__name">OFFICE VIEWER</span>
            <span className="brand__edition">DESKTOP</span>
          </div>
          <nav className="menu-row" aria-label={$t('desktop.aria.appMenu')}>
            <div className="menus">
              {(['file', 'view', 'help'] as MenuName[]).map((menu) => (
                <div className="menu-wrap" key={menu}>
                  <button
                    className={`menu-button${activeMenu === menu ? ' is-active' : ''}`}
                    type="button"
                    aria-expanded={activeMenu === menu}
                    onClick={() => setActiveMenu((current) => current === menu ? null : menu)}
                  >{$t(`desktop.menus.${menu}`)}</button>
                  {activeMenu === menu && (
                    <div className="menu-popover" role="menu">
                      {menu === 'file' ? <>
                        <button role="menuitem" onClick={() => void openFiles()}><span>{$t('desktop.menu.openDocument')}</span><kbd>Ctrl O</kbd></button>
                        <button role="menuitem" disabled={!activeDocument} onClick={() => { setActiveMenu(null); if (activeDocument) closeDocument(activeDocument.session.id) }}><span>{$t('desktop.menu.closeDocument')}</span><kbd>Ctrl W</kbd></button>
                        <button role="menuitem" onClick={() => window.close()}><span>{$t('desktop.menu.exit')}</span><kbd>Alt F4</kbd></button>
                      </> : menu === 'view' ? <>
                        <button role="menuitem" onClick={() => { setTheme(theme === 'light' ? 'dark' : 'light'); setActiveMenu(null) }}><span>{$t('desktop.menu.toggleTheme')}</span><span>{$t(theme === 'light' ? 'desktop.menu.dark' : 'desktop.menu.light')}</span></button>
                        <button role="menuitem" disabled={!activeDocument || !['csv', 'tsv'].includes(activeDocument.session.extension.replace(/^\./, '').toLowerCase())} onClick={() => { toggleActiveCsvMode(); setActiveMenu(null) }}><span>{$t('desktop.menu.toggleCsvEditor')}</span><span>{$t(activeDocument?.forceText ? 'desktop.menu.table' : 'desktop.menu.text')}</span></button>
                      </> : <>
                        <button role="menuitem" onClick={() => { void window.officeDesktop.openExternal('https://github.com/suzike/Office-Viewer'); setActiveMenu(null) }}><span>{$t('desktop.menu.projectHome')}</span><span>GitHub</span></button>
                        <button role="menuitem" onClick={() => {
                          modal.info({ title: 'Office Viewer Desktop', content: $t('desktop.about.builtOn', { version: desktopVersion }), okText: $t('common.confirm') })
                          setActiveMenu(null)
                        }}><span>{$t('desktop.menu.about')}</span><span>{desktopVersion}</span></button>
                      </>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </nav>
          <div className="title-row__document" title={gitHistoryOpen ? 'Git History' : activeDocument?.session.path}>
            {gitHistoryOpen ? 'Git History' : activeDocument?.session.name ?? $t('desktop.workspace.documentWorkspace')}
          </div>
          <div className="menu-row__status">
            <button
              className={`git-history-entry${gitHistoryOpen ? ' is-active' : ''}`}
              type="button"
              onClick={() => { setGitHistoryOpen((open) => !open); setActiveMenu(null) }}
              aria-pressed={gitHistoryOpen}
              title={$t('desktop.workspace.openGitHistory')}
            >
              <span className="codicon codicon-git-commit" aria-hidden /> Git History
            </button>
            {gitHistoryOpen && showQuickSync && (
              <button className="git-history-entry" type="button" onClick={quickSync} title="Quick Sync">
                <span className="codicon codicon-sync" aria-hidden /> Quick Sync
              </button>
            )}
            <span className="workspace-state"><span className="status-dot" /> {$t('desktop.workspace.localWorkspace')}</span>
          </div>
          <button
            className="icon-button theme-toggle"
            type="button"
            onClick={() => setTheme((value) => value === 'light' ? 'dark' : 'light')}
            aria-label={$t(theme === 'light' ? 'desktop.theme.switchToDark' : 'desktop.theme.switchToLight')}
            title={$t(theme === 'light' ? 'desktop.theme.dark' : 'desktop.theme.light')}
          >
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
          </button>
        </div>
      </header>

      {documents.length > 0 && (
        <div className="tab-strip" role="tablist" aria-label={$t('desktop.aria.openDocuments')}>
          {documents.map((document) => (
            <div
              className={`document-tab${document.session.id === activeId ? ' is-active' : ''}`}
              role="tab"
              tabIndex={document.session.id === activeId ? 0 : -1}
              aria-selected={document.session.id === activeId}
              key={document.session.id}
              onClick={() => { setGitHistoryOpen(false); setActiveId(document.session.id) }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setGitHistoryOpen(false); setActiveId(document.session.id) } }}
            >
              <span className={`file-token file-token--${document.session.extension || 'file'}`}>{document.session.extension?.slice(0, 3).toUpperCase() || 'FILE'}</span>
              <span className="document-tab__name">{document.session.name}</span>
              {document.dirty && <span className="dirty-dot" aria-label={$t('desktop.aria.unsaved')} />}
              <button
                className="document-tab__close"
                type="button"
                aria-label={$t('desktop.aria.closeDocument', { name: document.session.name })}
                onClick={(event) => { event.stopPropagation(); closeDocument(document.session.id) }}
              ><CloseIcon /></button>
            </div>
          ))}
          <button className="tab-add" type="button" onClick={() => void openFiles()} aria-label={$t('desktop.aria.openMoreDocuments')}>＋</button>
        </div>
      )}

      <main className="workspace">
        {gitHistoryOpen ? (
          <section className="document-surface document-surface--git" aria-label="Git History">
            <Suspense fallback={<StatePanel kind="loading" title={$t('desktop.statePanel.gitLoadingTitle')} detail={$t('desktop.statePanel.gitLoadingDetail')} />}>
              <DesktopGitHistoryWorkspace currentFile={activeDocument?.session} />
            </Suspense>
          </section>
        ) : activeDocument ? (
          <>
            <div className="metadata-bar">
              <div className="metadata-primary">
                <FileIcon />
                <div><strong>{activeDocument.session.name}</strong><span>{activeDocument.session.path}</span></div>
              </div>
              <dl>
                <div><dt>{$t('desktop.metadata.format')}</dt><dd>{activeDocument.session.extension.toUpperCase() || $t('desktop.metadata.unknown')}</dd></div>
                <div><dt>{$t('desktop.metadata.size')}</dt><dd>{formatBytes(activeDocument.session.byteLength)}</dd></div>
                <div><dt>{$t('desktop.metadata.modified')}</dt><dd>{formatDate(activeDocument.session.lastModified)}</dd></div>
                <div><dt>{$t('desktop.metadata.permissions')}</dt><dd>{$t(activeDocument.session.readOnly ? 'desktop.metadata.readOnly' : 'desktop.metadata.editable')}</dd></div>
              </dl>
              <div className="metadata-actions">
                {['csv', 'tsv'].includes(activeDocument.session.extension.replace(/^\./, '').toLowerCase()) && (
                  <button className="metadata-mode-button" type="button" onClick={toggleActiveCsvMode} title={$t('desktop.metadata.toggleCsvEditor')}>
                    {$t(activeDocument.forceText ? 'desktop.metadata.tableView' : 'desktop.metadata.textView')}
                  </button>
                )}
                <button className="icon-button" type="button" onClick={() => void window.officeDesktop.showInFolder(activeDocument.session.id)} title={$t('desktop.metadata.showInFolder')} aria-label={$t('desktop.metadata.showInFolder')}><MoreIcon /></button>
              </div>
            </div>
            <section className="document-surface" aria-label={$t('desktop.aria.documentContent', { name: activeDocument.session.name })}>
              {documents.filter((document) => keepAliveDocumentIds.has(document.session.id)).map((document) => (
                <Activity
                  key={document.session.id}
                  mode={document.session.id === activeId ? 'visible' : 'hidden'}
                  name={`office-document-${document.session.id}`}
                >
                  <div
                    className="office-document-activity"
                    data-active={document.session.id === activeId ? 'true' : 'false'}
                    data-document-id={document.session.id}
                    style={{ width: '100%', height: '100%' }}
                  >
                    <ViewerSurface
                      document={document}
                      active={document.session.id === activeId}
                      onDirtyChange={handleDocumentDirtyChange}
                      onSessionReplaced={handleDocumentSessionReplaced}
                    />
                  </div>
                </Activity>
              ))}
            </section>
          </>
        ) : (
          <section className="welcome" aria-labelledby="welcome-title">
            <div className="welcome__intro">
              <p className="eyebrow">{$t('desktop.welcome.eyebrow')}</p>
              <h1 id="welcome-title">{$t('desktop.welcome.titleLead')}<br /><em>{$t('desktop.welcome.titleEmphasis')}</em></h1>
              <p className="welcome__copy">{$t('desktop.welcome.copy')}</p>
              <div className="welcome__actions">
                <button className="button button--primary" type="button" onClick={() => void openFiles()} disabled={opening}>
                  <FolderIcon />{$t(opening ? 'desktop.welcome.opening' : 'desktop.welcome.openDocument')}<span className="shortcut">Ctrl O</span>
                </button>
                <span>{$t('desktop.welcome.dropHint')}</span>
              </div>
              {openError && <div className="inline-error" role="alert"><WarningIcon /><span>{openError}</span><button onClick={() => setOpenError(null)} aria-label={$t('desktop.aria.closeError')}><CloseIcon /></button></div>}
            </div>
            <aside className="recent-panel" aria-labelledby="recent-title">
              <div className="section-heading"><div><p className="eyebrow">{$t('desktop.recent.eyebrow')}</p><h2 id="recent-title">{$t('desktop.recent.title')}</h2></div><ClockIcon /></div>
              {recentSessions.length ? (
                <div className="recent-list">
                  {recentSessions.slice(0, 5).map((session, index) => (
                    <button key={session.id} onClick={() => {
                      // Re-register by path so metadata and the file watcher are refreshed
                      // (closing a tab suspends the session and its watcher).
                      void window.officeDesktop.openPaths([session.path]).catch((reason: unknown) => {
                        setOpenError(reason instanceof Error ? reason.message : String(reason))
                      })
                    }}>
                      <span className="recent-list__index">{String(index + 1).padStart(2, '0')}</span>
                      <span className="recent-list__body"><strong>{session.name}</strong><small>{session.path}</small></span>
                      <ChevronIcon />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="recent-empty">
                  <div className="recent-empty__rule" />
                  <p>{$t('desktop.recent.empty')}</p>
                  <span>{$t('desktop.recent.emptyHint')}</span>
                </div>
              )}
              <div className="format-ledger"><span>DOCX</span><span>XLSX</span><span>PPTX</span><span>PDF</span><span>+ 24</span></div>
            </aside>
          </section>
        )}
      </main>

      {openError && documents.length > 0 && (
        <div className="inline-error inline-error--floating" role="alert"><WarningIcon /><span>{openError}</span><button onClick={() => setOpenError(null)} aria-label={$t('desktop.aria.closeError')}><CloseIcon /></button></div>
      )}

      <AiAssistantController session={gitHistoryOpen ? null : activeDocument?.session ?? null} />

      <footer className="status-bar">
        <span>OFFLINE</span>
        <span>{$t('desktop.status.documentsCount', { count: documents.length })}</span>
        <span className="status-bar__spacer" />
        <span>{window.officeDesktop?.platform?.toUpperCase() ?? 'DESKTOP'}</span>
        <span>UTF-8</span>
      </footer>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div><FolderIcon /><p>{$t('desktop.drop.title')}</p><span>{$t('desktop.drop.subtitle')}</span></div>
        </div>
      )}
    </div>
  )
}
