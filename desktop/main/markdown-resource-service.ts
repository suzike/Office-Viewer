import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { FileSessionManager } from './file-session-manager'

const WORKSPACE_MARKERS = ['.git', '.vscode'] as const

/**
 * Resolve an image or other Markdown resource relative to the nearest project
 * root. VS Code supplies its workspace folder for this setting; the standalone
 * desktop application uses the closest .git/.vscode ancestor as the equivalent
 * project boundary and falls back to the document directory.
 */
export async function resolveMarkdownWorkspaceResource(
  sessions: FileSessionManager,
  sessionId: string,
  resourcePath: string,
): Promise<string> {
  assertRelativeResourcePath(resourcePath)
  const documentPath = sessions.getPath(sessionId)
  const workspaceDirectory = await findMarkdownWorkspaceDirectory(documentPath)
  const candidate = await realpath(resolve(workspaceDirectory, resourcePath))
  const pathFromWorkspace = relative(workspaceDirectory, candidate)
  if (
    pathFromWorkspace === '' ||
    pathFromWorkspace === '..' ||
    pathFromWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(pathFromWorkspace)
  ) {
    throw new Error('The requested resource is outside the Markdown workspace.')
  }

  const resourceStat = await stat(candidate)
  if (!resourceStat.isFile()) throw new Error('Only regular Markdown workspace resources can be loaded.')
  return candidate
}

export async function findMarkdownWorkspaceDirectory(documentPath: string): Promise<string> {
  let current = await realpath(dirname(documentPath))
  const fallback = current
  for (;;) {
    for (const marker of WORKSPACE_MARKERS) {
      try {
        await stat(join(current, marker))
        return current
      } catch {
        // Continue looking at this directory and then its parent.
      }
    }
    const parent = dirname(current)
    if (parent === current) return fallback
    current = parent
  }
}

function assertRelativeResourcePath(resourcePath: string): void {
  if (
    typeof resourcePath !== 'string' ||
    resourcePath.length === 0 ||
    resourcePath.length > 4_096 ||
    resourcePath.includes('\0') ||
    isAbsolute(resourcePath)
  ) {
    throw new TypeError('A valid workspace-relative Markdown resource path is required.')
  }
}
