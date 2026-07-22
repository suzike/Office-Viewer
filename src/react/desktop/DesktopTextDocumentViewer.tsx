import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    clearSnippet,
    completionKeymap,
    nextSnippetField,
    prevSnippetField,
    snippet,
    snippetCompletion,
    snippetKeymap,
    type CompletionContext,
} from '@codemirror/autocomplete';
import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    toggleComment,
} from '@codemirror/commands';
import {
    bracketMatching,
    defaultHighlightStyle,
    indentUnit,
    StreamLanguage,
    syntaxHighlighting,
    type LanguageSupport,
    type StreamParser,
    type StringStream,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
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
import {
    findYamlAliasAtOffset,
    formatXmlText,
    getDesktopTextSnippets,
    parseYamlDesktopModel,
    resolveDesktopTextLanguage,
    type DesktopTextLanguage,
    type YamlDesktopModel,
    type YamlOutlineSymbol,
} from '../../../desktop/shared/text-language';
import './DesktopTextDocumentViewer.css';

interface Props {
    session: DesktopFileSession;
    onDirtyChange?: (dirty: boolean) => void;
    onSessionReplaced?: (session: DesktopFileSession) => void;
}

const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const EMPTY_YAML_MODEL: YamlDesktopModel = { symbols: [], anchors: {}, aliases: [] };
const LANGUAGE_NAMES: Partial<Record<DesktopTextLanguage, string>> = {
    kotlin: 'Kotlin', nginx: 'Nginx', toml: 'TOML', xml: 'XML', yaml: 'YAML',
};

const textEditorTheme = EditorView.theme({
    '&': { height: '100%', color: 'var(--ink)', background: 'var(--paper-raised)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: '13px', lineHeight: '1.58' },
    '.cm-content': { padding: '12px 0', caretColor: 'var(--accent)' },
    '.cm-gutters': { background: 'var(--paper)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
    '.cm-activeLine, .cm-activeLineGutter': { background: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'color-mix(in srgb, var(--accent) 28%, transparent) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-matchingBracket': { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', outline: '1px solid var(--accent)' },
    '.cm-tooltip': { background: 'var(--paper-raised)', color: 'var(--ink)', border: '1px solid var(--line)' },
}, { dark: false });

export default function DesktopTextDocumentViewer({ session, onDirtyChange, onSessionReplaced }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const baselineRef = useRef('');
    const dirtyRef = useRef(false);
    const yamlModelRef = useRef<YamlDesktopModel>(EMPTY_YAML_MODEL);
    const outlineTimerRef = useRef<number | undefined>(undefined);
    const indentCompartmentRef = useRef(new Compartment());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>();
    const [indent, setIndent] = useState('  ');
    const [yamlModel, setYamlModel] = useState<YamlDesktopModel>(EMPTY_YAML_MODEL);
    const [selectedAlias, setSelectedAlias] = useState<string>();
    const language = useMemo(() => resolveDesktopTextLanguage(session.name, session.extension), [session.extension, session.name]);
    const snippets = useMemo(() => getDesktopTextSnippets(language), [language]);

    const updateYamlModel = useCallback((text: string) => {
        if (language !== 'yaml') return;
        window.clearTimeout(outlineTimerRef.current);
        outlineTimerRef.current = window.setTimeout(() => {
            const model = parseYamlDesktopModel(text);
            yamlModelRef.current = model;
            setYamlModel(model);
        }, 100);
    }, [language]);

    const setDirty = useCallback((dirty: boolean) => {
        if (dirtyRef.current === dirty) return;
        dirtyRef.current = dirty;
        onDirtyChange?.(dirty);
    }, [onDirtyChange]);

    const jumpToAnchor = useCallback((offset?: number) => {
        const view = viewRef.current;
        if (!view) return false;
        const position = offset ?? view.state.selection.main.head;
        const alias = findYamlAliasAtOffset(position, yamlModelRef.current.aliases);
        const anchor = alias ? yamlModelRef.current.anchors[alias.source] : undefined;
        if (!anchor) return false;
        view.dispatch({ selection: { anchor: anchor.from, head: anchor.to }, scrollIntoView: true });
        view.focus();
        return true;
    }, []);

    const save = useCallback(async () => {
        const view = viewRef.current;
        if (!view) return;
        try {
            const text = view.state.doc.toString();
            const bytes = new TextEncoder().encode(text);
            const result = session.readOnly
                ? await window.officeDesktop.saveFileAs(session.id, bytes, session.name)
                : await window.officeDesktop.saveFile(session.id, bytes);
            if (!result) return;
            baselineRef.current = text;
            setDirty(false);
            onSessionReplaced?.(result.session);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }, [onSessionReplaced, session, setDirty]);

    useEffect(() => {
        let disposed = false;
        const initialize = async () => {
            try {
                setLoading(true);
                setError(undefined);
                if (session.byteLength > MAX_TEXT_BYTES) throw new Error('文本文件超过 32 MB 安全编辑上限。');
                const [buffer, languageExtension] = await Promise.all([
                    window.officeDesktop.readFile(session.id),
                    loadLanguage(language),
                ]);
                if (disposed || !containerRef.current) return;
                if (buffer.byteLength > MAX_TEXT_BYTES) throw new Error('文本文件超过 32 MB 安全编辑上限。');
                const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
                baselineRef.current = text;
                const initialYaml = language === 'yaml' ? parseYamlDesktopModel(text) : EMPTY_YAML_MODEL;
                yamlModelRef.current = initialYaml;
                setYamlModel(initialYaml);

                const completionSource = (context: CompletionContext) => {
                    const word = context.matchBefore(/[\w-]*/);
                    if (!word || (!context.explicit && word.from === word.to)) return null;
                    return {
                        from: word.from,
                        options: snippets.map((item) => snippetCompletion(item.template, {
                            label: item.label, detail: item.detail, type: 'keyword',
                        })),
                    };
                };
                const updateListener = EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        const current = update.state.doc.toString();
                        setDirty(current !== baselineRef.current);
                        updateYamlModel(current);
                    }
                    if (update.selectionSet && language === 'yaml') {
                        const alias = findYamlAliasAtOffset(update.state.selection.main.head, yamlModelRef.current.aliases);
                        setSelectedAlias(alias?.source);
                    }
                });
                const state = EditorState.create({
                    doc: text,
                    extensions: [
                        lineNumbers(), highlightSpecialChars(), highlightActiveLineGutter(), highlightActiveLine(),
                        history(), bracketMatching(), closeBrackets(),
                        snippetKeymap.of([
                            { key: 'Tab', run: nextSnippetField, shift: prevSnippetField },
                            { key: 'Escape', run: clearSnippet },
                        ]),
                        keymap.of([
                            { key: 'Mod-s', preventDefault: true, run: () => { void save(); return true; } },
                            { key: 'Mod-/', run: toggleComment },
                            { key: 'F12', run: () => jumpToAnchor() },
                            indentWithTab, ...closeBracketsKeymap, ...completionKeymap,
                            ...defaultKeymap, ...historyKeymap,
                        ]),
                        autocompletion({ override: snippets.length ? [completionSource] : undefined }),
                        indentCompartmentRef.current.of(indentUnit.of(indent)),
                        EditorState.readOnly.of(session.readOnly),
                        EditorView.editable.of(!session.readOnly),
                        EditorView.lineWrapping,
                        EditorView.domEventHandlers({
                            mousedown(event, view) {
                                if (language !== 'yaml' || (!event.ctrlKey && !event.metaKey)) return false;
                                const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
                                return position == null ? false : jumpToAnchor(position);
                            },
                        }),
                        languageExtension, textEditorTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                        updateListener,
                    ],
                });
                viewRef.current = new EditorView({ state, parent: containerRef.current });
                setDirty(false);
                setLoading(false);
            } catch (reason) {
                if (!disposed) {
                    setError(reason instanceof Error ? reason.message : String(reason));
                    setLoading(false);
                }
            }
        };
        void initialize();
        return () => {
            disposed = true;
            window.clearTimeout(outlineTimerRef.current);
            viewRef.current?.destroy();
            viewRef.current = null;
        };
    }, [jumpToAnchor, language, save, session.byteLength, session.id, session.readOnly, setDirty, snippets, updateYamlModel]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: indentCompartmentRef.current.reconfigure(indentUnit.of(indent)) });
    }, [indent]);

    const formatXml = (selectionOnly: boolean) => {
        const view = viewRef.current;
        if (!view || language !== 'xml' || session.readOnly) return;
        const selection = view.state.selection.main;
        const from = selectionOnly && !selection.empty ? selection.from : 0;
        const to = selectionOnly && !selection.empty ? selection.to : view.state.doc.length;
        const source = view.state.sliceDoc(from, to);
        const formatted = formatXmlText(source, indent);
        if (formatted === source) return;
        view.dispatch({ changes: { from, to, insert: formatted }, selection: { anchor: from, head: from + formatted.length }, scrollIntoView: true });
        view.focus();
    };

    const insertSnippet = (template: string) => {
        const view = viewRef.current;
        if (!view || session.readOnly) return;
        const selection = view.state.selection.main;
        snippet(template)({ state: view.state, dispatch: view.dispatch }, null, selection.from, selection.to);
        view.focus();
    };

    return (
        <section className="desktop-text-viewer" data-language={language}>
            <header className="desktop-text-toolbar">
                <strong>{language.toUpperCase()}</strong>
                <span>{session.name}</span>
                <button type="button" onClick={() => void save()}>{session.readOnly ? '另存为' : '保存'}</button>
                {language === 'xml' && <button type="button" disabled={session.readOnly} onClick={() => formatXml(false)}>格式化全文</button>}
                {language === 'xml' && <button type="button" disabled={session.readOnly} onClick={() => formatXml(true)}>格式化选区</button>}
                <label>缩进
                    <select value={indent} onChange={(event) => setIndent(event.target.value)}>
                        <option value="  ">2 空格</option><option value="    ">4 空格</option><option value={'\t'}>Tab</option>
                    </select>
                </label>
                {snippets.length > 0 && (
                    <select aria-label="插入模板" defaultValue="" disabled={session.readOnly} onChange={(event) => {
                        const selected = snippets.find((item) => item.label === event.target.value);
                        if (selected) insertSnippet(selected.template);
                        event.target.value = '';
                    }}>
                        <option value="">插入模板…</option>
                        {snippets.map((item) => <option key={item.label} value={item.label}>{item.label}</option>)}
                    </select>
                )}
                <span className="desktop-text-toolbar__spacer" />
                <span>{session.readOnly ? '只读' : 'UTF-8'}</span>
            </header>
            {error && <Alert className="desktop-text-error" type="error" showIcon message="文本无法打开" description={error} />}
            <div className="desktop-text-body">
                {language === 'yaml' && (
                    <aside className="desktop-yaml-outline" aria-label="YAML 大纲">
                        <h2>YAML 大纲</h2>
                        {yamlModel.symbols.length
                            ? <YamlOutline symbols={yamlModel.symbols} onSelect={(symbol) => selectSymbol(viewRef.current, symbol)} />
                            : <p>没有可显示的结构</p>}
                    </aside>
                )}
                <div className="desktop-text-editor" ref={containerRef} />
                {loading && <Spin fullscreen tip={`正在载入 ${session.name}`} />}
            </div>
            {language === 'yaml' && selectedAlias && (
                <footer className="desktop-yaml-reference">
                    别名 <code>*{selectedAlias}</code>
                    {yamlModel.anchors[selectedAlias]
                        ? <button type="button" onClick={() => jumpToAnchor()}>转到 &amp;{selectedAlias}</button>
                        : <span>未找到对应锚点</span>}
                </footer>
            )}
        </section>
    );
}

