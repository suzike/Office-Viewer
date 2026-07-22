import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, parse } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_CLASS_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const DECOMPILE_TIMEOUT_MS = 30_000

export interface JavaDecompileResult {
  readonly fileName: string
  readonly source: string
}

export class JavaDecompilerService {
  private readonly cache = new Map<string, JavaDecompileResult>()

  constructor(private readonly decompilerJar: string) {}

  async decompile(classPath: string): Promise<JavaDecompileResult> {
    if (extname(classPath).toLowerCase() !== '.class') {
      throw new Error('Only Java .class files can be decompiled.')
    }

    const classStat = await stat(classPath)
    if (!classStat.isFile() || classStat.size > MAX_CLASS_BYTES) {
      throw new Error(`Class file exceeds the ${MAX_CLASS_BYTES} byte limit.`)
    }
    await access(this.decompilerJar)

    const cacheKey = `${classPath}\0${classStat.mtimeMs}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'office-decompile-'))
    try {
      try {
        await execFileAsync('java', [
          '-cp', this.decompilerJar,
          'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler',
          classPath,
          temporaryDirectory,
        ], {
          encoding: 'utf8',
          maxBuffer: MAX_SOURCE_BYTES,
          timeout: DECOMPILE_TIMEOUT_MS,
          windowsHide: true,
        })
      } catch (reason) {
        const error = reason as NodeJS.ErrnoException
        if (error.code === 'ENOENT') {
          throw new Error('Java runtime was not found. Install Java 8 or newer and add java.exe to PATH.')
        }
        throw new Error(`Java decompile failed: ${error.message || String(reason)}`)
      }

      const javaFileName = `${parse(classPath).name}.java`
      const javaFile = join(temporaryDirectory, javaFileName)
      const sourceStat = await stat(javaFile).catch(() => null)
      if (!sourceStat?.isFile() || sourceStat.size > MAX_SOURCE_BYTES) {
        throw new Error(`Decompiler produced no readable output for ${basename(classPath)}.`)
      }

      const result = {
        fileName: javaFileName,
        source: await readFile(javaFile, 'utf8'),
      }
      this.cache.clear()
      this.cache.set(cacheKey, result)
      return result
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
