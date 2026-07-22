/// <reference lib="webworker" />

import { loadSheets, type ExcelData } from './excel_reader';

interface ExcelParseRequest {
    id: number;
    buffer: ArrayBuffer;
    extension: string;
}

interface ExcelParseResponse {
    id: number;
    data?: ExcelData;
    error?: string;
}

self.onmessage = async (event: MessageEvent<ExcelParseRequest>) => {
    const { id, buffer, extension } = event.data;
    try {
        const data = await loadSheets(buffer, extension);
        const response: ExcelParseResponse = { id, data };
        self.postMessage(response);
    } catch (reason) {
        const response: ExcelParseResponse = {
            id,
            error: reason instanceof Error ? reason.message : String(reason),
        };
        self.postMessage(response);
    }
};

export {};