function YamlOutline({ symbols, onSelect }: { symbols: readonly YamlOutlineSymbol[]; onSelect: (symbol: YamlOutlineSymbol) => void }) {
    return <ul>{symbols.map((symbol, index) => (
        <li key={`${symbol.from}:${symbol.name}:${index}`}>
            <button type="button" onClick={() => onSelect(symbol)} title={symbol.kind}>{symbol.name}</button>
            {symbol.children.length > 0 && <YamlOutline symbols={symbol.children} onSelect={onSelect} />}
        </li>
    ))}</ul>;
}

function selectSymbol(view: EditorView | null, symbol: YamlOutlineSymbol) {
    if (!view) return;
    view.dispatch({ selection: { anchor: symbol.selectionFrom, head: symbol.selectionTo }, scrollIntoView: true });
    view.focus();
}

async function loadLanguage(language: DesktopTextLanguage): Promise<Extension> {
    if (language === 'kusto') return StreamLanguage.define(kustoParser);
    if (language === 'reg') return StreamLanguage.define(regParser);
    const name = LANGUAGE_NAMES[language];
    if (!name) return [];
    const description = languages.find((item) => item.name === name);
    if (!description) throw new Error(`缺少 ${name} 语法高亮支持。`);
    return description.load() as Promise<LanguageSupport>;
}

