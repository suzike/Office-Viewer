import { useLayoutEffect, useRef, useState } from 'react';
import type { DesktopFileSession } from '../../../desktop/shared/desktop-api';
import SvgViewer from '../view/svg/SvgViewer';
import {
    dispatchHostMessage,
    installOfficeHostBridge,
    type OfficeHostBridge,
    type OfficeHostBridgeHandle,
} from '../util/vscode';

export interface DesktopSvgDocumentViewerProps {
    session: DesktopFileSession;
    active?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    onSessionReplaced?: (session: DesktopFileSession) => void;
}

function decodeSvgText(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(bytes);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

function toBytes(content: unknown): Uint8Array {
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) {
        return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
    if (Array.isArray(content)) return new Uint8Array(content);
    if (typeof content === 'string') return new TextEncoder().encode(content);
    throw new TypeError('SVG 内容必须是文本或字节数据。');
}

function suggestedName(session: DesktopFileSession, extension: unknown): string {
    const normalized = typeof extension === 'string'
        ? extension.replace(/^\./, '').toLowerCase()
        : 'svg';
    const safeExtension = /^(?:svg|png)$/.test(normalized) ? normalized : 'svg';
    return `${session.name.replace(/\.[^.]+$/, '')}.${safeExtension}`;
}

export default function DesktopSvgDocumentViewer({
    session,
    active = true,
    onDirtyChange,
    onSessionReplaced,
}: DesktopSvgDocumentViewerProps) {
    const dirtyRef = useRef(false);
    const [bridgeError, setBridgeError] = useState<string>();
    const bridgeHandleRef = useRef<OfficeHostBridgeHandle>();

    useLayoutEffect(() => {
        if (active) bridgeHandleRef.current?.activate();
    }, [active]);
    useLayoutEffect(() => {
        let disposed = false;

        const open = async () => {
            try {
                setBridgeError(undefined);
                const buffer = await window.officeDesktop.readFile(session.id);
                if (disposed) return;
                dispatchHostMessage({
                    type: 'open',
                    content: {
                        content: decodeSvgText(buffer),
                        ext: session.extension,
                        fileName: session.name,
                        path: session.path,
                        readOnly: session.readOnly,
                        scheme: 'file',
                    },
                });
            } catch (reason) {
                if (disposed) return;
                const message = reason instanceof Error ? reason.message : String(reason);
                setBridgeError(message);
                dispatchHostMessage({
                    type: 'open',
                    content: { path: session.path, content: '', error: message },
                });
            }
        };

        const reportError = (reason: unknown) => {
            if (!disposed) setBridgeError(reason instanceof Error ? reason.message : String(reason));
        };

        const markSaved = (replacement?: DesktopFileSession) => {
            dirtyRef.current = false;
            onDirtyChange?.(false);
            if (replacement && replacement.id !== session.id) {
                onSessionReplaced?.(replacement);
            }
            dispatchHostMessage({ type: 'saveDone' });
        };

        const bridge: OfficeHostBridge = {
            postMessage(message) {
                switch (message.type) {
                    case 'init':
                        void open();
                        break;
                    case 'change':
                        dirtyRef.current = true;
                        onDirtyChange?.(true);
                        break;
                    case 'save': {
                        const bytes = toBytes(message.content);
                        const write = session.readOnly
                            ? window.officeDesktop.saveFileAs(session.id, bytes, session.name)
                            : window.officeDesktop.saveFile(session.id, bytes);
                        void write.then((result) => {
                            if (result) markSaved(result.session);
                        }).catch(reportError);
                        break;
                    }
                    case 'saveAs': {
                        const payload = message.content as {
                            content?: unknown;
                            ext?: unknown;
                            mode?: unknown;
                        } | undefined;
                        const bytes = toBytes(payload?.content);
                        void window.officeDesktop.saveFileAs(
                            session.id,
                            bytes,
                            suggestedName(session, payload?.ext),
                        ).then((result) => {
                            if (!result) return;
                            if (payload?.mode === 'export') {
                                void window.officeDesktop.closeFile(result.session.id).catch(reportError);
                                return;
                            }
                            markSaved(result.session);
                        }).catch(reportError);
                        break;
                    }
                    case 'editInVSCode':
                        void window.officeDesktop.openWithSystem(session.id).catch(reportError);
                        break;
                    case 'showInFolder':
                        void window.officeDesktop.showInFolder(session.id).catch(reportError);
                        break;
                    case 'openExternal':
                        if (typeof message.content === 'string') {
                            void window.officeDesktop.openExternal(message.content).catch(reportError);
                        }
                        break;
                    case 'developerTool':
                        void window.officeDesktop.toggleDevTools().catch(reportError);
                        break;
                }
            },
        };

        const uninstall = installOfficeHostBridge(bridge);
        bridgeHandleRef.current = uninstall;
        return () => {
            disposed = true;
            bridgeHandleRef.current = undefined;
            uninstall();
        };
    }, [onDirtyChange, onSessionReplaced, session]);

    return (
        <div className="desktop-svg-viewer" data-bridge-error={bridgeError || undefined}>
            <SvgViewer hostExports />
        </div>
    );
}
