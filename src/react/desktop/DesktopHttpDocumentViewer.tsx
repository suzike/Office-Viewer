import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream, type StreamParser } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, hoverTooltip, keymap, lineNumbers, type DecorationSet, type ViewUpdate, ViewPlugin } from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    DesktopFileSession,
    DesktopHttpPreviewOption,
    DesktopHttpResponse,
    DesktopHttpSettings,
} from '../../../desktop/shared/desktop-api';
import {
    findDesktopHttpToken,
    getDesktopHttpCompletions,
    parseDesktopHttpLanguage,
    type DesktopHttpLanguageModel,
    type DesktopHttpRange,
} from '../../../desktop/shared/http-language';
import './DesktopHttpDocumentViewer.css';

interface Props {
    session: DesktopFileSession;
    onDirtyChange?: (dirty: boolean) => void;
    onSessionReplaced?: (session: DesktopFileSession) => void;
}

interface RequestBlock {
    index: number;
    startLine: number;
    endLine: number;
    name?: string;
    method: string;
    url: string;
    warnBeforeSend: boolean;
    text: string;
}

const DEFAULT_ENVIRONMENTS = '{\n  "$shared": {},\n  "local": {}\n}';
const EMPTY_MODEL = parseDesktopHttpLanguage('');

export default function DesktopHttpDocumentViewer({ session, onDirtyChange, onSessionReplaced }: Props) {
    const editorContainerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<EditorView | null>(null);
    const sourceRef = useRef('');
    const savedSourceRef = useRef('');
    const modelRef = useRef<DesktopHttpLanguageModel>(EMPTY_MODEL);
    const environmentRef = useRef<Readonly<Record<string, string>>>({});
    const activeRequestNamesRef = useRef<ReadonlySet<string>>(new Set());
    const bracketIndentationRef = useRef(true);
    const saveRef = useRef<() => void>(() => undefined);
    const sendCurrentRef = useRef<() => void>(() => undefined);
    const [source, setSource] = useState('');
    const [savedSource, setSavedSource] = useState('');
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string>();
    const [runningId, setRunningId] = useState<string>();
    const [responses, setResponses] = useState<DesktopHttpResponse[]>([]);
    const [activeResponseId, setActiveResponseId] = useState<string>();
    const [previewOption, setPreviewOption] = useState<DesktopHttpPreviewOption>('body');
    const [previewColumn, setPreviewColumn] = useState<'current' | 'beside'>('beside');
    const [responseFocused, setResponseFocused] = useState(false);
    const [followRedirect, setFollowRedirect] = useState(true);
    const [timeoutSeconds, setTimeoutSeconds] = useState(30);
    const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
    const [decodeEscapedUnicode, setDecodeEscapedUnicode] = useState(false);
    const [formParamEncoding, setFormParamEncoding] = useState<'automatic' | 'never' | 'always'>('automatic');
    const [addBracketIndentation, setAddBracketIndentation] = useState(true);
    const [logLevel, setLogLevel] = useState<'error' | 'warn' | 'info' | 'verbose'>('error');
    const [enableVariableCodeLens, setEnableVariableCodeLens] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [showOutline, setShowOutline] = useState(true);
    const [showProblems, setShowProblems] = useState(true);
    const [environmentSource, setEnvironmentSource] = useState(DEFAULT_ENVIRONMENTS);
    const [activeEnvironment, setActiveEnvironment] = useState('local');
    const [activeRequestNames, setActiveRequestNames] = useState<ReadonlySet<string>>(new Set());
    const [statusMessage, setStatusMessage] = useState('Ctrl+Enter 发送当前请求 · F12 转到定义 · Shift+F12 查看引用');
    const [settingsLoaded, setSettingsLoaded] = useState(false);

    const blocks = useMemo(() => discoverRequestBlocks(source), [source]);
    const blocksRef = useRef(blocks);
    blocksRef.current = blocks;
    const environmentConfig = useMemo(() => parseEnvironmentConfig(environmentSource), [environmentSource]);
    const environmentNames = environmentConfig.ok
        ? Object.keys(environmentConfig.environments).filter((name) => name !== '$shared')
        : [];
    const currentEnvironment = useMemo(() => environmentConfig.ok
        ? { ...(environmentConfig.environments.$shared ?? {}), ...(environmentConfig.environments[activeEnvironment] ?? {}) }
        : {}, [activeEnvironment, environmentConfig]);
    environmentRef.current = currentEnvironment;
    activeRequestNamesRef.current = activeRequestNames;
    bracketIndentationRef.current = addBracketIndentation;
    const languageModel = useMemo(
        () => parseDesktopHttpLanguage(source, currentEnvironment, activeRequestNames),
        [activeRequestNames, currentEnvironment, source],
    );
    modelRef.current = languageModel;
    const activeResponse = responses.find((response) => response.requestId === activeResponseId) ?? responses.at(-1);

    useEffect(() => {
        let disposed = false;
        void Promise.all([
            window.officeDesktop.readFile(session.id),
            window.officeDesktop.loadHttpSettings().catch(() => undefined),
        ]).then(([buffer, settings]) => {
            if (disposed) return;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            sourceRef.current = text;
            savedSourceRef.current = text;
            setSource(text);
            setSavedSource(text);
            if (settings) applySettings(settings, {
                setFollowRedirect, setEnvironmentSource, setPreviewOption, setPreviewColumn,
                setFormParamEncoding, setAddBracketIndentation, setDecodeEscapedUnicode,
                setLogLevel, setEnableVariableCodeLens, setTimeoutSeconds, setAllowPrivateNetwork,
                setActiveEnvironment,
            });
            setSettingsLoaded(true);
            setLoading(false);
            setLoadError(undefined);
        }).catch((reason: unknown) => {
            if (!disposed) {
                setLoadError(reason instanceof Error ? reason.message : String(reason));
                setLoading(false);
            }
        });
        return () => { disposed = true; };
    }, [session.id]);

    useEffect(() => {
        onDirtyChange?.(source !== savedSource);
    }, [onDirtyChange, savedSource, source]);

    useEffect(() => {
        if (!settingsLoaded || !environmentConfig.ok) return;
        const timer = window.setTimeout(() => {
            const settings: DesktopHttpSettings = {
                followRedirect, environmentSource, previewOption, previewColumn,
                formParamEncodingStrategy: formParamEncoding,
                addRequestBodyLineIndentationAroundBrackets: addBracketIndentation,
                decodeEscapedUnicodeCharacters: decodeEscapedUnicode, logLevel,
                enableCustomVariableReferencesCodeLens: enableVariableCodeLens,
                timeoutSeconds, allowPrivateNetwork, activeEnvironment,
            };
            void window.officeDesktop.saveHttpSettings(settings).catch((reason: unknown) => {
                setLoadError(reason instanceof Error ? reason.message : String(reason));
            });
        }, 250);
        return () => window.clearTimeout(timer);
    }, [activeEnvironment, addBracketIndentation, allowPrivateNetwork, decodeEscapedUnicode, enableVariableCodeLens, environmentConfig.ok, environmentSource, followRedirect, formParamEncoding, logLevel, previewColumn, previewOption, settingsLoaded, timeoutSeconds]);

    const save = useCallback(async () => {
        const text = sourceRef.current;
        const bytes = new TextEncoder().encode(text);
        const result = session.readOnly
            ? await window.officeDesktop.saveFileAs(session.id, bytes, session.name)
            : await window.officeDesktop.saveFile(session.id, bytes);
        if (!result) return;
        savedSourceRef.current = text;
        setSavedSource(text);
        onDirtyChange?.(false);
        if (result.session.id !== session.id) onSessionReplaced?.(result.session);
        setStatusMessage('已保存');
    }, [onDirtyChange, onSessionReplaced, session]);
    saveRef.current = () => { void save(); };

    const send = useCallback(async (block: RequestBlock) => {
        if (runningId) return;
        if (block.warnBeforeSend && !window.confirm(block.name
            ? `确定发送请求“${block.name}”吗？`
            : '确定发送此请求吗？')) return;
        if (!environmentConfig.ok) {
            setLoadError(environmentConfig.error);
            setShowSettings(true);
            return;
        }
        const requestId = crypto.randomUUID();
        setRunningId(requestId);
        setLoadError(undefined);
        setStatusMessage(`正在发送 ${block.method} ${block.url}`);
        try {
            const response = await window.officeDesktop.sendHttpRequest(
                session.id, sourceRef.current, block.index, requestId,
                {
                    environment: currentEnvironment, followRedirect,
                    timeoutMs: Math.round(timeoutSeconds * 1000), allowPrivateNetwork,
                    decodeEscapedUnicodeCharacters: decodeEscapedUnicode,
                    formParamEncodingStrategy: formParamEncoding, previewOption,
                },
            );
            setResponses((current) => [...current.slice(-19), response]);
            setActiveResponseId(response.requestId);
            if (block.name) setActiveRequestNames((current) => new Set([...current, block.name!]));
            if (previewColumn === 'current') setResponseFocused(true);
            setStatusMessage(`${response.statusCode} ${response.statusMessage} · ${response.elapsedMs} ms · ${response.bodyBytes.byteLength} B`);
        } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            if (!/abort|cancel/i.test(message)) setLoadError(message);
            setStatusMessage(/abort|cancel/i.test(message) ? '请求已取消' : '请求失败');
        } finally {
            setRunningId(undefined);
        }
    }, [allowPrivateNetwork, currentEnvironment, decodeEscapedUnicode, environmentConfig, followRedirect, formParamEncoding, previewColumn, previewOption, runningId, session.id, timeoutSeconds]);

    const sendCurrentRequest = useCallback(() => {
        const view = editorRef.current;
        const currentLine = view ? view.state.doc.lineAt(view.state.selection.main.head).number - 1 : 0;
        const currentBlocks = blocksRef.current;
        const block = currentBlocks.find((candidate) => candidate.startLine <= currentLine && candidate.endLine >= currentLine) ?? currentBlocks[0];
        if (block) void send(block);
    }, [send]);
    sendCurrentRef.current = sendCurrentRequest;

    const copyAsCurl = useCallback(async (block: RequestBlock) => {
        await navigator.clipboard.writeText(toCurl(block.text));
        setStatusMessage('cURL 已复制到剪贴板');
    }, []);

    useEffect(() => {
        if (loading || !editorContainerRef.current || editorRef.current) return;
        const state = EditorState.create({
            doc: sourceRef.current,
            extensions: createEditorExtensions({
                readOnly: session.readOnly,
                getModel: () => modelRef.current,
                getEnvironment: () => environmentRef.current,
                getActiveRequestNames: () => activeRequestNamesRef.current,
                getBracketIndentation: () => bracketIndentationRef.current,
                save: () => saveRef.current(),
                sendCurrent: () => sendCurrentRef.current(),
                openLink: (target) => {
                    void window.officeDesktop.openMarkdownLink(session.id, target).catch((reason: unknown) => {
                        setLoadError(reason instanceof Error ? reason.message : String(reason));
                    });
                },
                onChange: (text) => {
                    sourceRef.current = text;
                    setSource(text);
                },
                onNavigate: (message) => setStatusMessage(message),
            }),
        });
        editorRef.current = new EditorView({ state, parent: editorContainerRef.current });
        return () => {
            editorRef.current?.destroy();
            editorRef.current = null;
        };
    }, [loading, session.id, session.readOnly]);

    useEffect(() => {
        editorRef.current?.dispatch({});
    }, [addBracketIndentation, currentEnvironment, languageModel]);

    const copyResponse = useCallback(async () => {
        if (!activeResponse) return;
        await navigator.clipboard.writeText(activeResponse.body);
        setStatusMessage('响应正文已复制');
    }, [activeResponse]);

    const saveResponse = useCallback(async () => {
        if (!activeResponse) return;
        const extension = extensionForContentType(activeResponse.contentType);
        const result = await window.officeDesktop.saveFileAs(null, activeResponse.bodyBytes, `Response-${Date.now()}${extension ? `.${extension}` : ''}`);
        if (result) setStatusMessage(`响应已保存到 ${result.session.path}`);
    }, [activeResponse]);

    const insertTemplate = useCallback((templateName: keyof typeof HTTP_TEMPLATES) => {
        const view = editorRef.current;
        const template = HTTP_TEMPLATES[templateName];
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: template }, selection: { anchor: from + template.length }, scrollIntoView: true });
        view.focus();
    }, []);

    if (loadError && !source && !loading) {
        return <div className="http-client-error" role="alert"><strong>HTTP 文档无法打开</strong><span>{loadError}</span></div>;
    }

    return (
        <div className={`http-client ${previewColumn === 'current' && responseFocused ? 'http-client--response-focused' : ''}`} data-testid="desktop-http-viewer">
            <header className="http-client__toolbar">
                <span className="http-client__title">HTTP Client</span>
                <button type="button" onClick={() => void save()} disabled={source === savedSource}>{session.readOnly ? '另存为' : '保存'}</button>
                <select aria-label="插入 HTTP 模板" defaultValue="" disabled={session.readOnly} onChange={(event) => {
                    const value = event.target.value as keyof typeof HTTP_TEMPLATES | '';
                    if (value) insertTemplate(value);
                    event.target.value = '';
                }}>
                    <option value="" disabled>插入模板…</option>
                    <option value="get">GET</option><option value="post">POST</option><option value="put">PUT</option>
                    <option value="delete">DELETE</option><option value="graphql">GraphQL</option><option value="soap">SOAP</option>
                    <option value="fileVariable">文件变量</option><option value="requestName">命名请求</option><option value="confirmation">发送确认</option>
                </select>
                <button type="button" aria-pressed={showOutline} onClick={() => setShowOutline((current) => !current)}>大纲</button>
                <select aria-label="响应预览" value={previewOption} onChange={(event) => setPreviewOption(event.target.value as DesktopHttpPreviewOption)}>
                    <option value="body">Body</option><option value="full">Full</option><option value="headers">Headers</option><option value="exchange">Exchange</option>
                </select>
                <select aria-label="HTTP 环境" value={activeEnvironment} onChange={(event) => setActiveEnvironment(event.target.value)}>
                    {environmentNames.length === 0 && <option value="local">local</option>}
                    {environmentNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                <button type="button" aria-expanded={showSettings} onClick={() => setShowSettings((current) => !current)}>环境与设置</button>
                {runningId && <button className="http-client__cancel" type="button" onClick={() => void window.officeDesktop.cancelHttpRequest(runningId)}>取消</button>}
            </header>

            {showSettings && (
                <section className="http-client__settings" aria-label="HTTP 环境与设置">
                    <label><span>环境变量（加密保存在本机）</span><textarea value={environmentSource} onChange={(event) => setEnvironmentSource(event.target.value)} spellCheck={false} /></label>
                    {!environmentConfig.ok && <p role="alert">{environmentConfig.error}</p>}
                    <div className="http-client__settings-grid">
                        <label><input type="checkbox" checked={followRedirect} onChange={(event) => setFollowRedirect(event.target.checked)} /> 跟随重定向</label>
                        <label><input type="checkbox" checked={allowPrivateNetwork} onChange={(event) => setAllowPrivateNetwork(event.target.checked)} /> 允许本地/私有网络</label>
                        <label><input type="checkbox" checked={decodeEscapedUnicode} onChange={(event) => setDecodeEscapedUnicode(event.target.checked)} /> 解码转义 Unicode</label>
                        <label><input type="checkbox" checked={addBracketIndentation} onChange={(event) => setAddBracketIndentation(event.target.checked)} /> 请求体括号自动缩进</label>
                        <label><input type="checkbox" checked={enableVariableCodeLens} onChange={(event) => setEnableVariableCodeLens(event.target.checked)} /> 显示变量引用 CodeLens</label>
                        <label>预览列<select value={previewColumn} onChange={(event) => setPreviewColumn(event.target.value as typeof previewColumn)}><option value="beside">Beside（分栏）</option><option value="current">Current（当前面板）</option></select></label>
                        <label>超时（秒）<input type="number" min={1} max={120} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(clamp(Number(event.target.value), 1, 120))} /></label>
                        <label>表单编码<select value={formParamEncoding} onChange={(event) => setFormParamEncoding(event.target.value as typeof formParamEncoding)}><option value="automatic">Automatic</option><option value="never">Never</option><option value="always">Always</option></select></label>
                        <label>日志级别<select value={logLevel} onChange={(event) => setLogLevel(event.target.value as typeof logLevel)}><option value="error">Error</option><option value="warn">Warn</option><option value="info">Info</option><option value="verbose">Verbose</option></select></label>
                    </div>
                    <small>桌面单窗口中，“Beside”映射为请求/响应分栏，“Current”映射为发送后在当前面板显示响应。跨域重定向会移除敏感认证头。</small>
                </section>
            )}

            <div className="http-client__workspace">
                <section className="http-client__editor-pane" aria-label="HTTP 请求编辑器">
                    <div className="http-client__editor-grid">
                        {showOutline && <aside className="http-client__outline" aria-label="HTTP 大纲">
                            <strong>OUTLINE</strong>
                            {languageModel.symbols.length ? languageModel.symbols.map((symbol, index) => <button key={`${symbol.from}-${index}`} type="button" onClick={() => selectRange(editorRef.current, symbol)}>
                                <span>{symbol.kind === 'request' ? '◇' : '@'}</span>{symbol.name}<small>{symbol.detail}</small>
                            </button>) : <p>没有可显示的符号</p>}
                        </aside>}
                        <div className="http-client__source" aria-label="HTTP 文档源码" ref={editorContainerRef} />
                    </div>
                    <div className="http-client__code-lenses" aria-label="HTTP CodeLens">
                        {blocks.length === 0 ? <span>输入 HTTP 请求或 cURL 命令</span> : blocks.map((block) => (
                            <div key={`${block.startLine}-${block.index}`} className="http-client__code-lens">
                                <span>L{block.startLine + 1} · {block.name || `${block.method} ${block.url}`}</span>
                                <button type="button" onClick={() => void send(block)} disabled={Boolean(runningId)}>▶ Send</button>
                                <button type="button" onClick={() => void copyAsCurl(block)}>Copy as cURL</button>
                            </div>
                        ))}
                        {enableVariableCodeLens && Object.values(languageModel.definitions).map((definition) => <div key={definition.name} className="http-client__code-lens http-client__code-lens--reference">
                            <span>@{definition.name}</span><button type="button" onClick={() => showReferences(editorRef.current, definition.references, definition.name, setStatusMessage)}>{definition.references.length} reference{definition.references.length === 1 ? '' : 's'}</button>
                        </div>)}
                    </div>
                    {showProblems && languageModel.diagnostics.length > 0 && <div className="http-client__problems" aria-label="HTTP 诊断">
                        <header><strong>PROBLEMS ({languageModel.diagnostics.length})</strong><button type="button" onClick={() => setShowProblems(false)}>×</button></header>
                        {languageModel.diagnostics.map((diagnostic, index) => <button key={`${diagnostic.from}-${index}`} type="button" onClick={() => selectRange(editorRef.current, diagnostic)}>
                            <span className={`is-${diagnostic.severity}`}>{diagnostic.severity === 'error' ? '●' : 'ℹ'}</span>{diagnostic.message}<small>Line {diagnostic.line + 1}</small>
                        </button>)}
                    </div>}
                    {!showProblems && languageModel.diagnostics.length > 0 && <button className="http-client__show-problems" type="button" onClick={() => setShowProblems(true)}>显示 {languageModel.diagnostics.length} 个问题</button>}
                </section>

                <section className="http-client__response-pane" aria-label="HTTP 响应">
                    <div className="http-client__response-toolbar">
                        {previewColumn === 'current' && responseFocused && <button type="button" onClick={() => setResponseFocused(false)}>← 返回请求</button>}
                        <strong>Response</strong>
                        <span>{activeResponse ? `${activeResponse.statusCode} · ${activeResponse.elapsedMs} ms` : '尚未发送请求'}</span>
                        <button type="button" disabled={!activeResponse} onClick={() => void copyResponse()}>复制正文</button>
                        <button type="button" disabled={!activeResponse} onClick={() => void saveResponse()}>保存响应</button>
                    </div>
                    {responses.length > 1 && <div className="http-client__history" aria-label="响应历史">
                        {responses.map((response, index) => <button type="button" className={response.requestId === activeResponse?.requestId ? 'is-active' : ''} key={response.requestId} onClick={() => setActiveResponseId(response.requestId)}>{index + 1}. {response.request.name || response.request.method} · {response.statusCode}</button>)}
                    </div>}
                    <pre className="http-client__response">{activeResponse?.preview ?? '点击请求上方的 “Send”，或在请求中按 Ctrl+Enter。'}</pre>
                </section>
            </div>

            {loadError && <div className="http-client__inline-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => setLoadError(undefined)}>×</button></div>}
            <footer className="http-client__status"><span>{statusMessage}</span>{logLevel !== 'error' && <span>日志：{logLevel}{logLevel === 'verbose' ? ` · ${blocks.length} requests · ${languageModel.symbols.length} symbols` : ''}</span>}</footer>
        </div>
    );
}

