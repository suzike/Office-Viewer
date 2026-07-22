/// <reference lib="webworker" />

import * as UTIF from 'utif';

interface TiffDecodeRequest {
    id: number;
    buffer: ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<TiffDecodeRequest>) => {
    const { id, buffer } = event.data;
    try {
        const ifds = UTIF.decode(buffer);
        if (!ifds.length) throw new Error('Invalid TIFF file');
        UTIF.decodeImage(buffer, ifds[0]);
        const width = ifds[0].width;
        const height = ifds[0].height;
        const rgba = UTIF.toRGBA8(ifds[0]);
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Failed to create offscreen canvas context');
        context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const png = await blob.arrayBuffer();
        self.postMessage({ id, png }, [png]);
    } catch (reason) {
        self.postMessage({ id, error: reason instanceof Error ? reason.message : String(reason) });
    }
};

export {};
