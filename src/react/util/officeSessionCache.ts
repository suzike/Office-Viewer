export interface OfficeCachePayload {
    documentCacheId?: string;
    documentCacheKey?: string;
    path?: string;
    lastModified?: number;
    byteLength?: number;
}

/** Stable for one on-disk revision, but changes immediately after save/reload. */
export function officeSessionCacheKey(payload: OfficeCachePayload): string {
    if (payload.documentCacheKey) return payload.documentCacheKey;
    const identity = payload.documentCacheId || payload.path || 'office-document';
    return `${identity}:${payload.lastModified ?? 0}:${payload.byteLength ?? 0}`;
}
