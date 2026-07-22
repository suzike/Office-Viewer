import type { Document } from '@eigenpal/docx-editor-core/types/document';
import repackDocx from '@eigenpal/docx-editor-core/docx/rezip';
import { BoundedLruCache } from '../../../../desktop/shared/bounded-lru-cache';
import WordParseWorker from './word_parse.worker?worker&inline';

interface WordParseResponse {
    id: number;
    document?: Document;
    error?: string;
}

interface WordDraft {
    document: Document;
    revision: number;
    timer?: ReturnType<typeof setTimeout>;
    buffer?: Promise<ArrayBuffer>;
}

const parsedDocuments = new BoundedLruCache<string, Document>({
    maxEntries: 3,
    maxWeight: 192 * 1024 * 1024,
    weigh: document => document.originalBuffer?.byteLength ?? 1,
});

// Dirty drafts are correctness state, not a performance cache, so they must
// remain pinned until the host confirms that the file was saved.
const dirtyDrafts = new Map<string, WordDraft>();

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, {
    resolve: (document: Document) => void;
    reject: (reason: Error) => void;
}>();

function getWorker(): Worker {
    if (worker) return worker;
    worker = new WordParseWorker({
        name: 'office-word-parser',
    });
    worker.onmessage = (event: MessageEvent<WordParseResponse>) => {
        const request = pending.get(event.data.id);
        if (!request) return;
        pending.delete(event.data.id);
        if (event.data.document) request.resolve(event.data.document);
        else request.reject(new Error(event.data.error || 'Word parser worker failed'));
    };
    worker.onerror = (event) => {
        const error = new Error(event.message || 'Word parser worker failed');
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}

async function parseInWorker(buffer: ArrayBuffer): Promise<Document> {
    const id = nextRequestId++;
    const parser = getWorker();
    const result = new Promise<Document>((resolve, reject) => pending.set(id, { resolve, reject }));
    // Retain the caller's buffer for the compatibility fallback if worker
    // startup is blocked by an older webview CSP.
    const workerBuffer = buffer.slice(0);
    parser.postMessage({ id, buffer: workerBuffer }, [workerBuffer]);
    return result;
}

export async function loadParsedWordDocument(buffer: ArrayBuffer, cacheKey: string): Promise<Document> {
    const cached = parsedDocuments.get(cacheKey);
    if (cached) {
        performance.mark('office-word-cache-hit');
        return cached;
    }
    performance.mark('office-word-cache-miss');
    const document = await parseInWorker(buffer);
    parsedDocuments.set(cacheKey, document);
    return document;
}

function serializeDraft(draft: WordDraft): Promise<ArrayBuffer> {
    if (draft.timer) {
        clearTimeout(draft.timer);
        draft.timer = undefined;
    }
    if (!draft.buffer) {
        performance.mark('office-word-draft-serialize');
        draft.buffer = repackDocx(draft.document);
    }
    return draft.buffer;
}

export function storeWordDraft(cacheKey: string, document: Document, revision: number) {
    const previous = dirtyDrafts.get(cacheKey);
    if (previous?.timer) clearTimeout(previous.timer);
    const draft: WordDraft = { document, revision };
    // Collapse rapid keystrokes into one package operation. The timer belongs
    // to this module, so React Activity effect cleanup cannot cancel it.
    draft.timer = setTimeout(() => {
        if (dirtyDrafts.get(cacheKey) === draft) void serializeDraft(draft);
    }, 300);
    dirtyDrafts.set(cacheKey, draft);
}

export function getWordDraft(cacheKey: string): WordDraft | undefined {
    return dirtyDrafts.get(cacheKey);
}

export function materializeWordDraft(cacheKey: string, revision: number): Promise<ArrayBuffer> | undefined {
    const draft = dirtyDrafts.get(cacheKey);
    if (!draft || draft.revision !== revision) return undefined;
    return serializeDraft(draft);
}

export function clearWordDraft(cacheKey: string) {
    const draft = dirtyDrafts.get(cacheKey);
    if (draft?.timer) clearTimeout(draft.timer);
    dirtyDrafts.delete(cacheKey);
    parsedDocuments.delete(cacheKey);
}

export function getWordParseCacheStats() {
    return parsedDocuments.stats();
}
