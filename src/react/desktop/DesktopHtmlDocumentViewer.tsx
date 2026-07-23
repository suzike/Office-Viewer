import { closeBrackets, closeBracketsKeymap, snippet } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';import { bracketMatching, defaultHighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
} from '@codemirror/view';
import { Alert, Spin } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopFileSession } from '../../../desktop/shared/desktop-api';
import { formatHtmlText } from '../../../desktop/shared/html-format';
import { validateHtmlDocument, type HtmlValidationIssue } from '../../../desktop/shared/html-validate';
import { publishAssistantSelection } from '../../desktop/assistant/selectionEvents';

interface Props {
    session: DesktopFileSession;
    onDirtyChange?: (dirty: boolean) => void;
    onSessionReplaced?: (session: DesktopFileSession) => void;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

type HtmlPanelTab = 'console' | 'resources' | 'performance' | 'issues';
type HtmlDevicePreset = 'desktop' | 'iphone' | 'ipad' | 'custom';
type HtmlColorScheme = 'system' | 'light' | 'dark';
type HtmlResourceView = 'list' | 'waterfall';

interface HtmlConsoleEntry {
    readonly id: number;
    readonly level: string;
    readonly text: string;
}

interface HtmlResourceEntry {
    readonly name: string;
    readonly kind: string;
    readonly size: number;
    readonly duration: number;
    readonly start?: number;
    readonly status?: string;
}

interface HtmlFindResult {
    readonly count: number;
    readonly current: number;
}

const HTML_RULE_LABELS: Record<HtmlValidationIssue['rule'], string> = {
    'unclosed-tag': '未闭合',
    'unmatched-close': '闭合不匹配',
    'duplicate-id': '重复 id',
    'deprecated-tag': '弃用标签',
};

interface HtmlPerformanceMetrics {
    readonly dcl: number;
    readonly fcp: number;
    readonly lcp: number;
    readonly resourceCount: number;
    readonly resourceBytes: number;
}

const HTML_DEVICE_SIZES: Record<Exclude<HtmlDevicePreset, 'desktop' | 'custom'>, { readonly width: number; readonly height: number }> = {
    iphone: { width: 390, height: 844 },
    ipad: { width: 820, height: 1180 },
};

const MAX_CONSOLE_ENTRIES = 500;

interface HtmlSnippet {
    readonly label: string;
    readonly template: string;
}

const HTML_SNIPPETS: readonly HtmlSnippet[] = [
    {
        label: 'HTML5 骨架',
        template: '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8">\n  <title>${1:页面标题}</title>\n</head>\n<body>\n  ${}\n</body>\n</html>',
    },
    {
        label: '响应式页面',
        template: '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${1:响应式页面}</title>\n</head>\n<body>\n  <main class="container">\n    ${}\n  </main>\n</body>\n</html>',
    },
    {
        label: '表格',
        template: '<table>\n  <thead>\n    <tr>\n      <th>${1:列一}</th>\n      <th>${2:列二}</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>${}</td>\n      <td></td>\n    </tr>\n  </tbody>\n</table>',
    },
    {
        label: '表单',
        template: '<form action="${1:/submit}" method="post">\n  <label>\n    ${2:名称}\n    <input type="text" name="name" required>\n  </label>\n  <label>\n    邮箱\n    <input type="email" name="email">\n  </label>\n  <button type="submit">${3:提交}</button>\n</form>',
    },
    {
        label: '卡片网格',
        template: '<section class="card-grid">\n  <article class="card">\n    <h3>${1:卡片标题}</h3>\n    <p>${2:卡片描述}</p>\n  </article>\n  <article class="card">\n    <h3>卡片标题</h3>\n    <p>卡片描述</p>\n  </article>\n  <article class="card">\n    <h3>卡片标题</h3>\n    <p>卡片描述</p>\n  </article>\n</section>',
    },
    {
        label: 'Hero 区块',
        template: '<section class="hero">\n  <h1>${1:主标题}</h1>\n  <p>${2:一句简短的介绍文案}</p>\n  <a class="hero__cta" href="${3:#}">立即开始</a>\n</section>',
    },
];

const htmlEditorTheme = EditorView.theme({
    '&': { height: '100%', color: 'var(--ink)', background: 'var(--paper-raised)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: '13px', lineHeight: '1.58' },
    '.cm-content': { padding: '12px 0', caretColor: 'var(--accent)' },
    '.cm-gutters': { background: 'var(--paper)', color: 'var(--ink-muted)', borderRight: '1px solid var(--line)' },
    '.cm-activeLine, .cm-activeLineGutter': { background: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'color-mix(in srgb, var(--accent) 28%, transparent) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-matchingBracket': { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', outline: '1px solid var(--accent)' },
    '.cm-selectionMatch': { background: 'color-mix(in srgb, var(--accent) 18%, transparent)' },
    '.cm-tooltip': { background: 'var(--paper-raised)', color: 'var(--ink)', border: '1px solid var(--line)' },
    '.cm-panels': { background: 'var(--paper)', color: 'var(--ink)', borderBottom: '1px solid var(--line)' },
    '.cm-panel.cm-search': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: '12px' },
    '.cm-panel.cm-search input': { padding: '3px 7px', border: '0.5px solid var(--line-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-raised)', color: 'var(--ink)', outline: 'none' },
    '.cm-panel.cm-search input:focus': { borderColor: 'var(--accent)' },
    '.cm-panel.cm-search button': { padding: '3px 8px', border: '0.5px solid var(--line-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-raised)', color: 'var(--ink)', cursor: 'pointer', backgroundImage: 'none' },
    '.cm-panel.cm-search button:hover': { background: 'color-mix(in srgb, var(--ink) 7%, var(--paper-raised))' },
    '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--ink-muted)' },
    '.cm-searchMatch': { background: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
    '.cm-searchMatch-selected': { background: 'color-mix(in srgb, var(--accent) 40%, transparent)' },
}, { dark: false });

export default function DesktopHtmlDocumentViewer({ session, onDirtyChange, onSessionReplaced }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const baselineRef = useRef('');
    const dirtyRef = useRef(false);
    const snippetsRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const consoleListRef = useRef<HTMLUListElement>(null);
    const consoleIdRef = useRef(0);
    const [loading, setLoading] = useState(true);
    const [version, setVersion] = useState(0);
    const [sourceVisible, setSourceVisible] = useState(false);
    const [source, setSource] = useState('');
    const [error, setError] = useState<string>();
    const [zoom, setZoom] = useState(1);
    const [exporting, setExporting] = useState(false);
    const [exportingImage, setExportingImage] = useState(false);
    const [snippetsOpen, setSnippetsOpen] = useState(false);
    const [panelTab, setPanelTab] = useState<HtmlPanelTab | null>(null);
    const [consoleEntries, setConsoleEntries] = useState<HtmlConsoleEntry[]>([]);
    const [resources, setResources] = useState<HtmlResourceEntry[]>([]);
    const [metrics, setMetrics] = useState<HtmlPerformanceMetrics | null>(null);
    const [issues, setIssues] = useState<HtmlValidationIssue[]>([]);
    const [resourceView, setResourceView] = useState<HtmlResourceView>('list');
    const [colorScheme, setColorScheme] = useState<HtmlColorScheme>('system');
    const [jsEnabled, setJsEnabled] = useState(true);
    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState('');
    const [findResult, setFindResult] = useState<HtmlFindResult>({ count: 0, current: 0 });
    const [device, setDevice] = useState<HtmlDevicePreset>('desktop');
    const [customSize, setCustomSize] = useState({ width: 480, height: 800 });
    const pendingLineRef = useRef<number | null>(null);
    const findQueryRef = useRef('');
    const colorSchemeRef = useRef<HtmlColorScheme>('system');
    useEffect(() => { findQueryRef.current = findQuery; }, [findQuery]);
    useEffect(() => { colorSchemeRef.current = colorScheme; }, [colorScheme]);
    const sourceRef = useRef(source);
    useEffect(() => { sourceRef.current = source; }, [source]);

    const setDirty = useCallback((dirty: boolean) => {
        if (dirtyRef.current === dirty) return;
        dirtyRef.current = dirty;
        onDirtyChange?.(dirty);
    }, [onDirtyChange]);

    useEffect(() => {
        let disposed = false;
        void window.officeDesktop.readFile(session.id).then((buffer) => {
            if (disposed) return;
            const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
            baselineRef.current = text;
            setSource(text);
            setDirty(false);
        }).catch((reason: unknown) => {
            if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        });
        return () => { disposed = true; };
    }, [session.id, setDirty]);

    useEffect(() => window.officeDesktop.onFileChanged((event) => {
        if (event.sessionId === session.id) {
            setLoading(true);
            setVersion(value => value + 1);
        }
    }), [session.id]);

    // Build the CodeMirror source editor whenever split mode is active.
    useEffect(() => {
        if (!sourceVisible || !containerRef.current) return;
        const updateListener = EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                const current = update.state.doc.toString();
                sourceRef.current = current;
                setDirty(current !== baselineRef.current);
            }
        });
        const state = EditorState.create({
            doc: sourceRef.current,
            extensions: [
                lineNumbers(), highlightSpecialChars(), highlightActiveLineGutter(), highlightActiveLine(),
                history(), bracketMatching(), closeBrackets(),
                keymap.of([
                    indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap,
                ]),
                indentUnit.of('  '),
                EditorState.readOnly.of(session.readOnly),
                EditorView.editable.of(!session.readOnly),
                EditorView.lineWrapping,
                html({ autoCloseTags: true }),
                highlightSelectionMatches(),
                htmlEditorTheme,
                syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                updateListener,
            ],
        });
        const view = new EditorView({ state, parent: containerRef.current });
        viewRef.current = view;
        (containerRef.current as HTMLDivElement & { cmView?: EditorView }).cmView = view;
        if (pendingLineRef.current !== null) {
            jumpToSourceLine(view, pendingLineRef.current);
            pendingLineRef.current = null;
        }
        return () => {
            if (containerRef.current) delete (containerRef.current as HTMLDivElement & { cmView?: EditorView }).cmView;
            view.destroy();
            viewRef.current = null;
        };
    }, [session.id, session.readOnly, setDirty, sourceVisible]);

