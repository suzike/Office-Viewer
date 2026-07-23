export type DesktopPlatform = 'win32' | 'darwin' | 'linux'

export type DesktopOpenReason =
  | 'startup'
  | 'dialog'
  | 'drop'
  | 'second-instance'
  | 'open-file'
  | 'reopen'

export interface DesktopFileSession {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly extension: string
  readonly byteLength: number
  readonly lastModified: number
  readonly readOnly: boolean
}

export interface DesktopFilesOpenedEvent {
  readonly reason: DesktopOpenReason
  readonly files: readonly DesktopFileSession[]
}

export interface DesktopFileChangedEvent {
  readonly sessionId: string
  readonly lastModified: number
  readonly byteLength: number
}

export interface DesktopOpenDialogResult {
  readonly canceled: boolean
  readonly files: readonly DesktopFileSession[]
}

export interface DesktopWriteResult {
  readonly session: DesktopFileSession
  readonly bytesWritten: number
}

export interface DesktopImageItem {
  readonly session: DesktopFileSession
  readonly mime: string
}

export interface DesktopImageCollection {
  readonly images: readonly DesktopImageItem[]
  readonly current: number
}

export interface DesktopArchiveEntry {
  readonly name?: string
  readonly isDirectory?: boolean
  readonly entryName?: string
  readonly children?: readonly DesktopArchiveEntry[]
  readonly fileSize?: string
  readonly fileSizeOrigin?: number
  readonly compressedSize?: string
  readonly compressedSizeOrigin?: number
  readonly modifyDateTime?: string | null
  readonly encrypted?: boolean
}

export interface DesktopArchiveInfo {
  readonly fileName: string
  readonly files: readonly DesktopArchiveEntry[]
  readonly folderMap: Readonly<Record<string, DesktopArchiveEntry>>
  readonly encrypted: boolean
  readonly encoding: string
  readonly extension: string
  readonly size: string
  readonly jarInfo?: {
    readonly mainClass?: string
    readonly javaMinVersion?: string
  }
}

export interface DesktopArchiveExtractResult {
  readonly targetPath: string
  readonly fileCount: number
}

export interface DesktopJavaDecompileResult {
  readonly fileName: string
  readonly source: string
}

export interface DesktopGitHistoryInit {
  readonly repos: readonly string[]
  readonly initialRepo: string | null
  readonly preferredRepo: string | null
  readonly filePath: string | null
  readonly fileName: string | null
  readonly relPath: string | null
  readonly fileHistorySplitLayout: 'vertical' | 'horizontal'
}

export interface DesktopGitHistoryEvent {
  readonly type: string
  readonly content?: unknown
}

export interface DesktopGitHistoryPreview {
  readonly title: string
  readonly fileName: string
  readonly left?: { readonly label: string; readonly content: string }
  readonly right: { readonly label: string; readonly content: string }
}

export interface DesktopGitHistoryResponse {
  readonly events: readonly DesktopGitHistoryEvent[]
  readonly preview?: DesktopGitHistoryPreview
}

export interface DesktopGitHistoryChangedEvent {
  readonly repos: readonly string[]
}

export type DesktopHttpPreviewOption = 'full' | 'headers' | 'body' | 'exchange'

export interface DesktopHttpRequestOptions {
  readonly environment?: Readonly<Record<string, string>>
  readonly followRedirect?: boolean
  readonly timeoutMs?: number
  readonly allowPrivateNetwork?: boolean
  readonly decodeEscapedUnicodeCharacters?: boolean
  readonly formParamEncodingStrategy?: 'automatic' | 'never' | 'always'
  readonly previewOption?: DesktopHttpPreviewOption
}

export interface DesktopHttpSettings {
  readonly followRedirect: boolean
  readonly environmentSource: string
  readonly previewOption: DesktopHttpPreviewOption
  readonly previewColumn: 'current' | 'beside'
  readonly formParamEncodingStrategy: 'automatic' | 'never' | 'always'
  readonly addRequestBodyLineIndentationAroundBrackets: boolean
  readonly decodeEscapedUnicodeCharacters: boolean
  readonly logLevel: 'error' | 'warn' | 'info' | 'verbose'
  readonly enableCustomVariableReferencesCodeLens: boolean
  readonly timeoutSeconds: number
  readonly allowPrivateNetwork: boolean
  readonly activeEnvironment: string
}