interface EditorExtensionOptions {
    readonly readOnly: boolean;
    readonly getModel: () => DesktopHttpLanguageModel;
    readonly getEnvironment: () => Readonly<Record<string, string>>;
    readonly getActiveRequestNames: () => ReadonlySet<string>;
    readonly getBracketIndentation: () => boolean;
    readonly save: () => void;
    readonly sendCurrent: () => void;
    readonly openLink: (target: string) => void;
    readonly onChange: (text: string) => void;
    readonly onNavigate: (message: string) => void;
}

function createEditorExtensions(options: EditorExtensionOptions): Extension[] {
    let referenceIndex = 0;
    const jumpToDefinition = (view: EditorView) => {
        const token = findDesktopHttpToken(options.getModel(), view.state.selection.main.head);
        if (!token) return false;
        selectRange(view, token.definition);
        options.onNavigate(`已转到 ${token.kind === 'request' ? '请求' : '文件'}变量 ${token.name} 的定义`);
        return true;
    };
    const jumpToReference = (view: EditorView) => {
        const token = findDesktopHttpToken(options.getModel(), view.state.selection.main.head);
        if (!token || token.references.length === 0) return false;
        referenceIndex = (referenceIndex + 1) % token.references.length;
        selectRange(view, token.references[referenceIndex]);
        options.onNavigate(`${token.name}: ${referenceIndex + 1}/${token.references.length} references`);
        return true;
    };
    const completionSource = (context: CompletionContext) => {
        const text = context.state.doc.toString();
        const word = context.matchBefore(/[\w$-]*/);
        if (!word || (!context.explicit && word.from === word.to && !/\{\{[^}]*$/.test(text.slice(0, context.pos)))) return null;
        return {
            from: word.from,
            options: getDesktopHttpCompletions(text, context.pos, options.getEnvironment(), options.getModel()).map((item) => ({
                label: item.label, detail: item.detail, type: item.type, apply: item.apply,
            })),
        };
    };
    return [
        lineNumbers(), history(), bracketMatching(), closeBrackets(), httpLanguage,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        autocompletion({ override: [completionSource], activateOnTyping: true }),
        keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { options.save(); return true; } },
            { key: 'Mod-Enter', preventDefault: true, run: () => { options.sendCurrent(); return true; } },
            { key: 'F12', run: jumpToDefinition },
            { key: 'Shift-F12', run: jumpToReference },
            { key: 'Enter', run: (view) => insertBracketLineBreak(view, options.getBracketIndentation()) },
            indentWithTab, ...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap,
        ]),
        EditorState.readOnly.of(options.readOnly), EditorView.editable.of(!options.readOnly),
        EditorView.lineWrapping, httpEditorTheme,
        EditorView.updateListener.of((update) => {
            if (update.docChanged) options.onChange(update.state.doc.toString());
        }),
        diagnosticAndLinkPlugin(options),
        hoverTooltip((view, position) => createHoverTooltip(view, position, options)),
        EditorView.domEventHandlers({
            mousedown(event, view) {
                if (!event.ctrlKey && !event.metaKey) return false;
                const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (position == null) return false;
                const link = options.getModel().links.find((candidate) => contains(candidate, position));
                if (link) {
                    event.preventDefault();
                    options.openLink(link.target);
                    return true;
                }
                view.dispatch({ selection: { anchor: position } });
                event.preventDefault();
                return jumpToDefinition(view);
            },
        }),
    ];
}