    const save = useCallback(async () => {
        try {
            const text = viewRef.current?.state.doc.toString() ?? sourceRef.current;
            const bytes = new TextEncoder().encode(text);
            const result = session.readOnly
                ? await window.officeDesktop.saveFileAs(session.id, bytes, session.name)
                : await window.officeDesktop.saveFile(session.id, bytes);
            if (!result) return;
            baselineRef.current = text;
            setSource(text);
            setDirty(false);
            setLoading(true);
            setVersion(value => value + 1);
            if (result.session.id !== session.id) onSessionReplaced?.(result.session);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }, [onSessionReplaced, session, setDirty]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyV') {
                event.preventDefault();
                setSourceVisible((visible) => !visible);
            } else if (sourceVisible && (event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
                event.preventDefault();
                void save();
            } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.code === 'KeyF'
                && !(event.target as HTMLElement | null)?.closest?.('.desktop-html-source')) {
                // CodeMirror keeps its own search; everywhere else Ctrl+F searches the preview.
                event.preventDefault();
                setFindOpen(true);
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [save, sourceVisible]);

    useEffect(() => {
        if (!snippetsOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (snippetsRef.current && !snippetsRef.current.contains(event.target as Node)) setSnippetsOpen(false);
        };
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setSnippetsOpen(false);
        };
        window.addEventListener('mousedown', onPointerDown, true);
        window.addEventListener('keydown', onEscape, true);
        return () => {
            window.removeEventListener('mousedown', onPointerDown, true);
            window.removeEventListener('keydown', onEscape, true);
        };
    }, [snippetsOpen]);

