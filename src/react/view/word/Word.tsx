import { MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Alert, Spin } from "antd";
import { DocxEditor, type DocxEditorRef } from "@eigenpal/docx-editor-react";
import type { Document } from "@eigenpal/docx-editor-core/types/document";
import "@eigenpal/docx-editor-react/styles.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { handler } from "../../util/vscode";
import { useViewerColorMode } from "../../util/viewerColorMode";
import { loadOfficeBuffer } from "../../util/loadOfficeContent";
import { officeSessionCacheKey } from "../../util/officeSessionCache";
import {
    clearWordDraft,
    getWordDraft,
    loadParsedWordDocument,
    materializeWordDraft,
    storeWordDraft,
} from "./word_parse_client";
import SponsorBar from "../components/SponsorBar";
import "./Word.css";

const WORD_COLOR_MODE_OPTIONS = {
    storageKey: "office-word-color-mode",
    stateKey: "wordColorMode",
} as const;

interface WordOpenPayload {
    path?: string;
    buffer?: number[];
    error?: string;
    readOnly?: boolean;
    fileName?: string;
    documentCacheId?: string;
    documentCacheKey?: string;
    lastModified?: number;
    byteLength?: number;
    nonce?: number;
}

interface WordSaveDonePayload {
    documentCacheKey?: string;
}