function insertBracketLineBreak(view: EditorView, enabled: boolean) {
    if (!enabled || view.state.readOnly) return false;
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const before = view.state.sliceDoc(Math.max(0, selection.head - 1), selection.head);
    const after = view.state.sliceDoc(selection.head, Math.min(view.state.doc.length, selection.head + 1));
    if (!(['{}', '[]', '<>'].includes(`${before}${after}`))) return false;
    const line = view.state.doc.lineAt(selection.head);
    const indentation = /^\s*/.exec(line.text)?.[0] ?? '';
    const insert = `\n${indentation}  \n${indentation}`;
    view.dispatch({ changes: { from: selection.head, insert }, selection: { anchor: selection.head + indentation.length + 3 }, scrollIntoView: true });
    return true;
}

function diagnosticAndLinkPlugin(options: EditorExtensionOptions) {
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet;
        constructor(view: EditorView) { this.decorations = buildDecorations(view, options); }
        update(update: ViewUpdate) { this.decorations = buildDecorations(update.view, options); }
    }, { decorations: (value) => value.decorations });
}

function buildDecorations(view: EditorView, options: EditorExtensionOptions): DecorationSet {
    const model = parseDesktopHttpLanguage(view.state.doc.toString(), options.getEnvironment(), options.getActiveRequestNames());
    const ranges = [
        ...model.links.map((item) => Decoration.mark({ class: 'cm-http-link', attributes: { title: `Ctrl+Click 打开 ${item.target}` } }).range(item.from, item.to)),
        ...model.diagnostics.map((item) => Decoration.mark({ class: `cm-http-diagnostic cm-http-diagnostic--${item.severity}`, attributes: { title: item.message } }).range(item.from, item.to)),
    ].sort((left, right) => left.from - right.from || left.to - right.to);
    return Decoration.set(ranges);
}

