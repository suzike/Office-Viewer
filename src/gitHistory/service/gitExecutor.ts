import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import type { GitExecutable } from '../types/git';

export const UNABLE_TO_FIND_GIT_MSG =
    'Unable to find Git. Install Git or set "git.path" in VS Code settings.';

const EOL_REGEX = /\r\n|\r|\n/;

function resolveSpawnOutput(
    child: ReturnType<typeof spawn>
): Promise<[number | null, NodeJS.Signals | null, Buffer, Buffer, Error | null]> {
    return new Promise((resolve) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let error: Error | null = null;
        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', (err) => { error = err; });
        child.on('close', (code, signal) => {
            resolve([code, signal, Buffer.concat(stdout), Buffer.concat(stderr), error]);
        });
    });
}

/**
 * Decode a Buffer from git output, with fallback for non-UTF-8 encodings
 * common on Windows (e.g. GBK/CP936 on Chinese systems).
 *
 * Git's `-c i18n.logOutputEncoding=utf-8` should make git output UTF-8, but
 * if a commit was stored without an explicit encoding header git assumes
 * UTF-8 and does no conversion, leaving the raw bytes in the system locale
 * encoding (e.g. GBK). This function detects that case and re-decodes.
 */
function decodeGitOutput(buffer: Buffer): string {
    if (buffer.length === 0) return ''

    // Try strict UTF-8 decoding first — this is the fast path for valid UTF-8.
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
        // Buffer is not valid UTF-8; it may be in the system locale encoding.
    }

    // Try GBK (CP936) — common on Chinese Windows (zh-CN).
    // Also try BIG5 (CP950, Traditional Chinese) and Shift-JIS (CP932, Japanese).
    for (const enc of ['GBK', 'BIG5', 'Shift_JIS']) {
        try {
            const decoded = iconv.decode(buffer, enc)
            // iconv decode never fails silently, but guard against empty result
            if (decoded && decoded.length > 0) {
                return decoded
            }
        } catch {
            continue
        }
    }

    // Last resort: text decode with replacement (never throws, replaces bad bytes)
    return buffer.toString('utf-8')
}

function getErrorMessage(error: Error | null, stdout: Buffer, stderr: Buffer): string {
    if (error) return error.message;
    const stderrLines = decodeGitOutput(stderr).split(EOL_REGEX).map((line) => line.trim()).filter(Boolean);
    const stdoutLines = decodeGitOutput(stdout).split(EOL_REGEX).map((line) => line.trim()).filter(Boolean);
    const lines = [...stderrLines, ...stdoutLines];
    const priorityLine = lines.find((line) =>
        /fatal|error|conflict|failed|aborting|cannot|could not|already exists/i.test(line)
    );
    if (priorityLine) return priorityLine;
    if (stderrLines.length > 0) return stderrLines[0];
    if (stdoutLines.length > 0) return stdoutLines[stdoutLines.length - 1];
    return 'Git command failed';
}

function getWarningMessage(stderr: Buffer): string | null {
    const stderrLines = decodeGitOutput(stderr).split(EOL_REGEX).map((line) => line.trim()).filter(Boolean);
    if (stderrLines.length === 0) {
        return null;
    }
    const priorityLine = stderrLines.find((line) =>
        /warning|ambiguous|deprecated|detached head/i.test(line)
    );
    return priorityLine ?? stderrLines[0];
}

export interface GitSpawnResult<T> {
    value: T;
    warning: string | null;
}

export class GitExecutor {
    constructor(private readonly gitExecutable: GitExecutable) { }

    spawn<T>(args: string[], repo: string, resolveValue: (stdout: string) => T): Promise<T> {
        return this.spawnWithWarning(args, repo, resolveValue).then((result) => result.value);
    }

    spawnWithWarning<T>(args: string[], repo: string, resolveValue: (stdout: string) => T): Promise<GitSpawnResult<T>> {
        return new Promise((resolve, reject) => {
            // Force UTF-8 output encoding and disable path quoting for all git
            // commands to ensure non-ASCII characters (e.g. Chinese, Japanese,
            // Korean) are not garbled on Windows systems where the locale encoding
            // may differ from UTF-8, or where core.quotepath escapes file paths.
            const child = spawn(this.gitExecutable.path, ['-c', 'i18n.logOutputEncoding=utf-8', '-c', 'core.quotepath=false', ...args], {
                cwd: repo,
                env: process.env,
            });
            resolveSpawnOutput(child).then(([code, signal, stdout, stderr, error]) => {
                if (error) return reject(getErrorMessage(error, stdout, stderr));
                if (signal) return reject(`Git process killed by signal ${signal}`);
                if (code !== 0) {
                    return reject(getErrorMessage(null, stdout, stderr));
                }
                try {
                    resolve({
                        value: resolveValue(decodeGitOutput(stdout)),
                        warning: getWarningMessage(stderr),
                    });
                } catch (e) {
                    reject(e instanceof Error ? e.message : String(e));
                }
            });
        });
    }

    async repoRoot(pathOfPotentialRepo: string): Promise<string | null> {
        try {
            const root = await this.spawn(
                ['rev-parse', '--show-toplevel'],
                pathOfPotentialRepo,
                (stdout) => stdout.trim().replace(/\\/g, '/')
            );
            return root || null;
        } catch {
            return null;
        }
    }
}
