import { Alert, Spin } from 'antd';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { java } from '@codemirror/lang-java';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers } from '@codemirror/view';
import { useEffect, useRef, useState } from 'react';
import type { DesktopFileSession } from '../../../desktop/shared/desktop-api';
import './DesktopJavaDocumentViewer.css';

const javaEditorTheme = EditorView.theme({
    '&': {
        color: 'var(--ink)',
        backgroundColor: 'var(--paper-raised)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
        fontFamily: 'var(--mono)',
        fontSize: '13px',
        lineHeight: '1.55',
    },
    '.cm-content': { padding: '14px 0' },
    '.cm-gutters': {
        color: 'var(--ink-muted)',
        backgroundColor: 'var(--paper)',
        borderRight: '1px solid var(--line)',
    },
    '.cm-activeLine, .cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--line) 24%, transparent)',
    },
    '.cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent) !important',
    },
});

function ReadonlyJavaSource({ source }: { source: string }) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const state = EditorState.create({
            doc: source,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightActiveLine(),
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
                java(),
                syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                javaEditorTheme,
            ],
        });
        const view = new EditorView({ state, parent: containerRef.current });
        return () => view.destroy();
    }, [source]);

    return <div className="desktop-java-viewer__editor" ref={containerRef} />;
}

export default function DesktopJavaDocumentViewer({ session }: { session: DesktopFileSession }) {
    const [source, setSource] = useState<string>();
    const [error, setError] = useState<string>();
    const [revision, setRevision] = useState(0);

    useEffect(() => window.officeDesktop.onFileChanged((event) => {
        if (event.sessionId === session.id) setRevision(value => value + 1);
    }), [session.id]);

    useEffect(() => {
        let disposed = false;
        setSource(undefined);
        setError(undefined);
        void window.officeDesktop.decompileClass(session.id).then((result) => {
            if (!disposed) setSource(result.source);
        }).catch((reason: unknown) => {
            if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        });
        return () => { disposed = true; };
    }, [revision, session.id]);

    if (error) return <Alert type="error" showIcon message="Java 反编译失败" description={error} />;
    if (source === undefined) return <Spin fullscreen tip="正在反编译 Java Class" />;
    return <div className="desktop-java-viewer"><ReadonlyJavaSource source={source} /></div>;
}
