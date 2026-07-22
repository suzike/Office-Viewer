import { BoundedLruCache } from '../../../../desktop/shared/bounded-lru-cache';
import type { ExcelData } from './excel_reader';
import ExcelParseWorker from './excel_parse.worker?worker&inline';

interface CachedExcelData {
    data: ExcelData;
    sourceBytes: number;
}

interface ExcelParseResponse {
    id: number;
    data?: ExcelData;
    error?: string;
}

const parsedWorkbooks = new BoundedLruCache<string, CachedExcelData>({
    maxEntries: 3,
    maxWeight: 256 * 1024 * 1024,
    weigh: entry => entry.sourceBytes,
});

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, {
    resolve: (data: ExcelData) => void;
    reject: (reason: Error) => void;
}>();

function getWorker(): Worker {
    if (worker) return worker;
    worker = new ExcelParseWorker({
        name: 'office-excel-parser',
    });
    worker.onmessage = (event: MessageEvent<ExcelParseResponse>) => {
        const request = pending.get(event.data.id);
        if (!request) return;
        pending.delete(event.data.id);
        if (event.data.data) request.resolve(event.data.data);
        else request.reject(new Error(event.data.error || 'Excel parser worker failed'));
        if (!pending.size) {
            worker?.terminate();
            worker = null;
        }
    };
    worker.onerror = (event) => {
        const error = new Error(event.message || 'Excel parser worker failed');
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}

async function parseInWorker(buffer: ArrayBuffer, extension: string): Promise<ExcelData> {
    const id = nextRequestId++;
    const parser = getWorker();
    const result = new Promise<ExcelData>((resolve, reject) => pending.set(id, { resolve, reject }));
    const workerBuffer = buffer.slice(0);
    parser.postMessage({ id, buffer: workerBuffer, extension }, [workerBuffer]);
    return result;
}

export async function loadParsedExcelWorkbook(
    buffer: ArrayBuffer,
    extension: string,
    cacheKey: string,
): Promise<ExcelData> {
    const cached = parsedWorkbooks.get(cacheKey);
    if (cached) {
        performance.mark('office-excel-cache-hit');
        return cached.data;
    }
    performance.mark('office-excel-cache-miss');
    const data = await parseInWorker(buffer, extension);
    parsedWorkbooks.set(cacheKey, { data, sourceBytes: buffer.byteLength });
    return data;
}

export function getExcelParseCacheStats() {
    return parsedWorkbooks.stats();
}