export default function Word() {
    const editorRef = useRef<DocxEditorRef>(null);
    const readOnlyRef = useRef(false);
    const { adaptiveColorMode, toggleColorMode } = useViewerColorMode(WORD_COLOR_MODE_OPTIONS);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [readOnly, setReadOnly] = useState(false);
    const [documentBuffer, setDocumentBuffer] = useState<ArrayBuffer | undefined>(undefined);
    const [parsedDocument, setParsedDocument] = useState<Document | undefined>(undefined);
    const [editorReady, setEditorReady] = useState(false);
    const [documentKey, setDocumentKey] = useState("");
    const [fileName, setFileName] = useState("");
    const [commentsSidebarOpen, setCommentsSidebarOpen] = useState(false);
    const skipCommentsAutoOpenRef = useRef(true);
    const loadedCacheKeyRef = useRef("");
    const activeCacheKeyRef = useRef("");
    const draftRevisionRef = useRef(0);

    const emitSave = useCallback((buffer: ArrayBuffer) => {
        const bytes = new Uint8Array(buffer);
        const content: number[] = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
            content[i] = bytes[i];
        }
        handler.emit("save", content);
    }, []);

    const handleSave = useCallback(async () => {
        const buffer = await editorRef.current?.save();
        if (!buffer) {
            return;
        }
        emitSave(buffer);
    }, [emitSave]);

    const loadDocument = useCallback(async (payload: WordOpenPayload) => {
        const cacheKey = officeSessionCacheKey(payload);
        activeCacheKeyRef.current = cacheKey;
        if (loadedCacheKeyRef.current === cacheKey) {
            performance.mark('office-word-cache-hit');
            const draft = getWordDraft(cacheKey);
            if (draft) {
                setLoading(true);
                const draftBuffer = await materializeWordDraft(cacheKey, draft.revision);
                if (activeCacheKeyRef.current !== cacheKey) return;
                setDocumentKey(`${cacheKey}:draft:${draft.revision}`);
                setDocumentBuffer(undefined);
                if (draftBuffer) setDocumentBuffer(draftBuffer);
                else setParsedDocument(draft.document);
                setLoading(false);
            }
            return;
        }
        setLoading(true);
        setEditorReady(false);
        setError(null);
        setDocumentBuffer(undefined);
        setParsedDocument(undefined);

        try {
            const fileReadOnly = payload.readOnly === true;
            readOnlyRef.current = fileReadOnly;
            setReadOnly(fileReadOnly);
            setFileName(payload.fileName ?? "");
            setDocumentKey(cacheKey);
            skipCommentsAutoOpenRef.current = true;
            setCommentsSidebarOpen(false);
            const buffer = await loadOfficeBuffer(payload);
            const draft = getWordDraft(cacheKey);
            if (draft) {
                const draftBuffer = await materializeWordDraft(cacheKey, draft.revision);
                if (activeCacheKeyRef.current !== cacheKey) return;
                loadedCacheKeyRef.current = cacheKey;
                setDocumentKey(`${cacheKey}:draft:${draft.revision}`);
                if (draftBuffer) setDocumentBuffer(draftBuffer);
                else setParsedDocument(draft.document);
                return;
            }
            if (window.officeDesktop) {
                try {
                    loadedCacheKeyRef.current = cacheKey;
                    if (fileReadOnly) {
                        setParsedDocument(await loadParsedWordDocument(buffer, cacheKey));
                    } else {
                        // The third-party editor does not establish a writable
                        // runtime from its pre-parsed document prop. Preserve
                        // the editable buffer path while warming the bounded
                        // worker cache for inspection/read-only reuse.
                        void loadParsedWordDocument(buffer, cacheKey).catch((workerError) => {
                            console.warn('Word parser worker warmup failed.', workerError);
                        });
                        setDocumentBuffer(buffer);
                    }
                } catch (workerError) {
                    console.warn('Word parser worker unavailable; using editor compatibility parser.', workerError);
                    loadedCacheKeyRef.current = cacheKey;
                    setDocumentBuffer(buffer);
                }
            } else {
                loadedCacheKeyRef.current = cacheKey;
                setDocumentBuffer(buffer);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load document");
        } finally {
            setLoading(false);
        }
    }, []);

    const handleChange = useCallback(() => {
        if (readOnlyRef.current) return;
        const revision = ++draftRevisionRef.current;
        handler.emit("change");
        // The editor invokes onChange before publishing the new history state.
        // Capture in a microtask so the last typed character is included while
        // still pinning the Activity synchronously via the dirty event above.
        queueMicrotask(() => {
            if (revision !== draftRevisionRef.current) return;
            const document = editorRef.current?.getDocument();
            if (document) storeWordDraft(activeCacheKeyRef.current, document, revision);
        });
    }, []);

    useEffect(() => {
        handler
            .on("open", (payload: WordOpenPayload) => {
                void loadDocument(payload);
            })
            .on("saveDone", (payload: WordSaveDonePayload) => {
                const previousCacheKey = activeCacheKeyRef.current;
                clearWordDraft(previousCacheKey);
                if (payload?.documentCacheKey) {
                    activeCacheKeyRef.current = payload.documentCacheKey;
                    loadedCacheKeyRef.current = payload.documentCacheKey;
                }
            })
            .emit("init");
    }, [loadDocument]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
                e.preventDefault();
                void handleSave();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [handleSave]);

    return (
        <div
            className={`word-viewer${adaptiveColorMode ? " word-viewer--vscode-theme" : ""}`}
            data-editor-ready={editorReady ? "true" : "false"}
        >
            <button
                type="button"
                className="dark-mode-toggle"
                title={adaptiveColorMode ? "切换亮色" : "切换暗色（跟随 VS Code 主题）"}
                aria-label={adaptiveColorMode ? "Switch to light mode" : "Switch to adaptive dark mode"}
                onClick={toggleColorMode}
            >
                {adaptiveColorMode ? <SunOutlined /> : <MoonOutlined />}
            </button>
            <Spin spinning={loading} fullscreen />
            {error && <Alert type="error" message={error} showIcon style={{ margin: 16 }} />}
            {readOnly && !loading && !error && (documentBuffer || parsedDocument) && (
                <div className="word-readonly-banner">Read-only — edits will be saved to a new file</div>
            )}
            {(documentBuffer || parsedDocument) && !loading && !error && (
                <>
                    <DocxEditor
                        key={documentKey}
                        ref={editorRef}
                        className="word-editor"
                        documentBuffer={documentBuffer}
                        document={parsedDocument}
                        documentName={fileName}
                        documentNameEditable={false}
                        readOnly={readOnly}
                        {...(readOnly ? { mode: "viewing" as const } : {})}
                        commentsSidebarOpen={commentsSidebarOpen}
                        onCommentsSidebarOpenChange={(open) => {
                            if (open && skipCommentsAutoOpenRef.current) {
                                skipCommentsAutoOpenRef.current = false;
                                return;
                            }
                            setCommentsSidebarOpen(open);
                        }}
                        colorMode="light"
                        onEditorViewReady={() => setEditorReady(true)}
                        showFileOpen={false}
                        showHelpMenu={false}
                        onChange={handleChange}
                        onSave={emitSave}
                    />
                    <footer className="word-sponsor-footer">
                        <SponsorBar placement="right" />
                    </footer>
                </>
            )}
        </div>
    );
}
