import { Spin } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { DesktopFileSession } from '../../../desktop/shared/desktop-api';

export default function DesktopPdfDocumentViewer({ session }: { session: DesktopFileSession }) {
    const [loading, setLoading] = useState(true);
    const [version, setVersion] = useState(0);

    useEffect(() => window.officeDesktop.onFileChanged((event) => {
        if (event.sessionId === session.id) {
            setLoading(true);
            setVersion(value => value + 1);
        }
    }), [session.id]);

    useEffect(() => {
        const receiveViewerMessage = (event: MessageEvent) => {
            const data = event.data as {
                __officePdfViewer?: boolean;
                message?: { type?: string };
            } | undefined;
            if (data?.__officePdfViewer && data.message?.type === 'developerTool') {
                void window.officeDesktop.toggleDevTools();
            }
        };
        window.addEventListener('message', receiveViewerMessage);
        return () => window.removeEventListener('message', receiveViewerMessage);
    }, []);

    const viewerUrl = useMemo(() => {
        const documentUrl = `office-pdf://viewer/document/${encodeURIComponent(session.id)}?v=${version}`;
        return `office-pdf://viewer/viewer.html?file=${encodeURIComponent(documentUrl)}`;
    }, [session.id, version]);

    return (
        <div className="desktop-pdf-viewer" style={{ width: '100%', height: '100%', position: 'relative' }}>
            <iframe
                key={viewerUrl}
                title={session.name}
                src={viewerUrl}
                sandbox="allow-scripts allow-downloads allow-modals allow-same-origin"
                style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
                onLoad={() => setLoading(false)}
            />
            {loading && <Spin fullscreen tip="正在载入 PDF" />}
        </div>
    );
}
