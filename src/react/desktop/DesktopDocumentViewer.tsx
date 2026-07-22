import { Alert, Spin } from 'antd';
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DesktopFileSession } from '../../../desktop/shared/desktop-api';
import { isDesktopTextFile } from '../../../desktop/shared/text-language-routing';
import {
    dispatchHostMessage,
    installOfficeHostBridge,
    type OfficeHostBridge,
} from '../util/vscode';

const Excel = lazy(() => import('../view/excel/Excel'));
const DesktopArchiveDocumentViewer = lazy(() => import('./DesktopArchiveDocumentViewer'));
const FontViewer = lazy(() => import('../view/fontViewer/FontViewer'));
const IcnsViewer = lazy(() => import('../view/icns/IcnsViewer'));
const DesktopHtmlDocumentViewer = lazy(() => import('./DesktopHtmlDocumentViewer'));
const DesktopHttpDocumentViewer = lazy(() => import('./DesktopHttpDocumentViewer'));
const DesktopImageDocumentViewer = lazy(() => import('./DesktopImageDocumentViewer'));
const DesktopJavaDocumentViewer = lazy(() => import('./DesktopJavaDocumentViewer'));
const DesktopMarkdownDocumentViewer = lazy(() => import('./DesktopMarkdownDocumentViewer'));
const DesktopPdfDocumentViewer = lazy(() => import('./DesktopPdfDocumentViewer'));
const DesktopSvgDocumentViewer = lazy(() => import('./DesktopSvgDocumentViewer'));
const DesktopTextDocumentViewer = lazy(() => import('./DesktopTextDocumentViewer'));
const Epub = lazy(() => import('../view/epub/Epub'));
const Parquet = lazy(() => import('../view/parquet/Parquet'));
const PowerPoint = lazy(() => import('../view/powerpoint/PowerPoint'));
const PsdViewer = lazy(() => import('../view/psd/PsdViewer'));
const Word = lazy(() => import('../view/word/Word'));
const XmindViewer = lazy(() => import('../view/xmind/XmindViewer'));

export interface DesktopDocumentViewerProps {
    session: DesktopFileSession;
    forceText?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    onSessionReplaced?: (session: DesktopFileSession) => void;
}

type ViewerRoute = 'archive' | 'epub' | 'excel' | 'font' | 'html' | 'http' | 'icns' | 'image' | 'java' | 'markdown' | 'parquet' | 'pdf' | 'powerpoint' | 'psd' | 'svg' | 'text' | 'word' | 'xmind' | 'unsupported';

function routeForExtension(extension: string, fileName: string): ViewerRoute {
    if (isDesktopTextFile(fileName, extension)) return 'text';
    switch (extension.replace(/^\./, '').toLowerCase()) {
        case 'apk':
        case '7z':
        case 'crx':
        case 'gz':
        case 'jar':
        case 'rar':
        case 'tar':
        case 'tgz':
        case 'vsix':
        case 'zip':
            return 'archive';
        case 'csv':
        case 'ods':
        case 'tsv':
        case 'xls':
        case 'xlsm':
        case 'xlsx':
            return 'excel';
        case 'epub':
            return 'epub';
        case 'otf':
        case 'ttf':
        case 'woff':
        case 'woff2':
            return 'font';
        case 'htm':
        case 'html':
        case 'xhtml':
            return 'html';
        case 'http':
        case 'rest':
            return 'http';
        case 'class':
            return 'java';
        case 'icns':
            return 'icns';
        case 'markdown':
        case 'md':
            return 'markdown';
        case 'apng':
        case 'bmp':
        case 'cur':
        case 'gif':
        case 'heic':
        case 'heif':
        case 'ico':
        case 'jpeg':
        case 'jpg':
        case 'pjp':
        case 'pjpeg':
        case 'png':
        case 'tif':
        case 'tiff':
        case 'webp':
            return 'image';
        case 'docx':
        case 'dotx':
            return 'word';
        case 'pptm':
        case 'pptx':
            return 'powerpoint';
        case 'pdf':
            return 'pdf';
        case 'parquet':
            return 'parquet';
        case 'psd':
            return 'psd';
        case 'svg':
            return 'svg';
        case 'xmind':
            return 'xmind';
        default:
            return 'unsupported';
    }
}

function toBytes(content: unknown): Uint8Array {
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (Array.isArray(content)) return new Uint8Array(content);
    if (typeof content === 'string') return new TextEncoder().encode(content);
    throw new Error('The viewer returned an unsupported document payload.');
}

function suggestedName(session: DesktopFileSession, extension?: string) {
    if (!extension) return session.name;
    const normalized = extension.replace(/^\./, '').toLowerCase();
    const stem = session.name.replace(/\.[^.]+$/, '');
    return `${stem}.${normalized}`;
}

function sessionCacheKey(session: DesktopFileSession) {
    return `desktop:${session.id}:${session.lastModified}:${session.byteLength}`;
}

function OfficeRenderer({ route }: { route: Exclude<ViewerRoute, 'archive' | 'html' | 'image' | 'java' | 'markdown' | 'pdf' | 'svg' | 'unsupported'> }) {
    switch (route) {
        case 'epub':
            return <Epub />;
        case 'excel':
            return <Excel />;
        case 'font':
            return <FontViewer />;
        case 'icns':
            return <IcnsViewer />;
        case 'parquet':
            return <Parquet />;
        case 'powerpoint':
            return <PowerPoint />;
        case 'psd':
            return <PsdViewer />;
        case 'word':
            return <Word />;
        case 'xmind':
            return <XmindViewer />;
    }
}

