import TiffDecodeWorker from './tiff_decode.worker?worker&inline';

interface TiffDecodeResponse {
    id: number;
    png?: ArrayBuffer;
    error?: string;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, {
    resolve: (png: ArrayBuffer) => void;
    reject: (reason: Error) => void;
}>();

function getWorker(): Worker {
    if (worker) return worker;
    worker = new TiffDecodeWorker({
        name: 'office-tiff-decoder',
    });
    worker.onmessage = (event: MessageEvent<TiffDecodeResponse>) => {
        const request = pending.get(event.data.id);
        if (!request) return;
        pending.delete(event.data.id);
        if (event.data.png) request.resolve(event.data.png);
        else request.reject(new Error(event.data.error || 'TIFF decoder worker failed'));
    };
    worker.onerror = (event) => {
        const error = new Error(event.message || 'TIFF decoder worker failed');
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}

export function decodeTiffInWorker(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    const id = nextRequestId++;
    const decoder = getWorker();
    const result = new Promise<ArrayBuffer>((resolve, reject) => pending.set(id, { resolve, reject }));
    const workerBuffer = buffer.slice(0);
    decoder.postMessage({ id, buffer: workerBuffer }, [workerBuffer]);
    return result;
}
