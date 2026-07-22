import { Alert, Spin } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopFileSession } from '../../../desktop/shared/desktop-api';

interface Props {
    session: DesktopFileSession;
    onDirtyChange?: (dirty: boolean) => void;
    onSessionReplaced?: (session: DesktopFileSession) => void;
}

export default function DesktopHtmlDocumentViewer({ session, onDirtyChange, onSessionReplaced }: Props) {
    const [loading, setLoading] = useState(true);
    const [version, setVersion] = useState(0);
    const [sourceVisible, setSourceVisible] = useState(false);
    const [source, setSource] = useState('');
    const [baseline, setBaseline] = useState('');
    const [error, setError] = useState<string>();
    const sourceRef = useRef(source);
    sourceRef.current = source;

    useEffect(() => {
        let disposed = false;
        void window.officeDesktop.readFile(session.id).then((buffer) => {
            if (disposed) return;
            const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
            setSource(text);
            setBaseline(text);
            onDirtyChange?.(false);
        }).catch((reason: unknown) => {
            if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        });
        return () => { disposed = true; };
    }, [onDirtyChange, session.id]);

    useEffect(() => window.officeDesktop.onFileChanged((event) => {
        if (event.sessionId === session.id) {
            setLoading(true);
            setVersion(value => value + 1);
        }
    }), [session.id]);

    const save = useCallback(async () => {
        try {
            const bytes = new TextEncoder().encode(sourceRef.current);
            const result = session.readOnly
                ? await window.officeDesktop.saveFileAs(session.id, bytes, session.name)
                : await window.officeDesktop.saveFile(session.id, bytes);
            if (!result) return;
            setBaseline(sourceRef.current);
            onDirtyChange?.(false);
            setLoading(true);
            setVersion(value => value + 1);
            if (result.session.id !== session.id) onSessionReplaced?.(result.session);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }, [onDirtyChange, onSessionReplaced, session]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyV') {
                event.preventDefault();
                setSourceVisible((visible) => !visible);
            } else if (sourceVisible && (event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
                event.preventDefault();
                void save();
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [save, sourceVisible]);

    const viewerUrl = useMemo(() => {
        const fileName = encodeURIComponent(session.name);
        return `office-html://viewer/document/${encodeURIComponent(session.id)}/${fileName}?v=${version}`;
    }, [session.id, session.name, version]);

    return (
        <div className={`desktop-html-viewer${sourceVisible ? ' is-split' : ''}`}>
            <header className="desktop-html-toolbar">
                <strong>HTML Preview</strong>
                <span>{session.name}</span>
                <button type="button" onClick={() => setSourceVisible((visible) => !visible)}>
                    {sourceVisible ? '仅预览' : '源代码 / 分屏'}
                </button>
                {sourceVisible && <button type="button" disabled={session.readOnly && !source.length} onClick={() => void save()}>{session.readOnly ? '另存为' : '保存并刷新'}</button>}
                <kbd>Ctrl Shift V</kbd>
            </header>
            {error && <Alert className="desktop-html-error" type="error" showIcon closable message="HTML 操作失败" description={error} onClose={() => setError(undefined)} />}
            <div className="desktop-html-body">
                {sourceVisible && (
                    <textarea
                        aria-label="HTML 源代码"
                        spellCheck={false}
                        readOnly={session.readOnly}
                        value={source}
                        onChange={(event) => {
                            setSource(event.target.value);
                            onDirtyChange?.(event.target.value !== baseline);
                        }}
                    />
                )}
                <div className="desktop-html-preview">
                    <iframe
                        key={viewerUrl}
                        title={session.name}
                        src={viewerUrl}
                        sandbox="allow-scripts"
                        onLoad={() => setLoading(false)}
                    />
                    {loading && <Spin fullscreen tip="正在载入 HTML" />}
                </div>
            </div>
        </div>
    );
}