export interface DesktopHttpExchangeRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly name?: string
}

export interface DesktopHttpResponse {
  readonly requestId: string
  readonly request: DesktopHttpExchangeRequest
  readonly finalUrl: string
  readonly statusCode: number
  readonly statusMessage: string
  readonly httpVersion: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly bodyBytes: Uint8Array
  readonly contentType?: string
  readonly elapsedMs: number
  readonly redirectCount: number
  readonly preview: string
}

export interface DesktopMarkdownViewerSettings {
  readonly globalSettings: Readonly<Record<string, unknown>>
  readonly aiPreferences?: Readonly<Record<string, string>>
}

export interface DesktopMarkdownPreferences {
  readonly editMode: 'wysiwyg' | 'ir'
  readonly editorTheme: string
  readonly codeMirrorTheme: string
  readonly mermaidTheme: string
  readonly workspacePathAsImageBasePath: boolean
  readonly pasterImgPath: string
  readonly pdfMarginTop: number
  readonly viewerSettings: {
    readonly enabled: boolean
    readonly settings?: DesktopMarkdownViewerSettings
  }
}

export interface DesktopMarkdownPreferencePatch {
  readonly editMode?: 'wysiwyg' | 'ir'
  readonly editorTheme?: string
  readonly codeMirrorTheme?: string
  readonly mermaidTheme?: string
  readonly workspacePathAsImageBasePath?: boolean
  readonly pasterImgPath?: string
  readonly pdfMarginTop?: number
}

export interface DesktopMarkdownImageResult {
  readonly markdown: string
  readonly relativePath: string
}

export interface DesktopMarkdownExportResult {
  readonly type: 'pdf' | 'html' | 'docx'
  readonly path: string
}

export interface DesktopMarkdownImageExportResult {
  readonly path: string
}

export interface DesktopMarkdownTextExportResult {
  readonly path: string
}

export interface DesktopMarkdownDeadLink {
  readonly kind: 'link' | 'image'
  readonly target: string
  readonly line: number
}

export interface DesktopMarkdownTemplate {
  readonly id: string
  readonly name: string
  readonly content: string
}

export interface DesktopHtmlExportResult {
  readonly type: 'pdf' | 'png'
  readonly path: string
}

export interface DesktopMarkdownAiOptions {
  readonly engine?: 'custom' | 'vscode'
  readonly task?: 'polish' | 'toc' | 'summary'
  readonly goal?: string
  readonly prompt?: string
  readonly outputLanguage?: string
  readonly uiLanguage?: string
  readonly customUrl?: string
  readonly customKey?: string
  readonly customModel?: string
  readonly customApiFormat?: 'auto' | 'openai' | 'anthropic' | 'gemini' | 'ollama'
}

export interface DesktopMarkdownAiEvent {
  readonly sessionId: string
  readonly requestId: string
  readonly type: 'chunk' | 'end' | 'error'
  readonly content?: string
}

export type DesktopAiProviderKind =
  | 'codex-cli'
  | 'claude-cli'
  | 'openai-compatible'
  | 'anthropic'
  | 'gemini'
  | 'ollama'

export interface DesktopAiProvider {
  readonly id: string
  readonly name: string
  readonly kind: DesktopAiProviderKind
  readonly enabled: boolean
  readonly model?: string
  readonly baseUrl?: string
  readonly executable?: string
  readonly allowPrivateNetwork?: boolean
  readonly hasApiKey: boolean
  readonly builtIn?: boolean
}

export interface DesktopAiProviderInput {
  readonly id: string
  readonly name: string
  readonly kind: DesktopAiProviderKind
  readonly enabled?: boolean
  readonly model?: string
  readonly baseUrl?: string
  readonly executable?: string
  readonly allowPrivateNetwork?: boolean
  readonly apiKey?: string
  readonly removeApiKey?: boolean
}

/** Custom quick action managed from the assistant settings dialog. */
export interface DesktopAiCustomAction {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly prompt: string
  readonly requiresSelection?: boolean
}

/** Saved prompt snippet shown in the composer prompt library. */
export interface DesktopAiPromptSnippet {
  readonly id: string
  readonly title: string
  readonly content: string
}

/** Persona injected ahead of every document prompt. */
export interface DesktopAiPromptProfile {
  readonly persona?: string
  readonly outputLanguage?: string
  readonly style?: string
}