const kustoParser: StreamParser<null> = {
    startState: () => null,
    token(stream: StringStream) {
        if (stream.match(/\/\/.*$/)) return 'comment';
        if (stream.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/)) return 'string';
        if (stream.match(/\b(?:let|set|declare|alias|where|project|extend|summarize|join|union|render|by|on|in|and|or|not)\b/i)) return 'keyword';
        if (stream.match(/\b(?:true|false|null|datetime|timespan|dynamic|long|real|string|bool|int|guid)\b/i)) return 'atom';
        if (stream.match(/\b\d+(?:\.\d+)?\b/)) return 'number';
        if (stream.match(/[|=!<>+\-*\/]+/)) return 'operator';
        stream.next(); return null;
    },
    languageData: { commentTokens: { line: '//' }, closeBrackets: { brackets: ['(', '[', '{', "'", '"'] } },
};

const regParser: StreamParser<null> = {
    startState: () => null,
    token(stream: StringStream) {
        if (stream.sol() && stream.match(/Windows Registry Editor Version 5\.00|REGEDIT4/)) return 'keyword';
        if (stream.match(/;.*/)) return 'comment';
        if (stream.match(/\[[^\]]+\]/)) return 'heading';
        if (stream.match(/"(?:[^"\\]|\\.)*"/)) return 'string';
        if (stream.match(/\b(?:dword|hex(?:\([0-9a-f]+\))?):/i)) return 'typeName';
        if (stream.match(/\b[0-9a-f]{2}(?:,[0-9a-f]{2})*\b/i)) return 'number';
        stream.next(); return null;
    },
    languageData: { commentTokens: { line: ';' }, closeBrackets: { brackets: ['(', '[', '{', "'", '"'] } },
};
