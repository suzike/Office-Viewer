export interface JarInfo {
    mainClass?: string;
    javaMinVersion?: string;
}

export interface CompressInfo {
    fileName: string;
    files: FileInfo[];
    folderMap: { [key: string]: FileInfo };
    jarInfo?: JarInfo;
}

export class FileInfo {
    name?: string;
    isDirectory?: boolean;
    entryName?: string;
    children?: FileInfo[]
    header?: EntryHeader;
    fileSize?: string;
    fileSizeOrigin?: number;
    compressedSize?: string;
    compressedSizeOrigin?: number;
    modifyDateTime?: string | null;
    encrypted?: boolean;
}

interface EntryHeader {
    time: Date | string;
    compressedSize: number;
    size: number;
}
