import { Alert } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    DesktopFileSession,
    DesktopMarkdownAiOptions,
    DesktopMarkdownDeadLink,
    DesktopMarkdownPreferences,
    DesktopMarkdownViewerSettings,
} from '../../../desktop/shared/desktop-api';
import { publishAssistantSelection } from '../../desktop/assistant/selectionEvents';

interface Props {
    session: DesktopFileSession;
    onDirtyChange?: (dirty: boolean) => void;
    onSessionReplaced?: (session: DesktopFileSession) => void;
}

interface MarkdownFrameMessage {
    readonly __officeMarkdownViewer?: boolean;
    readonly message?: { type?: string; content?: unknown };
}

interface MarkdownPreferenceDraft {
    workspacePathAsImageBasePath: boolean;
    pasterImgPath: string;
    pdfMarginTop: string;
}

const MARKDOWN_ORIGIN = 'office-markdown://viewer';

function asText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export default function DesktopMarkdownDocumentViewer({
    session,
    onDirtyChange,
    onSessionReplaced,
}: Props) {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const sourceTextareaRef = useRef<HTMLTextAreaElement>(null);
    const latestTextRef = useRef('');
    const savedTextRef = useRef('');
    const sourceEntryTextRef = useRef('');
    const pendingProgrammaticDirtyRef = useRef<boolean>();
    const loadedSessionRef = useRef<string>();
    const preferencesRef = useRef<DesktopMarkdownPreferences>();
    const aiRequestRef = useRef<string>();
    const aiGenerateRef = useRef<{ kind: 'toc' | 'summary'; chunks: string[] }>();
    const [sourceText, setSourceText] = useState('');
    const [sourceMode, setSourceMode] = useState(false);
    const [error, setError] = useState<string>();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [deadLinks, setDeadLinks] = useState<readonly DesktopMarkdownDeadLink[]>();
    const [settingsSaving, setSettingsSaving] = useState(false);
    const [preferences, setPreferences] = useState<DesktopMarkdownPreferences>();
    const [settingsDraft, setSettingsDraft] = useState<MarkdownPreferenceDraft>({
        workspacePathAsImageBasePath: false,
        pasterImgPath: 'image/${fileName}/${now}.${ext}',
        pdfMarginTop: '25',
    });

    const postToEditor = useCallback((type: string, content?: unknown) => {
        frameRef.current?.contentWindow?.postMessage({ type, content }, MARKDOWN_ORIGIN);
    }, []);

    const markDirty = useCallback((text: string) => {
        latestTextRef.current = text;
        setSourceText(text);
        const pendingDirty = pendingProgrammaticDirtyRef.current;
        if (pendingDirty !== undefined) {
            pendingProgrammaticDirtyRef.current = undefined;
            if (!pendingDirty) savedTextRef.current = text;
            onDirtyChange?.(pendingDirty);
            return;
        }
        // Vditor may fire input events whose markdown is identical to the saved
        // content (e.g. clicking re-renders a block). Only real changes are dirty.
        onDirtyChange?.(text !== savedTextRef.current);
    }, [onDirtyChange]);

    const save = useCallback(async (text: string) => {
        try {
            const bytes = new TextEncoder().encode(text.replace(/\r\n/g, '\n'));
            const result = session.readOnly
                ? await window.officeDesktop.saveFileAs(session.id, bytes, session.name)
                : await window.officeDesktop.saveFile(session.id, bytes);
            if (!result) return;
            latestTextRef.current = text;
            savedTextRef.current = text;
            setSourceText(text);
            onDirtyChange?.(false);
            if (result.session.id !== session.id) onSessionReplaced?.(result.session);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }, [onDirtyChange, onSessionReplaced, session]);

    const openDesktopSettings = useCallback(() => {
        const current = preferencesRef.current;
        if (current) {
            setSettingsDraft({
                workspacePathAsImageBasePath: current.workspacePathAsImageBasePath,
                pasterImgPath: current.pasterImgPath,
                pdfMarginTop: String(current.pdfMarginTop),
            });
        }
        setSettingsOpen(true);
    }, []);

    const saveDesktopSettings = useCallback(async () => {
        const pdfMarginTop = Number(settingsDraft.pdfMarginTop);
        if (!Number.isInteger(pdfMarginTop) || pdfMarginTop < 0 || pdfMarginTop > 500) {
            setError('PDF 顶部边距必须是 0 到 500 之间的整数。');
            return;
        }
        if (!settingsDraft.pasterImgPath.trim()) {
            setError('粘贴图片路径不能为空。');
            return;
        }
        try {
            setSettingsSaving(true);
            const next = await window.officeDesktop.updateMarkdownPreferences({
                workspacePathAsImageBasePath: settingsDraft.workspacePathAsImageBasePath,
                pasterImgPath: settingsDraft.pasterImgPath.trim(),
                pdfMarginTop,
            });
            preferencesRef.current = next;
            setPreferences(next);
            setSettingsOpen(false);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setSettingsSaving(false);
        }
    }, [settingsDraft]);

    const pasteImageIntoSource = useCallback(async (textarea: HTMLTextAreaElement) => {
        const selectionStart = textarea.selectionStart;
        const selectionEnd = textarea.selectionEnd;
        const value = textarea.value;
        try {
            const result = await window.officeDesktop.pasteMarkdownImage(session.id);
            if (!result) {
                setError('剪贴板中没有可粘贴的图片。');
                return;
            }
            const next = `${value.slice(0, selectionStart)}${result.markdown}${value.slice(selectionEnd)}`;
            latestTextRef.current = next;
            setSourceText(next);
            onDirtyChange?.(true);
            requestAnimationFrame(() => {
                const editor = sourceTextareaRef.current;
                if (!editor) return;
                const caret = selectionStart + result.markdown.length;
                editor.focus();
                editor.setSelectionRange(caret, caret);
            });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }, [onDirtyChange, session.id]);

    const initializeEditor = useCallback(async () => {
        try {
            setError(undefined);
            const needsDocumentRead = loadedSessionRef.current !== session.id;
            const [bytes, preferences] = await Promise.all([
                needsDocumentRead ? window.officeDesktop.readFile(session.id) : Promise.resolve(undefined),
                window.officeDesktop.loadMarkdownPreferences(),
            ]);
            preferencesRef.current = preferences;
            setPreferences(preferences);
            const text = bytes
                ? new TextDecoder('utf-8', { fatal: false }).decode(bytes)
                : latestTextRef.current;
            loadedSessionRef.current = session.id;
            latestTextRef.current = text;
            if (bytes) savedTextRef.current = text;
            setSourceText(text);
            postToEditor('open', {
                content: text,
                rootPath: `${MARKDOWN_ORIGIN}/assets`,
                documentCacheId: `desktop:${session.id}`,
                pendingFragment: '',
                config: {
                    editMode: preferences.editMode,
                    editorTheme: preferences.editorTheme,
                    codeMirrorTheme: preferences.codeMirrorTheme,
                    mermaidTheme: preferences.mermaidTheme,
                    markdown: { math: { macros: {} } },
                    language: navigator.language,
                    isWeb: false,
                    isDev: false,
                },
                viewerSettings: preferences.viewerSettings,
            });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }, [postToEditor, session.id]);

    useEffect(() => window.officeDesktop.onMarkdownAiEvent((event) => {
        if (event.sessionId !== session.id || event.requestId !== aiRequestRef.current) return;
        const generating = aiGenerateRef.current;
        if (event.type === 'chunk') {
            if (generating) generating.chunks.push(event.content ?? '');
            else postToEditor('aiPolishChunk', event.content ?? '');
        } else if (event.type === 'end') {
            aiRequestRef.current = undefined;
            if (generating) {
                aiGenerateRef.current = undefined;
                postToEditor('insertGeneratedContent', { kind: generating.kind, content: generating.chunks.join('') });
            } else {
                postToEditor('aiPolishEnd');
            }
        } else {
            aiRequestRef.current = undefined;
            aiGenerateRef.current = undefined;
            postToEditor('aiPolishEnd');
            setError(event.content || (generating ? 'AI 生成失败' : 'AI 润色失败'));
        }
    }), [postToEditor, session.id]);

    useEffect(() => {
        const receive = (event: MessageEvent<MarkdownFrameMessage>) => {
            if (event.source !== frameRef.current?.contentWindow || !event.data?.__officeMarkdownViewer) return;
            const type = event.data.message?.type;
            const content = event.data.message?.content;
            switch (type) {
                case 'init':
                    void initializeEditor();
                    break;
                case 'save':
                    markDirty(asText(content));
                    break;
                case 'doSave':
                    void save(asText(content));
                    break;
                case 'editInVSCode':
                    sourceEntryTextRef.current = latestTextRef.current;
                    setSourceText(latestTextRef.current);
                    setSourceMode(true);
                    break;
                case 'showInFolder':
                    void window.officeDesktop.showInFolder(session.id).catch((reason: unknown) => {
                        setError(reason instanceof Error ? reason.message : String(reason));
                    });
                    break;
                case 'openLink': {
                    const link = asText(content);
                    if (link.startsWith('wiki:')) {
                        void window.officeDesktop.openMarkdownLink(session.id, link).catch((reason: unknown) => {
                            setError(reason instanceof Error ? reason.message : String(reason));
                        });
                    } else if (/^https?:\/\//i.test(link)) {
                        void window.officeDesktop.openExternal(link).catch((reason: unknown) => {
                            setError(reason instanceof Error ? reason.message : String(reason));
                        });
                    }
                    break;
                }
                case 'openExternal':
                    if (/^https?:\/\//i.test(asText(content))) void window.officeDesktop.openExternal(asText(content));
                    break;
                case 'developerTool':
                    void window.officeDesktop.toggleDevTools();
                    break;
                case 'editMode':
                    if (content === 'wysiwyg' || content === 'ir') void updatePreference({ editMode: content });
                    break;
                case 'editorTheme':
                    void updatePreference({ editorTheme: asText(content) });
                    break;
                case 'codeMirrorTheme':
                    void updatePreference({ codeMirrorTheme: asText(content) });
                    break;
                case 'mermaidTheme':
                    void updatePreference({ mermaidTheme: asText(content) });
                    break;
                case 'editDesktopMarkdownSettings':
                    openDesktopSettings();
                    break;
                case 'queryAIAvailable':
                    postToEditor('aiAvailable', true);
                    break;
                case 'queryVSCodeModels':
                    postToEditor('vscodeModels', []);
                    break;
                case 'syncViewerSettings':
                case 'editViewerSettings':
                    void window.officeDesktop.saveMarkdownViewerSettings(content as DesktopMarkdownViewerSettings).then((preferences) => {
                        preferencesRef.current = preferences;
                        postToEditor('viewerSettingsSync', { enabled: true });
                    }).catch(showError);
                    break;
                case 'img': {
                    const payload = content as { data?: unknown; ext?: unknown } | undefined;
                    const data = binaryStringToBytes(asText(payload?.data));
                    if (data.byteLength > 0) {
                        void window.officeDesktop.saveMarkdownImage(session.id, data, asText(payload?.ext) || 'png')
                            .then((result) => postToEditor('insertImageMarkdown', result.markdown))
                            .catch(showError);
                    }
                    break;
                }
                case 'insertImage':
                    void window.officeDesktop.selectMarkdownImage(session.id)
                        .then((result) => { if (result) postToEditor('insertImageMarkdown', result.markdown); })
                        .catch(showError);
                    break;
                case 'command':
                    if (content === 'office.markdown.paste') {
                        void pasteFromClipboard();
                    }
                    break;
                case 'export':
                    void exportMarkdown(content);
                    break;
                case 'print':
                    void printCurrentDocument();
                    break;
                case 'exportImage':
                    void exportLongImage();
                    break;
                case 'exportText':
                    void exportPlainText();
                    break;
                case 'scanDeadLinks':
                    void window.officeDesktop.scanMarkdownDeadLinks(session.id, asText(content))
                        .then((missing) => setDeadLinks(missing))
                        .catch(showError);
                    break;
                case 'requestTemplates':
                    void window.officeDesktop.loadMarkdownTemplates()
                        .then((templates) => postToEditor('markdownTemplates', templates))
                        .catch(showError);
                    break;
                case 'dropFiles': {
                    const files = Array.isArray(content) ? content.filter((item): item is File => item instanceof File) : [];
                    if (files.length > 0) {
                        void window.officeDesktop.markdownDropFileLinks(session.id, files)
                            .then((markdown) => { if (markdown) postToEditor('insertImageMarkdown', markdown); })
                            .catch(showError);
                    }
                    break;
                }
                case 'assistantSelection': {
                    // The vditor iframe forwards its DOM selection for the
                    // assistant floating toolbar; map it into viewport space.
                    const payload = content as { text?: unknown; rect?: { left: number; top: number; width: number; height: number } | null } | undefined;
                    const frame = frameRef.current;
                    if (!frame) break;
                    const bounds = frame.getBoundingClientRect();
                    const rect = payload?.rect ?? null;
                    publishAssistantSelection({
                        text: asText(payload?.text),
                        x: rect ? bounds.left + rect.left + rect.width / 2 : bounds.left + bounds.width / 2,
                        y: rect ? bounds.top + rect.top : bounds.top,
                    });
                    break;
                }
                case 'aiGenerate':
                    void startAiGenerate(content);
                    break;
                case 'aiPolish':
                    void startAiPolish(content);
                    break;
                case 'aiPolishCancel': {
                    const requestId = aiRequestRef.current;
                    aiRequestRef.current = undefined;
                    if (requestId) void window.officeDesktop.cancelMarkdownAiPolish(requestId);
                    break;
                }
            }
        };

        const showError = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
        const updatePreference = async (patch: Parameters<typeof window.officeDesktop.updateMarkdownPreferences>[0]) => {
            try {
                const next = await window.officeDesktop.updateMarkdownPreferences(patch);
                preferencesRef.current = next;
                setPreferences(next);
            } catch (reason) {
                showError(reason);
            }
        };
        const pasteFromClipboard = async () => {
            try {
                const text = await navigator.clipboard.readText().catch(() => '');
                if (text) {
                    postToEditor('insertImageMarkdown', text);
                    return;
                }
                const result = await window.officeDesktop.pasteMarkdownImage(session.id);
                if (result) postToEditor('insertImageMarkdown', result.markdown);
                else setError('剪贴板中没有可粘贴的图片。');
            } catch (reason) {
                showError(reason);
            }
        };
        const exportMarkdown = async (rawOption: unknown) => {
            const option = rawOption as { type?: 'pdf' | 'html' | 'docx'; withoutOutline?: boolean } | undefined;
            if (!option?.type) return;
            try {
                await save(latestTextRef.current);
                await window.officeDesktop.exportMarkdown(session.id, latestTextRef.current, {
                    type: option.type,
                    withoutOutline: option.withoutOutline === true,
                });
            } catch (reason) {
                showError(reason);
            }
        };
        const printCurrentDocument = async () => {
            try {
                await save(latestTextRef.current);
                await window.officeDesktop.printMarkdown(session.id, latestTextRef.current);
            } catch (reason) {
                showError(reason);
            }
        };
        const exportLongImage = async () => {
            try {
                await save(latestTextRef.current);
                await window.officeDesktop.exportMarkdownImage(session.id, latestTextRef.current);
            } catch (reason) {
                showError(reason);
            }
        };
        const exportPlainText = async () => {
            try {
                await save(latestTextRef.current);
                await window.officeDesktop.exportMarkdownText(session.id, latestTextRef.current);
            } catch (reason) {
                showError(reason);
            }
        };
        const startAiGenerate = async (rawPayload: unknown) => {
            const payload = rawPayload as { kind?: unknown; markdown?: unknown; options?: DesktopMarkdownAiOptions } | undefined;
            const kind = payload?.kind === 'summary' ? 'summary' : 'toc';
            const markdown = asText(payload?.markdown);
            if (!markdown) return;
            const previous = aiRequestRef.current;
            if (previous) await window.officeDesktop.cancelMarkdownAiPolish(previous).catch(() => false);
            const requestId = crypto.randomUUID();
            aiRequestRef.current = requestId;
            aiGenerateRef.current = { kind, chunks: [] };
            try {
                await window.officeDesktop.startMarkdownAiPolish(session.id, requestId, markdown, { ...(payload?.options ?? {}), task: kind });
            } catch (reason) {
                if (aiRequestRef.current === requestId) {
                    aiRequestRef.current = undefined;
                    aiGenerateRef.current = undefined;
                    showError(reason);
                }
            }
        };
        const startAiPolish = async (rawPayload: unknown) => {
            const payload = rawPayload as { markdown?: unknown; options?: DesktopMarkdownAiOptions } | undefined;
            const markdown = asText(payload?.markdown);
            if (!markdown) return;
            const previous = aiRequestRef.current;
            if (previous) await window.officeDesktop.cancelMarkdownAiPolish(previous).catch(() => false);
            const requestId = crypto.randomUUID();
            aiRequestRef.current = requestId;
            try {
                await window.officeDesktop.startMarkdownAiPolish(session.id, requestId, markdown, payload?.options);
            } catch (reason) {
                if (aiRequestRef.current === requestId) {
                    aiRequestRef.current = undefined;
                    postToEditor('aiPolishEnd');
                    showError(reason);
                }
            }
        };
        window.addEventListener('message', receive);
        return () => {
            window.removeEventListener('message', receive);
            const requestId = aiRequestRef.current;
            aiRequestRef.current = undefined;
            aiGenerateRef.current = undefined;
            if (requestId) void window.officeDesktop.cancelMarkdownAiPolish(requestId).catch(() => false);
        };
    }, [initializeEditor, markDirty, openDesktopSettings, postToEditor, save, session.id]);

    const returnToVisualEditor = useCallback(() => {
        latestTextRef.current = sourceText;
        if (sourceText !== sourceEntryTextRef.current) {
            // Vditor normalizes Markdown when a programmatic update is applied.
            // Preserve the source editor's real dirty state instead of treating
            // that normalization as a new user edit.
            pendingProgrammaticDirtyRef.current = sourceText !== savedTextRef.current;
            postToEditor('update', sourceText);
        }
        setSourceMode(false);
    }, [postToEditor, sourceText]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (sourceMode && (event.ctrlKey || event.metaKey) && event.altKey && event.code === 'KeyE') {
                event.preventDefault();
                returnToVisualEditor();
            } else if (sourceMode && (event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
                event.preventDefault();
                void save(sourceText);
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [returnToVisualEditor, save, sourceMode, sourceText]);

    return (
        <div className="desktop-markdown-viewer">
            {error && <Alert className="desktop-markdown-viewer__error" type="error" showIcon closable message="Markdown 操作失败" description={error} onClose={() => setError(undefined)} />}
            <iframe
                ref={frameRef}
                className={sourceMode ? 'desktop-markdown-viewer__frame is-hidden' : 'desktop-markdown-viewer__frame'}
                src={`${MARKDOWN_ORIGIN}/assets/index.html?session=${encodeURIComponent(session.id)}${preferences?.workspacePathAsImageBasePath ? '&imageBase=workspace' : ''}`}
                title={session.name}
                sandbox="allow-scripts allow-same-origin"
            />
            {deadLinks && (
                <div className="desktop-markdown-settings-backdrop" role="presentation" onMouseDown={(event) => {
                    if (event.target === event.currentTarget) setDeadLinks(undefined);
                }}>
                    <section className="desktop-markdown-settings desktop-markdown-deadlinks" role="dialog" aria-modal="true" aria-labelledby="desktop-markdown-deadlinks-title">
                        <header>
                            <div>
                                <strong id="desktop-markdown-deadlinks-title">死链检查报告</strong>
                                <span>相对链接与图片引用的文件存在性</span>
                            </div>
                            <button type="button" aria-label="关闭死链检查报告" onClick={() => setDeadLinks(undefined)}>×</button>
                        </header>
                        <div className="desktop-markdown-settings__body desktop-markdown-deadlinks__body">
                            {deadLinks.length === 0 ? (
                                <p className="desktop-markdown-deadlinks__empty">未发现缺失的链接或图片。</p>
                            ) : (
                                <ul className="desktop-markdown-deadlinks__list">
                                    {deadLinks.map((item, index) => (
                                        <li key={`${item.line}:${item.target}:${index}`}>
                                            <button
                                                type="button"
                                                onClick={() => postToEditor('revealDeadLink', { target: item.target })}
                                                title="点击定位到文档中的引用位置"
                                            >
                                                <span className="desktop-markdown-deadlinks__line">第 {item.line} 行</span>
                                                <span className="desktop-markdown-deadlinks__target">{item.target}</span>
                                                <span className="desktop-markdown-deadlinks__kind">{item.kind === 'image' ? '图片' : '链接'}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <footer>
                            <button type="button" onClick={() => setDeadLinks(undefined)}>关闭</button>
                        </footer>
                    </section>
                </div>
            )}
            {settingsOpen && (
                <div className="desktop-markdown-settings-backdrop" role="presentation" onMouseDown={(event) => {
                    if (event.target === event.currentTarget && !settingsSaving) setSettingsOpen(false);
                }}>
                    <section className="desktop-markdown-settings" role="dialog" aria-modal="true" aria-labelledby="desktop-markdown-settings-title">
                        <header>
                            <div>
                                <strong id="desktop-markdown-settings-title">Markdown 设置</strong>
                                <span>桌面端路径与 PDF 导出</span>
                            </div>
                            <button type="button" aria-label="关闭 Markdown 设置" disabled={settingsSaving} onClick={() => setSettingsOpen(false)}>×</button>
                        </header>
                        <div className="desktop-markdown-settings__body">
                            <label className="desktop-markdown-settings__check">
                                <input
                                    type="checkbox"
                                    checked={settingsDraft.workspacePathAsImageBasePath}
                                    onChange={(event) => setSettingsDraft((current) => ({ ...current, workspacePathAsImageBasePath: event.target.checked }))}
                                />
                                <span>
                                    <strong>工作区作为图片基准路径</strong>
                                    <small>优先使用最近的 .git 或 .vscode 项目根目录；未找到时使用当前文档目录。</small>
                                </span>
                            </label>
                            <label>
                                <span>粘贴图片路径</span>
                                <input
                                    aria-label="粘贴图片路径"
                                    type="text"
                                    value={settingsDraft.pasterImgPath}
                                    onChange={(event) => setSettingsDraft((current) => ({ ...current, pasterImgPath: event.target.value }))}
                                />
                                <small>{'变量：${workspaceDir}、${fileName}、${now}、${date}、${uuid}、${ext}'}</small>
                            </label>
                            <label>
                                <span>PDF 顶部边距</span>
                                <div className="desktop-markdown-settings__number">
                                    <input
                                        aria-label="PDF 顶部边距"
                                        type="number"
                                        min="0"
                                        max="500"
                                        step="1"
                                        value={settingsDraft.pdfMarginTop}
                                        onChange={(event) => setSettingsDraft((current) => ({ ...current, pdfMarginTop: event.target.value }))}
                                    />
                                    <span>毫米</span>
                                </div>
                            </label>
                        </div>
                        <footer>
                            <button type="button" disabled={settingsSaving} onClick={() => setSettingsOpen(false)}>取消</button>
                            <button type="button" className="is-primary" disabled={settingsSaving} onClick={() => void saveDesktopSettings()}>
                                {settingsSaving ? '保存中…' : '保存设置'}
                            </button>
                        </footer>
                    </section>
                </div>
            )}
            {sourceMode && (
                <section className="desktop-markdown-source" aria-label="Markdown 源文本编辑器">
                    <header>
                        <strong>Markdown 源文本</strong>
                        <span>{session.name}</span>
                        <button type="button" onClick={() => void save(sourceText)}>保存</button>
                        <button type="button" onClick={returnToVisualEditor}>返回可视化编辑</button>
                    </header>
                    <textarea
                        ref={sourceTextareaRef}
                        aria-label="Markdown 源文本"
                        spellCheck={false}
                        value={sourceText}
                        onChange={(event) => {
                            setSourceText(event.target.value);
                            latestTextRef.current = event.target.value;
                            onDirtyChange?.(event.target.value !== savedTextRef.current);
                        }}
                        onPaste={(event) => {
                            const hasImage = clipboardContainsImage(event.clipboardData);
                            const hasText = Boolean(event.clipboardData.getData('text/plain'));
                            // Chromium on Windows does not always expose a bitmap-only
                            // system clipboard as a File item. Fall back to Electron's
                            // main-process clipboard reader when the paste has no text.
                            if (!hasImage && hasText) return;
                            event.preventDefault();
                            void pasteImageIntoSource(event.currentTarget);
                        }}
                    />
                </section>
            )}
        </div>
    );
}

function binaryStringToBytes(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 0xff;
    return bytes;
}

function clipboardContainsImage(data: DataTransfer): boolean {
    return Array.from(data.items).some((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
        || Array.from(data.files).some((file) => file.type.toLowerCase().startsWith('image/'));
}
