/// <reference lib="webworker" />

import { parseDocx } from '@eigenpal/docx-editor-core/docx/parser';
import type { Document } from '@eigenpal/docx-editor-core/types/document';

interface WordParseRequest {
    id: number;
    buffer: ArrayBuffer;
}

interface WordParseResponse {
    id: number;
    document?: Document;
    error?: string;
}

self.onmessage = async (event: MessageEvent<WordParseRequest>) => {
    const { id, buffer } = event.data;
    try {
        // Font registration and layout remain in the visible editor; ZIP/XML
        // parsing is the expensive, DOM-independent phase moved off-thread.
        const document = await parseDocx(buffer, { preloadFonts: false });
        const response: WordParseResponse = { id, document };
        self.postMessage(response);
    } catch (reason) {
        const response: WordParseResponse = {
            id,
            error: reason instanceof Error ? reason.message : String(reason),
        };
        self.postMessage(response);
    }
};

export {};
