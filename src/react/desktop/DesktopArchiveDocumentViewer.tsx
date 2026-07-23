import { Alert, Spin } from 'antd';
import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopFileSession } from '../../../desktop/shared/desktop-api';
import { dispatchHostMessage, installOfficeHostBridge, type OfficeHostBridge, type OfficeHostBridgeHandle } from '../util/vscode';

const Zip = lazy(() => import('../view/compress/Zip'));

export default function DesktopArchiveDocumentViewer({ session, active = true }: { session: DesktopFileSession; active?: boolean }) {
    const [error, setError] = useState<string>();
    const bridgeHandleRef = useRef<OfficeHostBridgeHandle>();

    useLayoutEffect(() => {
        if (active) bridgeHandleRef.current?.activate();
    }, [active]);
    const emitArchive = useCallback(async (encoding?: string) => {
        setError(undefined);
        try {
            const info = await window.officeDesktop.inspectArchive(session.id, encoding);
            dispatchHostMessage({ type: 'encrypted', content: info.encrypted });
            dispatchHostMessage({ type: 'encoding', content: info.encoding });
            dispatchHostMessage({ type: 'extension', content: info.extension });
            dispatchHostMessage({ type: 'size', content: info.size });
            dispatchHostMessage({ type: 'data', content: info });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }, [session.id]);

    useLayoutEffect(() => {
        const reportActionError = (reason: unknown) => {
            const message = reason instanceof Error ? reason.message : String(reason);
            if (/password/i.test(message)) {
                dispatchHostMessage({ type: 'passwordError' });
            } else {
                setError(message);
            }
        };
        const bridge: OfficeHostBridge = {
            postMessage(message) {
                const payload = message.content as Record<string, unknown> | undefined;
                switch (message.type) {
                    case 'init':
                        void emitArchive();
                        break;
                    case 'changeEncoding':
                        void emitArchive(typeof message.content === 'string' ? message.content : undefined);
                        break;
                    case 'openPath': {
                        const entry = (payload?.entry ?? message.content) as { entryName?: string; isDirectory?: boolean } | undefined;
                        if (!entry?.entryName) return;
                        if (entry.isDirectory) {
                            dispatchHostMessage({ type: 'openDir', content: entry.entryName });
                            return;
                        }
                        void window.officeDesktop.openArchiveEntry(
                            session.id,
                            entry.entryName,
                            typeof payload?.password === 'string' ? payload.password : undefined,
                        ).catch(reportActionError);
                        break;
                    }
                    case 'autoExtract':
                        void window.officeDesktop.extractArchive(
                            session.id,
                            typeof message.content === 'string' ? message.content : undefined,
                        ).catch(reportActionError);
                        break;
                    case 'showInExplorer':
                        void window.officeDesktop.showInFolder(session.id).catch(reportActionError);
                        break;
                    case 'addFile':
                        void window.officeDesktop.addArchiveFile(
                            session.id,
                            typeof message.content === 'string' ? message.content : undefined,
                        ).then((result) => {
                            if (!result) return;
                            dispatchHostMessage({ type: 'saveDone' });
                            dispatchHostMessage({ type: 'zipChange' });
                        }).catch(reportActionError);
                        break;
                    case 'removeFile':
                        if (typeof message.content !== 'string') return;
                        void window.officeDesktop.removeArchiveEntry(session.id, message.content)
                            .then(() => {
                                dispatchHostMessage({ type: 'saveDone' });
                                dispatchHostMessage({ type: 'zipChange' });
                            })
                            .catch(reportActionError);
                        break;
                    case 'developerTool':
                        void window.officeDesktop.toggleDevTools();
                        break;
                }
            },
        };
        const uninstall = installOfficeHostBridge(bridge);
        bridgeHandleRef.current = uninstall;
        return () => {
            bridgeHandleRef.current = undefined;
            uninstall();
        };
    }, [emitArchive, session.id]);

    if (error) {
        return <Alert className="archive-load-error" type="error" showIcon message="归档无法打开" description={error} />;
    }
    return (
        <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
            <Zip />
        </Suspense>
    );
}