function createHoverTooltip(view: EditorView, position: number, options: EditorExtensionOptions) {
    const model = options.getModel();
    const diagnostic = model.diagnostics.find((candidate) => contains(candidate, position));
    const token = findDesktopHttpToken(model, position);
    const link = model.links.find((candidate) => contains(candidate, position));
    if (!diagnostic && !token && !link) return null;
    const range = diagnostic ?? token?.definition ?? link!;
    return {
        pos: range.from, end: range.to, above: true,
        create() {
            const dom = document.createElement('div');
            dom.className = 'cm-http-hover';
            if (diagnostic) dom.append(textLine(diagnostic.severity === 'error' ? 'Error' : 'Information', diagnostic.message));
            if (token) {
                const value = token.kind === 'file' ? token.definition.value : `${token.references.length} references`;
                dom.append(textLine(token.kind === 'file' ? 'File Variable' : 'Request Variable', `${token.name} = ${value}`));
            }
            if (link) dom.append(textLine('Document Link', link.target));
            return { dom };
        },
    };
}

function textLine(label: string, value: string) {
    const line = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    line.append(strong, document.createTextNode(value));
    return line;
}

const httpEditorTheme = EditorView.theme({
    '&': { height: '100%', background: 'transparent', color: 'inherit' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--vscode-editor-font-family, Consolas, "Cascadia Code", monospace)', fontSize: '13px', lineHeight: '1.58' },
    '.cm-content': { padding: '14px 0', caretColor: '#3794ff' },
    '.cm-gutters': { background: 'color-mix(in srgb, currentColor 3%, transparent)', color: 'var(--http-muted)', borderRight: '1px solid var(--http-border)' },
    '.cm-activeLine, .cm-activeLineGutter': { background: 'color-mix(in srgb, #1684ff 8%, transparent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'color-mix(in srgb, #1684ff 28%, transparent) !important' },
    '.cm-cursor': { borderLeftColor: '#3794ff' },
    '.cm-tooltip': { background: 'var(--vscode-editor-background, #252526)', color: 'inherit', border: '1px solid var(--http-border)' },
});

const httpParser: StreamParser<null> = {
    startState: () => null,
    token(stream: StringStream) {
        if (stream.sol() && stream.match(/\s*(?:#|\/\/).*/)) return /@(?:name|note)/i.test(stream.current()) ? 'meta' : 'comment';
        if (stream.sol() && stream.match(/\s*@[\w.-]+(?=\s*=)/)) return 'variableName.definition';
        if (stream.match(/\{\{[^}]+\}\}/)) return 'variableName';
        if (stream.sol() && stream.match(/\s*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\b/i)) return 'keyword';
        if (stream.sol() && stream.match(/\s*[\w-]+(?=\s*:)/)) return 'propertyName';
        if (stream.match(/https?:\/\/[^\s]+/i)) return 'url';
        if (stream.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/)) return 'string';
        if (stream.match(/\b\d+(?:\.\d+)?\b/)) return 'number';
        if (stream.match(/[{}\[\]():,]/)) return 'punctuation';
        stream.next(); return null;
    },
    languageData: { commentTokens: { line: '#' }, closeBrackets: { brackets: ['(', '[', '{', '"'] } },
};
const httpLanguage = StreamLanguage.define(httpParser);

function discoverRequestBlocks(source: string): RequestBlock[] {
    const lines = source.split(/\r?\n/);
    const delimiters = lines.flatMap((line, index) => /^#{3,}/.test(line) ? [index] : []);
    const boundaries = [-1, ...delimiters, lines.length];
    const blocks: RequestBlock[] = [];
    for (let cursor = 0; cursor < boundaries.length - 1; cursor++) {
        const from = boundaries[cursor] + 1;
        const to = boundaries[cursor + 1] - 1;
        const section = lines.slice(from, to + 1);
        const offset = section.findIndex((line) => /^(?:(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+|curl(?:\s|$)|https?:\/\/)/i.test(line.trim()));
        if (offset < 0) continue;
        let last = section.length - 1;
        while (last >= offset && section[last].trim() === '') last--;
        const text = section.slice(offset, last + 1).filter((line) => !/^\s*(?:#|\/\/)/.test(line)).join('\n');
        const first = text.split(/\r?\n/, 1)[0].trim();
        const match = first.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(.+?)(?:\s+HTTP\/[\d.]+)?$/i);
        blocks.push({
            index: blocks.length, startLine: from + offset, endLine: from + last,
            name: section.slice(0, offset).map((line) => line.match(/^\s*(?:#|\/{2})+\s*@name\s+(\w+)/i)?.[1]).find(Boolean),
            warnBeforeSend: section.slice(0, offset).some((line) => /^\s*(?:#|\/{2})+\s*@note\s*$/i.test(line)),
            method: match?.[1]?.toUpperCase() ?? (first.toLowerCase().startsWith('curl') ? 'cURL' : 'GET'),
            url: match?.[2] ?? first.replace(/^curl\s+/i, '').slice(0, 120), text,
        });
    }
    return blocks;
}

type EnvironmentParseResult = { ok: true; environments: Record<string, Record<string, string>> } | { ok: false; error: string };

function parseEnvironmentConfig(source: string): EnvironmentParseResult {
    try {
        const value = JSON.parse(source) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('根必须是对象');
        const environments: Record<string, Record<string, string>> = {};
        for (const [environmentName, rawVariables] of Object.entries(value)) {
            if (!rawVariables || typeof rawVariables !== 'object' || Array.isArray(rawVariables)) throw new Error(`${environmentName} 必须是对象`);
            const variables: Record<string, string> = {};
            for (const [name, rawValue] of Object.entries(rawVariables)) {
                if (typeof rawValue !== 'string') throw new Error(`${environmentName}.${name} 必须是字符串`);
                variables[name] = rawValue;
            }
            environments[environmentName] = variables;
        }
        return { ok: true, environments };
    } catch (reason) {
        return { ok: false, error: `环境变量 JSON 无效：${reason instanceof Error ? reason.message : String(reason)}` };
    }
}

function applySettings(settings: DesktopHttpSettings, setters: {
    setFollowRedirect: (value: boolean) => void; setEnvironmentSource: (value: string) => void;
    setPreviewOption: (value: DesktopHttpPreviewOption) => void; setPreviewColumn: (value: 'current' | 'beside') => void;
    setFormParamEncoding: (value: 'automatic' | 'never' | 'always') => void; setAddBracketIndentation: (value: boolean) => void;
    setDecodeEscapedUnicode: (value: boolean) => void; setLogLevel: (value: 'error' | 'warn' | 'info' | 'verbose') => void;
    setEnableVariableCodeLens: (value: boolean) => void; setTimeoutSeconds: (value: number) => void;
    setAllowPrivateNetwork: (value: boolean) => void; setActiveEnvironment: (value: string) => void;
}) {
    setters.setFollowRedirect(settings.followRedirect); setters.setEnvironmentSource(settings.environmentSource);
    setters.setPreviewOption(settings.previewOption); setters.setPreviewColumn(settings.previewColumn);
    setters.setFormParamEncoding(settings.formParamEncodingStrategy); setters.setAddBracketIndentation(settings.addRequestBodyLineIndentationAroundBrackets);
    setters.setDecodeEscapedUnicode(settings.decodeEscapedUnicodeCharacters); setters.setLogLevel(settings.logLevel);
    setters.setEnableVariableCodeLens(settings.enableCustomVariableReferencesCodeLens); setters.setTimeoutSeconds(settings.timeoutSeconds);
    setters.setAllowPrivateNetwork(settings.allowPrivateNetwork); setters.setActiveEnvironment(settings.activeEnvironment);
}

function selectRange(view: EditorView | null, range: DesktopHttpRange) {
    if (!view) return;
    view.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
    view.focus();
}

function showReferences(view: EditorView | null, references: readonly DesktopHttpRange[], name: string, setStatus: (value: string) => void) {
    if (!view || references.length === 0) { setStatus(`${name}: 0 references`); return; }
    selectRange(view, references[0]);
    setStatus(`${name}: ${references.length} reference${references.length === 1 ? '' : 's'} · Shift+F12 继续`);
}

function contains(range: DesktopHttpRange, offset: number) { return offset >= range.from && offset <= range.to; }

function toCurl(request: string): string {
    if (/^\s*curl(?:\s|$)/i.test(request)) return request.trim();
    const lines = request.split(/\r?\n/);
    const first = lines.shift()?.trim() ?? '';
    const match = first.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(.+?)(?:\s+HTTP\/[\d.]+)?$/i);
    if (!match) return `curl '${escapeShell(first)}'`;
    const parts = [`curl -X ${match[1].toUpperCase()}`];
    while (lines.length > 0 && lines[0].trim() !== '') parts.push(`-H '${escapeShell(lines.shift()!.trim())}'`);
    if (lines[0]?.trim() === '') lines.shift();
    const body = lines.join('\n');
    if (body) parts.push(`--data-raw '${escapeShell(body)}'`);
    parts.push(`'${escapeShell(match[2])}'`);
    return parts.join(' ');
}

function escapeShell(value: string): string { return value.replace(/'/g, `'"'"'`); }

function extensionForContentType(contentType?: string): string | undefined {
    const normalized = contentType?.toLowerCase() ?? '';
    if (normalized.includes('json')) return 'json'; if (normalized.includes('html')) return 'html';
    if (normalized.includes('xml')) return 'xml'; if (normalized.includes('javascript')) return 'js';
    if (normalized.includes('css')) return 'css'; if (normalized.includes('png')) return 'png';
    if (normalized.includes('jpeg')) return 'jpg'; if (normalized.includes('pdf')) return 'pdf';
    if (normalized.startsWith('text/')) return 'txt'; return undefined;
}

function clamp(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min; }

const HTTP_TEMPLATES = {
    get: 'GET https://example.com HTTP/1.1',
    post: 'POST https://example.com HTTP/1.1\nContent-Type: application/json\n\n{\n  "key": "value"\n}',
    put: 'PUT https://example.com HTTP/1.1\nContent-Type: application/json\n\n{\n  "key": "value"\n}',
    delete: 'DELETE https://example.com HTTP/1.1',
    graphql: 'POST https://example.com/graphql HTTP/1.1\nX-Request-Type: GraphQL\nContent-Type: application/json\n\nquery {\n  __typename\n}\n\n{}',
    soap: 'POST https://example.com HTTP/1.1\nContent-Type: application/soap+xml\n\n<soap:Envelope xmlns:soap="http://www.w3.org/2001/12/soap-envelope">\n  <soap:Body>\n  </soap:Body>\n</soap:Envelope>',
    fileVariable: '@Variable_Name = Variable_Value', requestName: '# @name Request_Name', confirmation: '# @note',
} as const;