export default function DesktopDocumentViewer({
    session,
    forceText = false,
    onDirtyChange,
    onSessionReplaced,
}: DesktopDocumentViewerProps) {
    const route = useMemo(() => forceText ? 'text' : routeForExtension(session.extension, session.name), [forceText, session.extension, session.name]);
    const dirtyRef = useRef(false);
    const [loadError, setLoadError] = useState<string>();

    useLayoutEffect(() => {
        if (route === 'archive' || route === 'html' || route === 'http' || route === 'image' || route === 'java' || route === 'markdown' || route === 'pdf' || route === 'svg' || route === 'text' || route === 'unsupported') return;
        let disposed = false;
        let opened = false;
        const open = async () => {
            if (opened) return;
            opened = true;
            try {
                setLoadError(undefined);
                const buffer = await window.officeDesktop.readFile(session.id);
                if (disposed) return;
                dispatchHostMessage({
                    type: 'open',
                    content: {
                        buffer,
                        documentCacheId: `desktop:${session.id}`,
                        documentCacheKey: sessionCacheKey(session),
                        ext: session.extension,
                        fileName: session.name,
                        lastModified: session.lastModified,
                        byteLength: session.byteLength,
                        path: session.path,
                        readOnly: session.readOnly,
                    },
                });
            } catch (reason) {
                if (!disposed) setLoadError(reason instanceof Error ? reason.message : String(reason));
            }
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
                        const save = session.readOnly
                            ? window.officeDesktop.saveFileAs(session.id, bytes, session.name)
                            : window.officeDesktop.saveFile(session.id, bytes);
                        void save.then((result) => {
                            if (!result) return;
                            dirtyRef.current = false;
                            onDirtyChange?.(false);
                            onSessionReplaced?.(result.session);
                            dispatchHostMessage({
                                type: 'saveDone',
                                content: { documentCacheKey: sessionCacheKey(result.session) },
                            });
                        }).catch((reason: unknown) => {
                            setLoadError(reason instanceof Error ? reason.message : String(reason));
                        });
                        break;
                    }
                    case 'saveAs': {
                        const payload = message.content as { content?: unknown; ext?: string } | undefined;
                        const bytes = toBytes(payload?.content);
                        void window.officeDesktop.saveFileAs(
                            session.id,
                            bytes,
                            suggestedName(session, payload?.ext),
                        ).then((result) => {
                            if (!result) return;
                            dirtyRef.current = false;
                            onDirtyChange?.(false);
                            onSessionReplaced?.(result.session);
                            dispatchHostMessage({
                                type: 'saveDone',
                                content: { documentCacheKey: sessionCacheKey(result.session) },
                            });
                        }).catch((reason: unknown) => {
                            setLoadError(reason instanceof Error ? reason.message : String(reason));
                        });
                        break;
                    }
                    case 'openExternal':
                        if (typeof message.content === 'string') {
                            void window.officeDesktop.openExternal(message.content);
                        }
                        break;
                    case 'editInVSCode':
                        void window.officeDesktop.openWithSystem(session.id).catch((reason: unknown) => {
                            setLoadError(reason instanceof Error ? reason.message : String(reason));
                        });
                        break;
                    case 'developerTool':
                        void window.officeDesktop.toggleDevTools();
                        break;
                }
            },
        };

        const uninstall = installOfficeHostBridge(bridge);
        return () => {
            disposed = true;
            uninstall();
        };
    }, [onDirtyChange, onSessionReplaced, route, session]);

    if (route === 'unsupported') {
        return (
            <Alert
                type="warning"
                showIcon
                message="该格式尚未接入桌面渲染器"
                description={`${session.extension || '未知格式'} 已进入完整等效迁移清单。`}
            />
        );
    }
    if (route === 'pdf') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopPdfDocumentViewer session={session} />
            </Suspense>
        );
    }
    if (route === 'html') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopHtmlDocumentViewer
                    session={session}
                    onDirtyChange={onDirtyChange}
                    onSessionReplaced={onSessionReplaced}
                />
            </Suspense>
        );
    }
    if (route === 'http') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopHttpDocumentViewer
                    session={session}
                    onDirtyChange={onDirtyChange}
                    onSessionReplaced={onSessionReplaced}
                />
            </Suspense>
        );
    }
    if (route === 'java') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopJavaDocumentViewer session={session} />
            </Suspense>
        );
    }
    if (route === 'archive') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopArchiveDocumentViewer session={session} />
            </Suspense>
        );
    }
    if (route === 'image') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopImageDocumentViewer session={session} />
            </Suspense>
        );
    }
    if (route === 'markdown') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopMarkdownDocumentViewer
                    session={session}
                    onDirtyChange={onDirtyChange}
                    onSessionReplaced={onSessionReplaced}
                />
            </Suspense>
        );
    }
    if (route === 'svg') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopSvgDocumentViewer
                    session={session}
                    onDirtyChange={onDirtyChange}
                    onSessionReplaced={onSessionReplaced}
                />
            </Suspense>
        );
    }
    if (route === 'text') {
        return (
            <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
                <DesktopTextDocumentViewer
                    session={session}
                    onDirtyChange={onDirtyChange}
                    onSessionReplaced={onSessionReplaced}
                />
            </Suspense>
        );
    }
    if (loadError) return <Alert type="error" showIcon message="文档无法打开" description={loadError} />;

    return (
        <Suspense fallback={<Spin fullscreen tip={`正在载入 ${session.name}`} />}>
            <OfficeRenderer route={route} />
        </Suspense>
    );
}