/** Optional sampling parameters applied to HTTP providers (CLI providers ignore them). */
export interface DesktopAiModelParameters {
  readonly temperature?: number
  readonly maxTokens?: number
}

export interface DesktopAiAssistantSettings {
  readonly activeProviderId: string
  readonly providers: readonly DesktopAiProvider[]
  readonly contextCharacterLimit: number
  readonly customActions: readonly DesktopAiCustomAction[]
  readonly promptLibrary: readonly DesktopAiPromptSnippet[]
  readonly promptProfile: DesktopAiPromptProfile
  readonly globalShortcutEnabled: boolean
  readonly modelParameters: DesktopAiModelParameters
}

export interface DesktopAiAssistantSettingsInput {
  readonly activeProviderId: string
  readonly providers: readonly DesktopAiProviderInput[]
  readonly contextCharacterLimit?: number
  readonly customActions?: readonly DesktopAiCustomAction[]
  readonly promptLibrary?: readonly DesktopAiPromptSnippet[]
  readonly promptProfile?: DesktopAiPromptProfile
  readonly globalShortcutEnabled?: boolean
  readonly modelParameters?: DesktopAiModelParameters
}

export interface DesktopAiProviderStatus {
  readonly providerId: string
  readonly available: boolean
  readonly detail: string
  readonly version?: string
  /** Measured HTTP round-trip when the provider was probed over the network. */
  readonly latencyMs?: number
  /** Model identifiers reported by the provider during a network probe. */
  readonly models?: readonly string[]
}

export interface DesktopAiDocumentContext {
  readonly sessionId: string
  readonly fileName: string
  readonly filePath: string
  readonly format: string
  readonly text: string
  readonly extractedCharacters: number
  readonly sourceCharacters: number
  readonly truncated: boolean
  readonly strategy: 'text' | 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'metadata'
  readonly warning?: string
}

export interface DesktopAiAssistantMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface DesktopAiAssistantRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly providerId: string
  readonly messages: readonly DesktopAiAssistantMessage[]
}

export interface DesktopAiAssistantEvent {
  readonly requestId: string
  readonly sessionId: string
  readonly type: 'start' | 'context' | 'chunk' | 'end' | 'error'
  readonly content?: string
  readonly context?: DesktopAiDocumentContext
}

export interface DesktopApi {
  readonly platform: DesktopPlatform
  /** OS window material in use (e.g. 'mica' on Windows 11); the renderer makes the shell transparent when set. */
  readonly windowMaterial?: string

