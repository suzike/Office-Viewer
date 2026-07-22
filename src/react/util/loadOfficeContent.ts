export interface OfficeOpenPayload {
    path?: string;
    buffer?: number[] | ArrayBuffer | Uint8Array;
    error?: string;
    documentCacheId?: string;
    documentCacheKey?: string;
    lastModified?: number;
    byteLength?: number;
}

export function arrayBufferFromPayload(payload: OfficeOpenPayload): ArrayBuffer {
    if (payload.error) {
        throw new Error(payload.error);
    }
    if (payload.buffer instanceof ArrayBuffer) {
        if (payload.buffer.byteLength === 0) throw new Error('Empty file content');
        return payload.buffer;
    }
    if (payload.buffer instanceof Uint8Array) {
        if (payload.buffer.byteLength === 0) throw new Error('Empty file content');
        return payload.buffer.slice().buffer;
    }
    if (!payload.buffer?.length) {
        throw new Error('Empty file content');
    }
    const bytes = new Uint8Array(payload.buffer.length);
    for (let i = 0; i < payload.buffer.length; i++) {
        bytes[i] = payload.buffer[i];
    }
    return bytes.buffer;
}

export async function loadOfficeBuffer(payload: OfficeOpenPayload): Promise<ArrayBuffer> {
    if (payload.buffer) {
        return arrayBufferFromPayload(payload);
    }
    if (!payload.path) {
        throw new Error(payload.error ?? 'No file path');
    }
    const response = await fetch(payload.path);
    if (!response.ok) {
        throw new Error(`Failed to fetch (${response.status})`);
    }
    return response.arrayBuffer();
}
