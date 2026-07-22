import * as UTIF from 'utif';
import { decodeTiffInWorker } from './tiff_decode_client';

export type ImageSource = {
    src?: string;
    title?: string;
    ext?: string;
    mime?: string;
    buffer?: number[] | ArrayBuffer | Uint8Array;
};

function bufferToBlob(buffer: NonNullable<ImageSource['buffer']>, mime: string): Blob {
    const bytes = Array.isArray(buffer)
        ? Uint8Array.from(buffer)
        : buffer instanceof ArrayBuffer
            ? new Uint8Array(buffer)
            : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return new Blob([Uint8Array.from(bytes)], { type: mime });
}

export function hasImageBuffer(image: ImageSource): boolean {
    const buffer = image.buffer;
    return !!buffer && (Array.isArray(buffer) ? buffer.length > 0 : buffer.byteLength > 0);
}

function getPathname(src: string): string {
    try {
        return new URL(src).pathname;
    } catch {
        return src.split('?')[0];
    }
}

function getDataUrlMime(src: string): string {
    if (!src.startsWith('data:')) {
        return '';
    }
    const end = src.indexOf(';');
    return end > 5 ? src.slice(5, end).toLowerCase() : '';
}

function getFormatHint(src: string, ext?: string): 'heic' | 'tiff' | null {
    const name = ext ?? getPathname(src);
    if (/\.(heic|heif)$/i.test(name)) {
        return 'heic';
    }
    if (/\.tiff?$/i.test(name)) {
        return 'tiff';
    }
    const mime = getDataUrlMime(src);
    if (/heic|heif/.test(mime)) {
        return 'heic';
    }
    if (/tiff/.test(mime)) {
        return 'tiff';
    }
    return null;
}

export function needsConversion(image: ImageSource): boolean {
    return getFormatHint(image.src ?? '', image.ext) !== null;
}

async function loadImageBlob(image: ImageSource, format: 'heic' | 'tiff'): Promise<Blob> {
    if (hasImageBuffer(image)) {
        const mime = image.mime ?? (format === 'heic' ? 'image/heic' : 'image/tiff');
        return bufferToBlob(image.buffer!, mime);
    }
    const src = image.src ?? '';
    if (src.startsWith('data:')) {
        const response = await fetch(src);
        const blob = await response.blob();
        if (blob.type) {
            return blob;
        }
        const mime = format === 'heic' ? 'image/heic' : 'image/tiff';
        return new Blob([await blob.arrayBuffer()], { type: mime });
    }
    const response = await fetch(src);
    if (!response.ok) {
        throw new Error(`Failed to load image: ${response.status}`);
    }
    return response.blob();
}

const HEIC_DECODER_CHANNEL = 'office-viewer:heic-decoder';
let heicDecoderFramePromise: Promise<HTMLIFrameElement> | undefined;
let heicRequestSequence = 0;

function getHeicDecoderFrame(): Promise<HTMLIFrameElement> {
    if (!heicDecoderFramePromise) {
        heicDecoderFramePromise = new Promise((resolve, reject) => {
            const frame = document.createElement('iframe');
            frame.hidden = true;
            frame.tabIndex = -1;
            frame.title = 'HEIC decoder';
            frame.dataset.officeImageDecoder = 'true';
            frame.setAttribute('sandbox', 'allow-scripts');

            const timeout = window.setTimeout(() => {
                cleanup();
                frame.remove();
                heicDecoderFramePromise = undefined;
                reject(new Error('Timed out while starting the isolated HEIC decoder'));
            }, 20_000);
            const cleanup = () => {
                window.clearTimeout(timeout);
                window.removeEventListener('message', onMessage);
                frame.removeEventListener('error', onError);
            };
            const onMessage = (event: MessageEvent) => {
                if (event.source !== frame.contentWindow) return;
                if (event.data?.channel !== HEIC_DECODER_CHANNEL || event.data?.type !== 'ready') return;
                cleanup();
                resolve(frame);
            };
            const onError = () => {
                cleanup();
                frame.remove();
                heicDecoderFramePromise = undefined;
                reject(new Error('Failed to start the isolated HEIC decoder'));
            };

            window.addEventListener('message', onMessage);
            frame.addEventListener('error', onError);
            frame.src = 'office-image://decoder/image-decoder.html';
            document.body.append(frame);
        });
    }
    return heicDecoderFramePromise;
}

async function convertHeic(blob: Blob): Promise<string> {
    if (typeof window.officeDesktop === 'undefined') {
        const { default: heic2any } = await import('heic2any');
        const result = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 });
        return URL.createObjectURL(Array.isArray(result) ? result[0] : result);
    }

    const frame = await getHeicDecoderFrame();
    const requestId = `heic-${++heicRequestSequence}`;
    const input = await blob.arrayBuffer();
    const decoded = await new Promise<{ buffer: ArrayBuffer; mime: string }>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error('Timed out while decoding the HEIC image'));
        }, 30_000);
        const cleanup = () => {
            window.clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
        };
        const onMessage = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow) return;
            if (event.data?.channel !== HEIC_DECODER_CHANNEL || event.data?.id !== requestId) return;
            cleanup();
            if (event.data.type === 'decoded' && event.data.buffer instanceof ArrayBuffer) {
                resolve({ buffer: event.data.buffer, mime: event.data.mime === 'image/jpeg' ? event.data.mime : 'image/jpeg' });
                return;
            }
            reject(new Error(typeof event.data?.error === 'string'
                ? event.data.error
                : 'The isolated HEIC decoder rejected the image'));
        };

        window.addEventListener('message', onMessage);
        frame.contentWindow?.postMessage({
            channel: HEIC_DECODER_CHANNEL,
            type: 'decode',
            id: requestId,
            buffer: input,
        }, '*', [input]);
    });
    return URL.createObjectURL(new Blob([decoded.buffer], { type: decoded.mime }));
}

async function convertTiff(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    if (window.officeDesktop && typeof OffscreenCanvas !== 'undefined') {
        try {
            const png = await decodeTiffInWorker(buffer);
            return URL.createObjectURL(new Blob([png], { type: 'image/png' }));
        } catch (workerError) {
            console.warn('TIFF decoder worker unavailable; using compatibility decoder.', workerError);
        }
    }
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) {
        throw new Error('Invalid TIFF file');
    }
    UTIF.decodeImage(buffer, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const canvas = document.createElement('canvas');
    canvas.width = ifds[0].width;
    canvas.height = ifds[0].height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Failed to create canvas context');
    }
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(rgba), ifds[0].width, ifds[0].height),
        0, 0
    );
    return canvas.toDataURL('image/png');
}

export async function resolveImageSrc(image: ImageSource): Promise<string> {
    const format = getFormatHint(image.src ?? '', image.ext);
    if (format) {
        const blob = await loadImageBlob(image, format);
        if (format === 'heic') {
            return convertHeic(blob);
        }
        return convertTiff(blob);
    }
    if (hasImageBuffer(image)) {
        const mime = image.mime ?? 'application/octet-stream';
        return URL.createObjectURL(bufferToBlob(image.buffer!, mime));
    }
    return image.src ?? '';
}

export function revokeObjectUrl(url: string) {
    if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
    }
}