  openFiles(): Promise<DesktopOpenDialogResult>
  openDroppedFiles(files: readonly File[]): Promise<DesktopOpenDialogResult>
  /** Re-registers known absolute paths (e.g. reopening recent files) so metadata and watchers are refreshed. */
  openPaths(paths: readonly string[]): Promise<DesktopOpenDialogResult>
  readFile(sessionId: string): Promise<ArrayBuffer>
  saveFile(
    sessionId: string,
    data: ArrayBuffer | Uint8Array,
  ): Promise<DesktopWriteResult>
  saveFileAs(
    sessionId: string | null,
    data: ArrayBuffer | Uint8Array,
    suggestedName?: string,
  ): Promise<DesktopWriteResult | null>
  closeFile(sessionId: string): Promise<void>
  openMarkdownLink(sessionId: string, link: string): Promise<DesktopFileSession | null>
  listSiblingImages(sessionId: string): Promise<DesktopImageCollection>
  inspectArchive(sessionId: string, encoding?: string): Promise<DesktopArchiveInfo>
  openArchiveEntry(sessionId: string, entryName: string, password?: string): Promise<void>
  extractArchive(sessionId: string, password?: string): Promise<DesktopArchiveExtractResult | null>
  addArchiveFile(sessionId: string, currentDir?: string, encoding?: string): Promise<DesktopWriteResult | null>
  removeArchiveEntry(sessionId: string, entryName: string, encoding?: string): Promise<DesktopWriteResult>
  decompileClass(sessionId: string): Promise<DesktopJavaDecompileResult>
  selectGitRepositories(): Promise<DesktopGitHistoryInit | null>
  selectGitFileHistory(): Promise<DesktopGitHistoryInit | null>
  openGitFileHistory(sessionId: string): Promise<DesktopGitHistoryInit>
  gitHistoryRequest(type: string, content?: unknown): Promise<DesktopGitHistoryResponse>
  sendHttpRequest(
    sessionId: string,
    source: string,
    requestIndex: number,
    requestId: string,
    options?: DesktopHttpRequestOptions,
  ): Promise<DesktopHttpResponse>
  cancelHttpRequest(requestId: string): Promise<boolean>
  loadHttpSettings(): Promise<DesktopHttpSettings>
  saveHttpSettings(settings: DesktopHttpSettings): Promise<DesktopHttpSettings>
  loadMarkdownPreferences(): Promise<DesktopMarkdownPreferences>
  updateMarkdownPreferences(patch: DesktopMarkdownPreferencePatch): Promise<DesktopMarkdownPreferences>
  saveMarkdownViewerSettings(settings: DesktopMarkdownViewerSettings): Promise<DesktopMarkdownPreferences>
  saveMarkdownImage(sessionId: string, data: ArrayBuffer | Uint8Array, extension?: string): Promise<DesktopMarkdownImageResult>
  pasteMarkdownImage(sessionId: string): Promise<DesktopMarkdownImageResult | null>
  selectMarkdownImage(sessionId: string): Promise<DesktopMarkdownImageResult | null>
  exportMarkdown(
    sessionId: string,
    markdown: string,
    option: { readonly type: 'pdf' | 'html' | 'docx'; readonly withoutOutline?: boolean },
  ): Promise<DesktopMarkdownExportResult>
  printMarkdown(sessionId: string, markdown: string): Promise<void>
  exportMarkdownImage(sessionId: string, markdown: string): Promise<DesktopMarkdownImageExportResult>
  exportMarkdownText(sessionId: string, markdown: string): Promise<DesktopMarkdownTextExportResult>
  /** Builds relative Markdown links for non-image files dropped into the editor. */
  markdownDropFileLinks(sessionId: string, files: readonly File[]): Promise<string>
  /** Lists relative link/image references whose target file does not exist. */
  scanMarkdownDeadLinks(sessionId: string, markdown: string): Promise<readonly DesktopMarkdownDeadLink[]>
  /** Built-in and user-provided Markdown templates for the insert-template panel. */
  loadMarkdownTemplates(): Promise<readonly DesktopMarkdownTemplate[]>
  exportHtmlPdf(sessionId: string): Promise<DesktopHtmlExportResult>
  exportHtmlImage(sessionId: string): Promise<DesktopHtmlExportResult>
  startMarkdownAiPolish(
    sessionId: string,
    requestId: string,
    markdown: string,
    options?: DesktopMarkdownAiOptions,
  ): Promise<void>
  cancelMarkdownAiPolish(requestId: string): Promise<boolean>
  loadAiAssistantSettings(): Promise<DesktopAiAssistantSettings>
  saveAiAssistantSettings(settings: DesktopAiAssistantSettingsInput): Promise<DesktopAiAssistantSettings>
  probeAiAssistantProviders(forceRefresh?: boolean): Promise<readonly DesktopAiProviderStatus[]>
  getAiDocumentContext(sessionId: string): Promise<DesktopAiDocumentContext>
  startAiAssistantRequest(request: DesktopAiAssistantRequest): Promise<void>
  cancelAiAssistantRequest(requestId: string): Promise<boolean>
  showInFolder(sessionId: string): Promise<void>
  openWithSystem(sessionId: string): Promise<void>
  openExternal(url: string): Promise<void>
  toggleDevTools(): Promise<boolean>
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<boolean>
  windowClose(): Promise<void>
  setDirtyState(dirty: boolean): void

  onFilesOpened(listener: (event: DesktopFilesOpenedEvent) => void): () => void
  onFileChanged(listener: (event: DesktopFileChangedEvent) => void): () => void
  onGitHistoryChanged(listener: (event: DesktopGitHistoryChangedEvent) => void): () => void
  onMarkdownAiEvent(listener: (event: DesktopMarkdownAiEvent) => void): () => void
  onAiAssistantEvent(listener: (event: DesktopAiAssistantEvent) => void): () => void
  /** Fired when the global assistant shortcut summons the window; the panel should open and focus. */
  onAiAssistantFocus(listener: () => void): () => void
}

declare global {
  interface Window {
    readonly officeDesktop: DesktopApi
  }
}
