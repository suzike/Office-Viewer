import type { FileEntry } from '@zip.js/zip.js';
import type { ZipArchive } from '@/service/zip/zipArchive';

export interface JarInfo {
    mainClass?: string;
    javaMinVersion?: string;
}

const CLASS_MAJOR_TO_JAVA: Record<number, string> = {
    45: '1.1', 46: '1.2', 47: '1.3', 48: '1.4', 49: '5',
    50: '6', 51: '7', 52: '8', 53: '9', 54: '10', 55: '11',
    56: '12', 57: '13', 58: '14', 59: '15', 60: '16',
    61: '17', 62: '18', 63: '19', 64: '20', 65: '21',
    66: '22', 67: '23',
};

const CLASS_SCAN_BATCH_SIZE = 32;
const CLASS_SCAN_LIMIT = 300;

function parseManifest(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    let currentKey: string | null = null;

    for (const line of content.split(/\r?\n/)) {
        if (line.startsWith(' ') && currentKey) {
            result[currentKey] += line.slice(1);
            continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0) {
            currentKey = null;
            continue;
        }
        currentKey = line.slice(0, colon).trim();
        result[currentKey] = line.slice(colon + 1).trim();
    }
    return result;
}

function formatJavaVersion(version: string): string {
    if (version === '1.8' || version === '8') return 'Java 8';
    if (version.startsWith('1.')) return `Java ${version.slice(2)}`;
    return `Java ${version}`;
}

function parseManifestJavaVersion(manifest: Record<string, string>): string | undefined {
    const buildJdkSpec = manifest['Build-Jdk-Spec'];
    if (buildJdkSpec) {
        const match = buildJdkSpec.match(/^(\d+(?:\.\d+)?)/);
        if (match) return formatJavaVersion(match[1]);
    }

    const buildJdk = manifest['Build-Jdk'];
    if (buildJdk) {
        const match = buildJdk.match(/^(\d+(?:\.\d+)?)/);
        if (match) return formatJavaVersion(match[1]);
    }

    const executionEnv = manifest['Bundle-RequiredExecutionEnvironment'];
    if (executionEnv) {
        const match = executionEnv.match(/JavaSE[-](\d+(?:\.\d+)?)/i);
        if (match) return formatJavaVersion(match[1]);
    }

    return undefined;
}

function compareJavaVersion(a: string, b: string): number {
    const parse = (value: string) => {
        const match = value.match(/Java\s+(\d+(?:\.\d+)?)/i);
        if (!match) return 0;
        const version = match[1];
        if (version.includes('.')) {
            const [major, minor] = version.split('.');
            return Number(major) + Number(minor) / 10;
        }
        return Number(version);
    };
    return parse(a) - parse(b);
}

function maxJavaVersion(current: string | undefined, next: string | undefined): string | undefined {
    if (!next) return current;
    if (!current) return next;
    return compareJavaVersion(next, current) > 0 ? next : current;
}

function findEntryKey(entries: string[], matcher: (key: string) => boolean): string | undefined {
    for (const key of entries) {
        if (matcher(key)) return key;
    }
    return undefined;
}

function maxMultiReleaseVersion(entries: string[]): string | undefined {
    let maxVersion: number | undefined;
    for (const name of entries) {
        const match = name.match(/^META-INF\/versions\/(\d+)\//i);
        if (!match) continue;
        const version = Number(match[1]);
        if (!maxVersion || version > maxVersion) maxVersion = version;
    }
    return maxVersion !== undefined ? formatJavaVersion(String(maxVersion)) : undefined;
}

function majorVersionToJava(major: number): string | undefined {
    const mapped = CLASS_MAJOR_TO_JAVA[major];
    if (mapped) return formatJavaVersion(mapped);
    if (major >= 68) return formatJavaVersion(String(major - 44));
    return undefined;
}

function readClassMajorVersion(buffer: Buffer): number | undefined {
    if (buffer.length < 8) return undefined;
    if (buffer.readUInt32BE(0) !== 0xCAFEBABE) return undefined;
    return buffer.readUInt16BE(6);
}

async function maxClassFileJavaVersion(
    archive: ZipArchive,
    fileMap: Record<string, FileEntry>,
    classEntries: string[],
): Promise<string | undefined> {
    let maxMajor = 0;
    const limit = Math.min(classEntries.length, CLASS_SCAN_LIMIT);

    for (let offset = 0; offset < limit; offset += CLASS_SCAN_BATCH_SIZE) {
        const batch = classEntries.slice(offset, offset + CLASS_SCAN_BATCH_SIZE);
        const majors = await Promise.all(batch.map(async (entryName) => {
            try {
                const buf = await archive.readEntry(fileMap[entryName]);
                return readClassMajorVersion(buf);
            } catch {
                return undefined;
            }
        }));
        for (const major of majors) {
            if (major !== undefined && major > maxMajor) maxMajor = major;
        }
    }

    return maxMajor > 0 ? majorVersionToJava(maxMajor) : undefined;
}

export async function parseJarInfo(
    archive: ZipArchive,
    fileMap: Record<string, FileEntry>,
): Promise<JarInfo> {
    const entries = Object.keys(fileMap);
    const classEntries: string[] = [];
    for (const name of entries) {
        if (name.endsWith('.class')) classEntries.push(name);
    }

    let manifest: Record<string, string> | undefined;
    const manifestKey = findEntryKey(entries, key => key.toUpperCase() === 'META-INF/MANIFEST.MF');
    if (manifestKey) {
        try {
            const buf = await archive.readEntry(fileMap[manifestKey]);
            manifest = parseManifest(buf.toString('utf-8'));
        } catch {
            // encrypted or malformed manifest
        }
    }

    let javaMinVersion = maxMultiReleaseVersion(entries);
    javaMinVersion = maxJavaVersion(javaMinVersion, manifest ? parseManifestJavaVersion(manifest) : undefined);
    if (!javaMinVersion) {
        javaMinVersion = await maxClassFileJavaVersion(archive, fileMap, classEntries);
    }

    return {
        mainClass: manifest?.['Main-Class'],
        javaMinVersion,
    };
}