    const formatSource = useCallback(() => {
        const view = viewRef.current;
        if (!view || session.readOnly) return;
        const text = view.state.doc.toString();
        const formatted = formatHtmlText(text);
        if (formatted === text) return;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted }, selection: { anchor: 0 } });
        view.focus();
    }, [session.readOnly]);

    const insertSnippet = useCallback((template: string) => {
        const view = viewRef.current;
        if (!view || session.readOnly) return;
        const selection = view.state.selection.main;
        snippet(template)({ state: view.state, dispatch: view.dispatch }, null, selection.from, selection.to);
        view.focus();
    }, [session.readOnly]);

    const adjustZoom = useCallback((delta: number) => {
        setZoom((value) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((value + delta) * 10) / 10)));
    }, []);

    // Bridge: receive console/resource/performance events posted by the inspector
    // script injected into the office-html: preview document.
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (event.source !== iframeRef.current?.contentWindow) return;
            const data = event.data as {
                source?: string;
                type?: string;
                level?: string;
                text?: string;
                rect?: { left: number; top: number; width: number; height: number } | null;
                entries?: HtmlResourceEntry[];
                metrics?: HtmlPerformanceMetrics;
                count?: number;
                current?: number;
            } | null;
            if (!data || data.source !== 'office-html-inspector') return;
            if (data.type === 'console' && typeof data.text === 'string') {
                consoleIdRef.current += 1;
                const entry: HtmlConsoleEntry = {
                    id: consoleIdRef.current,
                    level: typeof data.level === 'string' ? data.level : 'log',
                    text: data.text,
                };
                setConsoleEntries((entries) => [...entries.slice(-(MAX_CONSOLE_ENTRIES - 1)), entry]);
            } else if (data.type === 'resources' && Array.isArray(data.entries)) {
                setResources(data.entries);
            } else if (data.type === 'metrics' && data.metrics) {
                setMetrics(data.metrics);
            } else if (data.type === 'open-find') {
                setFindOpen(true);
            } else if (data.type === 'find-result') {
                setFindResult({ count: data.count ?? 0, current: data.current ?? 0 });
            } else if (data.type === 'selection') {
                // Forward the preview document's selection to the assistant
                // toolbar, mapping iframe-local coordinates into viewport space.
                const frame = iframeRef.current;
                if (!frame) return;
                const bounds = frame.getBoundingClientRect();
                const rect = data.rect ?? null;
                publishAssistantSelection({
                    text: typeof data.text === 'string' ? data.text : '',
                    x: rect ? bounds.left + (rect.left + rect.width / 2) * zoom : bounds.left + bounds.width / 2,
                    y: rect ? bounds.top + rect.top * zoom : bounds.top,
                });
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [zoom]);

    useEffect(() => {
        if (panelTab === 'console' && consoleListRef.current) {
            consoleListRef.current.scrollTop = consoleListRef.current.scrollHeight;
        }
    }, [consoleEntries, panelTab]);

    const togglePanel = useCallback((tab: HtmlPanelTab) => {
        setPanelTab((current) => (current === tab ? null : tab));
    }, []);

    const postToPreview = useCallback((payload: Record<string, unknown>) => {
        iframeRef.current?.contentWindow?.postMessage({ source: 'office-html-host', ...payload }, '*');
    }, []);

    const refreshResources = useCallback(() => {
        postToPreview({ type: 'collect-resources' });
    }, [postToPreview]);

    const runValidation = useCallback(() => {
        const text = viewRef.current?.state.doc.toString() ?? sourceRef.current;
        setIssues(validateHtmlDocument(text));
    }, []);

    useEffect(() => {
        if (panelTab === 'issues') runValidation();
    }, [panelTab, runValidation]);

    const locateIssue = useCallback((line: number) => {
        const view = viewRef.current;
        if (sourceVisible && view) {
            jumpToSourceLine(view, line);
            return;
        }
        pendingLineRef.current = line;
        setSourceVisible(true);
    }, [sourceVisible]);

    const applyColorScheme = useCallback((mode: HtmlColorScheme) => {
        setColorScheme(mode);
        colorSchemeRef.current = mode;
        postToPreview({ type: 'set-color-scheme', mode });
    }, [postToPreview]);

    const updateFindQuery = useCallback((query: string) => {
        setFindQuery(query);
        findQueryRef.current = query;
        postToPreview({ type: 'find', query });
    }, [postToPreview]);

    const stepFind = useCallback((delta: 1 | -1) => {
        postToPreview({ type: 'find-step', delta });
    }, [postToPreview]);

    const closeFind = useCallback(() => {
        setFindOpen(false);
        setFindQuery('');
        findQueryRef.current = '';
        setFindResult({ count: 0, current: 0 });
        postToPreview({ type: 'find-close' });
    }, [postToPreview]);

    // Re-apply simulations after every preview reload (the injected document is fresh).
    const onPreviewLoad = useCallback(() => {
        setLoading(false);
        if (colorSchemeRef.current !== 'system') {
            postToPreview({ type: 'set-color-scheme', mode: colorSchemeRef.current });
        }
        if (findQueryRef.current) {
            postToPreview({ type: 'find', query: findQueryRef.current });
        }
    }, [postToPreview]);

    const exportPdf = useCallback(async () => {
        setExporting(true);
        try {
            await window.officeDesktop.exportHtmlPdf(session.id);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setExporting(false);
        }
    }, [session.id]);

    const exportImage = useCallback(async () => {
        setExportingImage(true);
        try {
            await window.officeDesktop.exportHtmlImage(session.id);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setExportingImage(false);
        }
    }, [session.id]);

    const viewerUrl = useMemo(() => {
        const fileName = encodeURIComponent(session.name);
        return `office-html://viewer/document/${encodeURIComponent(session.id)}/${fileName}?v=${version}${jsEnabled ? '' : '&js=0'}`;
    }, [session.id, session.name, version, jsEnabled]);

    // Reset the debug panels whenever the preview document reloads.
    const [prevViewerUrl, setPrevViewerUrl] = useState(viewerUrl);
    if (prevViewerUrl !== viewerUrl) {
        setPrevViewerUrl(viewerUrl);
        setConsoleEntries([]);
        setResources([]);
        setMetrics(null);
    }

    const deviceSize = useMemo(() => {
        if (device === 'desktop') return null;
        if (device === 'custom') return customSize;
        return HTML_DEVICE_SIZES[device];
    }, [device, customSize]);

    const waterfallTotal = useMemo(
        () => Math.max(1, ...resources.map((entry) => (entry.start ?? 0) + entry.duration)),
        [resources],
    );

    const applyCustomSize = useCallback((key: 'width' | 'height', raw: string) => {
        const value = Math.round(Number(raw));
        if (!Number.isFinite(value)) return;
        setCustomSize((size) => ({ ...size, [key]: Math.min(3840, Math.max(200, value)) }));
    }, []);

    return (
        <div className={`desktop-html-viewer${sourceVisible ? ' is-split' : ''}`}>
            <header className="desktop-html-toolbar">
                <strong>HTML Preview</strong>
                <span>{session.name}</span>
                {sourceVisible && (
                    <div className="desktop-html-snippets" ref={snippetsRef}>
                        <button type="button" disabled={session.readOnly} aria-haspopup="menu" aria-expanded={snippetsOpen} onClick={() => setSnippetsOpen((open) => !open)}>插入片段 ▾</button>
                        {snippetsOpen && (
                            <div className="menu-popover desktop-html-snippets__menu" role="menu">
                                {HTML_SNIPPETS.map((item) => (
                                    <button key={item.label} type="button" role="menuitem" onClick={() => { setSnippetsOpen(false); insertSnippet(item.template); }}>
                                        <span>{item.label}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {sourceVisible && <button type="button" disabled={session.readOnly} onClick={formatSource}>格式化</button>}
                <button type="button" onClick={() => setSourceVisible((visible) => !visible)}>
                    {sourceVisible ? '仅预览' : '源代码 / 分屏'}
                </button>
                {sourceVisible && <button type="button" disabled={session.readOnly && !source.length} onClick={() => void save()}>{session.readOnly ? '另存为' : '保存并刷新'}</button>}
                <select
                    className="desktop-html-device-select"
                    aria-label="设备预设"
                    value={device}
                    onChange={(event) => setDevice(event.target.value as HtmlDevicePreset)}
                >
                    <option value="desktop">桌面</option>
                    <option value="iphone">iPhone 390×844</option>
                    <option value="ipad">iPad 820×1180</option>
                    <option value="custom">自定义</option>
                </select>
                {device === 'custom' && (
                    <span className="desktop-html-custom-size">
                        <input type="number" min={200} max={3840} aria-label="自定义宽度" value={customSize.width} onChange={(event) => applyCustomSize('width', event.target.value)} />
                        ×
                        <input type="number" min={200} max={3840} aria-label="自定义高度" value={customSize.height} onChange={(event) => applyCustomSize('height', event.target.value)} />
                    </span>
                )}
                <div className="desktop-html-zoom" role="group" aria-label="预览缩放">
                    <button type="button" aria-label="缩小" disabled={zoom <= ZOOM_MIN} onClick={() => adjustZoom(-ZOOM_STEP)}>−</button>
                    <span>{Math.round(zoom * 100)}%</span>
                    <button type="button" aria-label="放大" disabled={zoom >= ZOOM_MAX} onClick={() => adjustZoom(ZOOM_STEP)}>+</button>
                </div>
                <select
                    className="desktop-html-scheme-select"
                    aria-label="颜色方案模拟"
                    title="模拟 prefers-color-scheme"
                    value={colorScheme}
                    onChange={(event) => applyColorScheme(event.target.value as HtmlColorScheme)}
                >
                    <option value="system">跟随系统</option>
                    <option value="light">强制浅色</option>
                    <option value="dark">强制深色</option>
                </select>
                <button type="button" aria-pressed={!jsEnabled} title="禁用脚本后重新加载预览" onClick={() => setJsEnabled((enabled) => !enabled)}>
                    {jsEnabled ? '禁用 JS' : '启用 JS'}
                </button>
                <div className="desktop-html-debug" role="group" aria-label="调试面板">
                    <button type="button" aria-pressed={panelTab === 'console'} onClick={() => togglePanel('console')}>控制台</button>
                    <button type="button" aria-pressed={panelTab === 'resources'} onClick={() => togglePanel('resources')}>资源</button>
                    <button type="button" aria-pressed={panelTab === 'performance'} onClick={() => togglePanel('performance')}>性能</button>
                    <button type="button" aria-pressed={panelTab === 'issues'} onClick={() => togglePanel('issues')}>问题</button>
                </div>
                <button type="button" disabled={exporting} aria-busy={exporting} title="基于磁盘上已保存的内容导出 PDF" onClick={() => void exportPdf()}>{exporting ? '导出中…' : '导出 PDF'}</button>
                <button type="button" disabled={exportingImage} aria-busy={exportingImage} title="基于磁盘上已保存的内容导出整页 PNG 截图" onClick={() => void exportImage()}>{exportingImage ? '导出中…' : '导出 PNG'}</button>
                <kbd>Ctrl Shift V</kbd>
            </header>
            {error && <Alert className="desktop-html-error" type="error" showIcon closable message="HTML 操作失败" description={error} onClose={() => setError(undefined)} />}
            {panelTab && (
                <section className="desktop-html-panel" aria-label="调试面板">
                    <header className="desktop-html-panel__header">
                        <strong>{panelTab === 'console' ? '控制台' : panelTab === 'resources' ? '资源清单' : panelTab === 'issues' ? '校验问题' : '性能指标'}</strong>
                        {panelTab === 'console' && <button type="button" onClick={() => setConsoleEntries([])}>清空</button>}
                        {panelTab === 'resources' && (
                            <span className="desktop-html-debug" role="group" aria-label="资源视图">
                                <button type="button" aria-pressed={resourceView === 'list'} onClick={() => setResourceView('list')}>列表</button>
                                <button type="button" aria-pressed={resourceView === 'waterfall'} onClick={() => setResourceView('waterfall')}>瀑布</button>
                            </span>
                        )}
                        {panelTab === 'resources' && <button type="button" onClick={refreshResources}>刷新</button>}
                        {panelTab === 'issues' && <button type="button" onClick={runValidation}>重新校验</button>}
                        <button type="button" aria-label="关闭面板" onClick={() => setPanelTab(null)}>×</button>
                    </header>
                    {panelTab === 'console' && (
                        <ul className="desktop-html-console" ref={consoleListRef}>
                            {consoleEntries.length === 0 && <li className="desktop-html-panel__empty">暂无控制台输出</li>}
                            {consoleEntries.map((entry) => (
                                <li key={entry.id} data-level={entry.level}>
                                    <span className="desktop-html-console__level">{entry.level}</span>
                                    <span>{entry.text}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {panelTab === 'resources' && resourceView === 'list' && (
                        <div className="desktop-html-resources">
                            <table>
                                <thead>
                                    <tr><th>名称</th><th>类型</th><th>大小</th><th>耗时</th><th>状态</th></tr>
                                </thead>
                                <tbody>
                                    {resources.length === 0 && <tr><td colSpan={5} className="desktop-html-panel__empty">暂无资源记录</td></tr>}
                                    {resources.map((entry, index) => (
                                        <tr key={`${entry.name}-${index}`}>
                                            <td title={entry.name}>{resourceName(entry.name)}</td>
                                            <td>{entry.kind || '-'}</td>
                                            <td>{formatBytes(entry.size)}</td>
                                            <td>{entry.duration} ms</td>
                                            <td>{entry.status ?? '已加载'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {panelTab === 'resources' && resourceView === 'waterfall' && (
                        <div className="desktop-html-waterfall">
                            {resources.length === 0 && <p className="desktop-html-panel__empty">暂无资源记录</p>}
                            {resources.map((entry, index) => (
                                <div className="desktop-html-waterfall__row" key={`${entry.name}-${index}`}>
                                    <span className="desktop-html-waterfall__name" title={entry.name}>{resourceName(entry.name)}</span>
                                    <span className="desktop-html-waterfall__track">
                                        <span
                                            className="desktop-html-waterfall__bar"
                                            data-kind={entry.kind}
                                            style={{
                                                left: `${Math.min(99, ((entry.start ?? 0) / waterfallTotal) * 100)}%`,
                                                width: `${Math.max((entry.duration / waterfallTotal) * 100, 0.5)}%`,
                                            }}
                                            title={`开始 ${entry.start ?? 0} ms · 耗时 ${entry.duration} ms`}
                                        />
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    {panelTab === 'issues' && (
                        <ul className="desktop-html-issues">
                            {issues.length === 0 && <li className="desktop-html-panel__empty">未发现问题</li>}
                            {issues.map((issue, index) => (
                                <li key={`${issue.rule}-${issue.line}-${index}`}>
                                    <button type="button" onClick={() => locateIssue(issue.line)} title="定位到源码行">
                                        <span className="desktop-html-issues__line">行 {issue.line}</span>
                                        <span className="desktop-html-issues__rule" data-rule={issue.rule}>{HTML_RULE_LABELS[issue.rule]}</span>
                                        <span>{issue.message}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {panelTab === 'performance' && (
                        <div className="desktop-html-metrics">
                            <span>DCL {formatMs(metrics?.dcl)}</span>
                            <span>FCP {formatMs(metrics?.fcp)}</span>
                            <span>LCP {formatMs(metrics?.lcp)}</span>
                            <span>资源 {metrics?.resourceCount ?? 0} 个</span>
                            <span>总量 {formatBytes(metrics?.resourceBytes ?? 0)}</span>
                        </div>
                    )}
                </section>
            )}
            <div className="desktop-html-body">
                {sourceVisible && <div className="desktop-html-source" role="textbox" aria-label="HTML 源代码" aria-readonly={session.readOnly} ref={containerRef} />}
                <div className={`desktop-html-preview${deviceSize ? ' is-device' : ''}`}>
                    {deviceSize ? (
                        <div className="desktop-html-stage" style={{ width: deviceSize.width * zoom, height: deviceSize.height * zoom }}>
                            <div className="desktop-html-device" style={{ width: deviceSize.width, height: deviceSize.height, transform: `scale(${zoom})` }}>
                                <iframe
                                    key={viewerUrl}
                                    ref={iframeRef}
                                    title={session.name}
                                    src={viewerUrl}
                                    sandbox="allow-scripts"
                                    onLoad={onPreviewLoad}
                                />
                            </div>
                        </div>
                    ) : (
                        <iframe
                            key={viewerUrl}
                            ref={iframeRef}
                            title={session.name}
                            src={viewerUrl}
                            sandbox="allow-scripts"
                            style={{ width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})`, transformOrigin: '0 0' }}
                            onLoad={onPreviewLoad}
                        />
                    )}
                    {findOpen && (
                        <div className="desktop-html-find" role="search">
                            <input
                                type="search"
                                value={findQuery}
                                placeholder="在预览中查找"
                                aria-label="在预览中查找"
                                autoFocus
                                onChange={(event) => updateFindQuery(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        stepFind(event.shiftKey ? -1 : 1);
                                    } else if (event.key === 'Escape') {
                                        event.preventDefault();
                                        closeFind();
                                    }
                                }}
                            />
                            <span className="desktop-html-find__count">{findResult.count > 0 ? `${findResult.current}/${findResult.count}` : '无结果'}</span>
                            <button type="button" aria-label="上一个" disabled={findResult.count === 0} onClick={() => stepFind(-1)}>↑</button>
                            <button type="button" aria-label="下一个" disabled={findResult.count === 0} onClick={() => stepFind(1)}>↓</button>
                            <button type="button" aria-label="关闭查找" onClick={closeFind}>×</button>
                        </div>
                    )}
                    {loading && <Spin fullscreen tip="正在载入 HTML" />}
                </div>
            </div>
        </div>
    );
}

function resourceName(url: string): string {
    try {
        const path = new URL(url).pathname;
        return decodeURIComponent(path.split('/').filter(Boolean).pop() ?? path);
    } catch {
        return url;
    }
}

function jumpToSourceLine(view: EditorView, lineNumber: number): void {
    const line = view.state.doc.line(Math.min(Math.max(1, lineNumber), view.state.doc.lines));
    view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
}

function formatBytes(bytes: number): string {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatMs(value: number | undefined): string {
    return value ? `${Math.round(value)} ms` : '-';
}
