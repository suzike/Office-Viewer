import { spawn } from 'node:child_process'
import { clipboard, dialog, shell, type BrowserWindow } from 'electron'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import iconv from 'iconv-lite'
import type {
  DesktopGitHistoryEvent,
  DesktopGitHistoryInit,
  DesktopGitHistoryPreview,
  DesktopGitHistoryResponse,
} from '../shared/desktop-api'

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 45_000
const NETWORK_TIMEOUT_MS = 120_000
const MAX_DISCOVERY_DIRECTORIES = 500
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const UNCOMMITTED = '*'
const MUTATING_ACTIONS = new Set([
  'checkoutBranch', 'checkoutCommit', 'createBranch', 'deleteBranch', 'renameBranch',
  'deleteRemoteBranch', 'pullBranch', 'pushBranch', 'merge', 'cherryPick', 'revertCommit',
  'resetToCommit', 'addTag', 'deleteTag', 'pushTag', 'applyStash', 'popStash', 'dropStash',
  'branchFromStash', 'pushStash', 'resetUncommitted', 'cleanUntracked',
])
const NATIVE_CONFIRM_ACTIONS = new Set([
  'deleteBranch', 'deleteRemoteBranch', 'revertCommit', 'resetToCommit', 'deleteTag',
  'dropStash', 'resetUncommitted', 'cleanUntracked',
])

interface GitResult {
  stdout: string
  stderr: string
}

interface StashRecord {
  hash: string
  baseHash: string
  untrackedFilesHash: string | null
  selector: string
  author: string
  email: string
  date: number
  message: string
}

interface RepoInfo {
  branches: string[]
  head: string | null
  remotes: string[]
  stashes: StashRecord[]
  authors: string[]
  hasRemoteUrl: boolean
  remoteWebUrls: Array<{ name: string; url: string }>
  error: string | null
}

interface HistoryRequest {
  repo: string
  branches: string[] | null
  maxCommits: number
  showTags: boolean
  showRemoteBranches: boolean
  includeCommitsMentionedByReflogs: boolean
  onlyFollowFirstParent: boolean
  commitOrdering: 'date' | 'author-date' | 'topo'
  hideRemotes: string[]
  remotes?: string[]
  stashes?: StashRecord[]
  author?: string
  searchValue?: string
  relPath?: string
  showStashes?: boolean
}

class SafeGitExecutor {
  constructor(private readonly executable = 'git') {}

  run(repo: string, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GitResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.executable, [
        '-c', 'i18n.logOutputEncoding=utf-8',
        '-c', 'core.quotepath=false',
        '-c', 'color.ui=false',
        ...args,
      ], {
        cwd: repo,
        windowsHide: true,
        env: { ...process.env, GIT_PAGER: 'cat', GIT_EDITOR: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error(`Git command timed out after ${Math.round(timeoutMs / 1000)} seconds.`))
      }, timeoutMs)
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        if (settled) return
        bytes += chunk.byteLength
        if (bytes > MAX_OUTPUT_BYTES) {
          settled = true
          clearTimeout(timer)
          child.kill()
          reject(new Error('Git command output exceeded the 16 MB safety limit.'))
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const out = decodeGitOutput(Buffer.concat(stdout))
        const err = decodeGitOutput(Buffer.concat(stderr))
        if (signal) return reject(new Error(`Git process was terminated by ${signal}.`))
        if (code !== 0) return reject(new Error(selectGitError(err, out)))
        resolvePromise({ stdout: out, stderr: err })
      })
    })
  }
}

export class GitHistoryService {
  private readonly git = new SafeGitExecutor()
  private readonly authorizedRepos = new Map<string, string>()
  private readonly watchers = new Map<string, FSWatcher>()
  private changeTimer: NodeJS.Timeout | undefined
  private lastActiveRepo: string | null = null
  private loadRepositoryId = 0
  private loadRepoInfoId = 0
  private loadCommitsId = 0

  constructor(private readonly onRepositoriesChanged?: (repos: readonly string[]) => void) {}

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  async selectRepositories(window: BrowserWindow): Promise<DesktopGitHistoryInit | null> {
    const result = await dialog.showOpenDialog(window, {
      title: 'Select Git repository or workspace folder',
      properties: ['openDirectory', 'multiSelections'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const repos: string[] = []
    for (const folder of result.filePaths) {
      for (const repo of await this.discover(folder, 2)) {
        if (!repos.includes(repo)) repos.push(repo)
      }
    }
    if (repos.length === 0) {
      throw new Error('No Git repository was found in the selected folder (search depth: 2).')
    }
    repos.sort((a, b) => a.localeCompare(b))
    return this.initPayload(repos, repos[0])
  }

  async selectFileHistory(window: BrowserWindow): Promise<DesktopGitHistoryInit | null> {
    const result = await dialog.showOpenDialog(window, {
      title: 'Select a file to view its Git history',
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return this.openFileHistory(result.filePaths[0])
  }

  async openFileHistory(selectedPath: string): Promise<DesktopGitHistoryInit> {
    const filePath = await realpath(selectedPath)
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) throw new Error('Git file history requires a regular file.')
    const root = await this.resolveRepoRoot(resolve(filePath, '..'))
    if (!root) throw new Error('The selected file is not inside a Git repository.')
    const repo = await realpath(root)
    this.authorizedRepos.set(normalizePath(repo), repo)
    await this.watchRepository(repo)
    return {
      ...this.initPayload(this.repos, repo),
      filePath,
      fileName: basename(filePath),
      relPath: this.relativePath(repo, relative(repo, filePath)),
    }
  }

  async request(window: BrowserWindow, rawType: unknown, content: unknown): Promise<DesktopGitHistoryResponse> {
    const type = requireShortString(rawType, 'request type', 64)
    switch (type) {
      case 'ready':
        return this.events({ type: 'repos', content: { repos: this.repos } })
      case 'loadRepository':
        return this.loadRepository(requireRecord(content) as unknown as HistoryRequest)
      case 'loadRepoInfo':
        return this.loadRepoInfo(requireRecord(content))
      case 'loadCommits':
        return this.loadCommits(requireRecord(content) as unknown as HistoryRequest)
      case 'commitDetails':
        return this.commitDetails(requireRecord(content))
      case 'refresh':
        return this.events(
          { type: 'repos', content: { repos: this.repos } },
          { type: 'refresh', content: { repos: this.repos } },
        )
      case 'fetch':
        return this.simpleNetwork('fetch', requireRecord(content), async (repo) => {
          await this.git.run(repo, ['fetch', '--all', '--prune'], NETWORK_TIMEOUT_MS)
        })
      case 'pull':
        return this.pull(requireRecord(content))
      case 'push':
        return this.push(window, requireRecord(content))
      case 'quickSync':
        return this.quickSync(window, requireRecord(content))
      case 'quickSyncCommand':
        return this.quickSyncCommand(window, requireRecord(content))
      case 'loadRepoConfig':
        return this.loadRepoConfig(requireRecord(content))
      case 'remoteAction':
        return this.remoteAction(window, requireRecord(content))
      case 'queryRemoteWebUrls':
        return this.remoteWebUrls(requireRecord(content))
      case 'openRemote':
        await shell.openExternal(requireWebUrl(requireRecord(content).url))
        return this.events()
      case 'gitAction':
        return this.gitAction(window, requireRecord(content))
      case 'openExternal':
        await shell.openExternal(requireWebUrl(content))
        return this.events()
      case 'saveFileHistorySplitLayout':
      case 'updateConfig':
      case 'editorLayoutSingle':
      case 'openSponsor':
        return this.events()
      default:
        throw new Error(`Unsupported Git History request: ${type}`)
    }
  }

  private get repos(): string[] {
    return [...this.authorizedRepos.values()].sort((a, b) => a.localeCompare(b))
  }

  private initPayload(repos: string[], initialRepo: string | null): DesktopGitHistoryInit {
    return {
      repos,
      initialRepo,
      preferredRepo: initialRepo,
      filePath: null,
      fileName: null,
      relPath: null,
      fileHistorySplitLayout: 'vertical',
    }
  }

  private async discover(folder: string, maxDepth: number): Promise<string[]> {
    const found: string[] = []
    let visited = 0
    const walk = async (candidate: string, depth: number): Promise<void> => {
      if (++visited > MAX_DISCOVERY_DIRECTORIES) return
      const root = await this.resolveRepoRoot(candidate)
      if (root) {
        const real = await realpath(root)
        const key = normalizePath(real)
        this.authorizedRepos.set(key, real)
        await this.watchRepository(real)
        found.push(real)
        return
      }
      if (depth >= maxDepth) return
      let entries
      try {
        entries = await readdir(candidate, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        await walk(resolve(candidate, entry.name), depth + 1)
      }
    }
    await walk(await realpath(folder), 0)
    return [...new Set(found)]
  }

  private async resolveRepoRoot(folder: string): Promise<string | null> {
    try {
      const { stdout } = await this.git.run(folder, ['rev-parse', '--show-toplevel'], 10_000)
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  private async watchRepository(repo: string): Promise<void> {
    const key = normalizePath(repo)
    if (this.watchers.has(key)) return
    try {
      const gitDirText = (await this.git.run(repo, ['rev-parse', '--absolute-git-dir'], 10_000)).stdout.trim()
      const gitDirectory = await realpath(gitDirText)
      const watcher = watch(gitDirectory, { recursive: process.platform === 'win32' || process.platform === 'darwin' }, () => {
        if (this.changeTimer) clearTimeout(this.changeTimer)
        this.changeTimer = setTimeout(() => this.onRepositoriesChanged?.(this.repos), 250)
      })
      watcher.on('error', () => {
        watcher.close()
        this.watchers.delete(key)
      })
      this.watchers.set(key, watcher)
    } catch {
      // Refresh remains available even when a filesystem does not support watching.
    }
  }

  private repo(value: unknown): string {
    const requested = requireShortString(value, 'repository', 32_768)
    const authorized = this.authorizedRepos.get(normalizePath(resolve(requested)))
    if (!authorized) throw new Error('The repository has not been authorized. Select it again from Git History.')
    this.lastActiveRepo = authorized
    return authorized
  }

  private async loadRepository(request: HistoryRequest): Promise<DesktopGitHistoryResponse> {
    const requestId = ++this.loadRepositoryId
    const repo = this.repo(request.repo)
    try {
      const [repoInfo, commitData, extras] = await Promise.all([
        this.getRepoInfo(repo, request.showRemoteBranches !== false, request.showStashes !== false, request.hideRemotes ?? []),
        this.getCommits(repo, request),
        this.getRepoExtras(repo, request),
      ])
      if (requestId !== this.loadRepositoryId) return this.events()
      return this.events(
        { type: 'repositoryLoaded', content: { repoInfo, commitData, relPath: request.relPath ?? null } },
        { type: 'repoExtras', content: extras },
      )
    } catch (error) {
      if (requestId !== this.loadRepositoryId) return this.events()
      const message = errorMessage(error)
      const repoInfo = emptyRepoInfo(message)
      return this.events({
        type: 'repositoryLoaded',
        content: { repoInfo, commitData: emptyCommitData(message), relPath: request.relPath ?? null },
      })
    }
  }

  private async loadRepoInfo(content: Record<string, unknown>): Promise<DesktopGitHistoryResponse> {
    const requestId = ++this.loadRepoInfoId
    const repo = this.repo(content.repo)
    try {
      const info = await this.getRepoInfo(repo, content.showRemoteBranches !== false, content.showStashes !== false, [])
      const extras = await this.getRepoExtras(repo, defaultHistoryRequest(repo))
      if (requestId !== this.loadRepoInfoId) return this.events()
      return this.events({ type: 'repoInfo', content: info }, { type: 'repoExtras', content: extras })
    } catch (error) {
      if (requestId !== this.loadRepoInfoId) return this.events()
      return this.events({ type: 'repoInfo', content: emptyRepoInfo(errorMessage(error)) })
    }
  }

  private async loadCommits(request: HistoryRequest): Promise<DesktopGitHistoryResponse> {
    const requestId = ++this.loadCommitsId
    const repo = this.repo(request.repo)
    try {
      const [data, extras] = await Promise.all([
        this.getCommits(repo, request),
        this.getRepoExtras(repo, request),
      ])
      if (requestId !== this.loadCommitsId) return this.events()
      return this.events(
        { type: 'commits', content: { ...data, relPath: request.relPath ?? null } },
        { type: 'repoExtras', content: extras },
      )
    } catch (error) {
      if (requestId !== this.loadCommitsId) return this.events()
      return this.events({ type: 'commits', content: emptyCommitData(errorMessage(error)) })
    }
  }

  private async getRepoInfo(repo: string, remoteBranches: boolean, stashes: boolean, hideRemotes: string[]): Promise<RepoInfo> {
    const [branchData, remotes, stashList, remoteWebUrls] = await Promise.all([
      this.getBranches(repo, remoteBranches, hideRemotes),
      this.lines(repo, ['remote']),
      stashes ? this.getStashes(repo) : Promise.resolve([]),
      this.getRemoteWebUrls(repo),
    ])
    return {
      branches: branchData.branches,
      head: branchData.head,
      remotes,
      stashes: stashList,
      authors: [],
      hasRemoteUrl: remoteWebUrls.length > 0,
      remoteWebUrls,
      error: null,
    }
  }

  private async getBranches(repo: string, includeRemotes: boolean, hideRemotes: string[]) {
    const args = ['branch', '--no-color']
    if (includeRemotes) args.push('-a')
    const lines = await this.lines(repo, args)
    const branches: string[] = []
    let head: string | null = null
    for (const line of lines) {
      const current = line.startsWith('* ')
      const name = line.slice(2).split(' -> ')[0]
      if (!name || /^\(.* .*\)$/.test(name) || /\/HEAD$/.test(name)) continue
      if (hideRemotes.some((remote) => name.toLowerCase().startsWith(`remotes/${remote}/`.toLowerCase()))) continue
      if (current) {
        head = name
        branches.unshift(name)
      } else branches.push(name)
    }
    return { branches, head }
  }

  private async getStashes(repo: string): Promise<StashRecord[]> {
    try {
      const { stdout } = await this.git.run(repo, [
        'reflog', '--format=%H%x1f%gD%x1f%P%x1f%aN%x1f%aE%x1f%at%x1f%s%x1e', 'refs/stash', '--',
      ])
      return stdout.split('\x1e').map((record) => record.replace(/^\r?\n/, '')).filter(Boolean).map((record) => {
        const [hash, selector, parentText, author, email, date, ...message] = record.split('\x1f')
        const parents = parentText ? parentText.split(' ') : []
        return {
          hash, selector, baseHash: parents[0] ?? '', untrackedFilesHash: parents[1] ?? null,
          author, email, date: Number(date), message: message.join('\x1f').trim(),
        }
      })
    } catch {
      return []
    }
  }

  private async getCommits(repo: string, request: HistoryRequest) {
    const max = Math.max(1, Math.min(Number(request.maxCommits) || 300, 5000))
    const stashes = request.stashes ?? await this.getStashes(repo)
    const remotes = request.remotes ?? await this.lines(repo, ['remote'])
    const args = [
      '-c', 'log.showSignature=false', 'log', `--max-count=${max + 1}`,
      '--format=%H%x1f%P%x1f%aN%x1f%aE%x1f%at%x1f%s%x1e',
      `--${requireOrdering(request.commitOrdering)}-order`,
    ]
    if (request.onlyFollowFirstParent) args.push('--first-parent')
    if (request.author) args.push(`--author=${requireFilter(request.author, 'author')}`)
    if (request.searchValue) args.push(`--grep=${requireFilter(request.searchValue, 'search')}`)
    if (request.branches?.length) {
      args.push(...request.branches.map((branch) => requireRef(branch, 'branch')))
    } else {
      args.push('--branches')
      if (request.showTags !== false) args.push('--tags')
      if (request.includeCommitsMentionedByReflogs) args.push('--reflog')
      if (request.showRemoteBranches !== false) {
        const hidden = request.hideRemotes ?? []
        if (hidden.length === 0) args.push('--remotes')
        else for (const remote of remotes) if (!hidden.includes(remote)) args.push(`--glob=refs/remotes/${requireRef(remote, 'remote')}`)
      }
      for (const hash of [...new Set(stashes.map((stash) => stash.baseHash))]) if (hash) args.push(requireHash(hash))
      args.push('HEAD')
    }
    if (request.relPath) args.push('--follow')
    args.push('--')
    if (request.relPath) args.push(this.relativePath(repo, request.relPath))
    const { stdout } = await this.git.run(repo, args)
    const records = stdout.split('\x1e').map((record) => record.replace(/^\r?\n/, '')).filter(Boolean).map((record) => {
      const [hash, parentText, author, email, date, ...message] = record.split('\x1f')
      return {
        hash, parents: parentText ? parentText.split(' ') : [], author, email,
        date: Number(date), message: message.join('\x1f').trim(), heads: [] as string[], tags: [] as Array<{ name: string; annotated: boolean }>,
        remotes: [] as Array<{ name: string; remote: string | null }>, stash: null as null | { selector: string; baseHash: string; untrackedFilesHash: string | null },
        onCurrentBranch: false,
      }
    })
    const moreCommitsAvailable = records.length > max
    const commits = records.slice(0, max)
    const refs = await this.getRefs(repo, request.showRemoteBranches !== false, request.hideRemotes ?? [])
    let lookup = new Map(commits.map((commit, index) => [commit.hash, index]))
    const missingStashes: Array<{ index: number; stash: StashRecord }> = []
    for (const stash of stashes) {
      const existing = lookup.get(stash.hash)
      if (existing !== undefined) {
        commits[existing].stash = { selector: stash.selector, baseHash: stash.baseHash, untrackedFilesHash: stash.untrackedFilesHash }
      } else {
        const baseIndex = lookup.get(stash.baseHash)
        if (baseIndex !== undefined) missingStashes.push({ index: baseIndex, stash })
      }
    }
    missingStashes.sort((a, b) => a.index !== b.index ? a.index - b.index : b.stash.date - a.stash.date)
    for (let index = missingStashes.length - 1; index >= 0; index--) {
      const { stash } = missingStashes[index]
      commits.splice(missingStashes[index].index, 0, {
        hash: stash.hash, parents: [stash.baseHash], author: stash.author, email: stash.email,
        date: stash.date, message: stash.message, heads: [], tags: [], remotes: [],
        stash: { selector: stash.selector, baseHash: stash.baseHash, untrackedFilesHash: stash.untrackedFilesHash },
        onCurrentBranch: true,
      })
    }
    lookup = new Map(commits.map((commit, index) => [commit.hash, index]))
    for (const ref of refs.heads) {
      const index = lookup.get(ref.hash); if (index !== undefined) commits[index].heads.push(ref.name)
    }
    if (request.showTags !== false) for (const ref of refs.tags) {
      const index = lookup.get(ref.hash); if (index !== undefined) commits[index].tags.push({ name: ref.name, annotated: ref.annotated })
    }
    for (const ref of refs.remotes) {
      const index = lookup.get(ref.hash)
      if (index !== undefined) {
        const slash = ref.name.indexOf('/')
        const remoteName = slash > 0 ? remotes.find((remote) => remote.toLowerCase() === ref.name.slice(0, slash).toLowerCase()) ?? null : null
        commits[index].remotes.push({ name: remoteName ? `${remoteName}${ref.name.slice(slash)}` : ref.name, remote: remoteName })
      }
    }
    const ancestors = refs.head ? new Set(await this.lines(repo, ['rev-list', refs.head])) : new Set<string>()
    for (const commit of commits) commit.onCurrentBranch = !refs.head || ancestors.has(commit.hash) || commit.stash !== null
    if (refs.head && lookup.has(refs.head)) {
      const changes = await this.lines(repo, ['status', '--porcelain', '--untracked-files=all']).catch(() => [])
      if (changes.length > 0) commits.unshift({
        hash: UNCOMMITTED, parents: [refs.head], author: '*', email: '', date: Math.round(Date.now() / 1000),
        message: `Uncommitted Changes (${changes.length})`, heads: [], tags: [], remotes: [], stash: null, onCurrentBranch: true,
      })
    }
    return { commits, head: refs.head, tags: [...new Set(refs.tags.map((tag) => tag.name))], moreCommitsAvailable, error: null }
  }

  private async getRefs(repo: string, includeRemotes: boolean, hideRemotes: string[]) {
    const { stdout } = await this.git.run(repo, ['show-ref', '-d', '--head']).catch((error) => {
      if (/no refs|does not have any commits|not a valid ref/i.test(errorMessage(error))) return { stdout: '', stderr: '' }
      throw error
    })
    const result = { head: null as string | null, heads: [] as Array<{ hash: string; name: string }>, tags: [] as Array<{ hash: string; name: string; annotated: boolean }>, remotes: [] as Array<{ hash: string; name: string }> }
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      const split = line.indexOf(' '); if (split < 0) continue
      const hash = line.slice(0, split); const ref = line.slice(split + 1)
      if (ref === 'HEAD') result.head = hash
      else if (ref.startsWith('refs/heads/')) result.heads.push({ hash, name: ref.slice(11) })
      else if (ref.startsWith('refs/tags/')) {
        const annotated = ref.endsWith('^{}')
        const name = annotated ? ref.slice(10, -3) : ref.slice(10)
        const prior = result.tags.findIndex((tag) => tag.name === name)
        const value = { hash, name, annotated }
        if (prior >= 0) { if (annotated) result.tags[prior] = value } else result.tags.push(value)
      } else if (includeRemotes && ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
        const name = ref.slice(13)
        if (!hideRemotes.some((remote) => name.toLowerCase().startsWith(`${remote}/`.toLowerCase()))) result.remotes.push({ hash, name })
      }
    }
    return result
  }

  private async getRepoExtras(repo: string, request: HistoryRequest) {
    const [authors, remoteWebUrls] = await Promise.all([this.getAuthors(repo, request), this.getRemoteWebUrls(repo)])
    return { authors, hasRemoteUrl: remoteWebUrls.length > 0, remoteWebUrls }
  }

  private async getAuthors(repo: string, request: HistoryRequest): Promise<string[]> {
    const args = ['-c', 'log.showSignature=false', 'log', '--format=%aN', '--all']
    if (request.onlyFollowFirstParent) args.push('--first-parent')
    if (request.searchValue) args.push(`--grep=${requireFilter(request.searchValue, 'search')}`)
    if (request.relPath) args.push('--follow')
    args.push('--')
    if (request.relPath) args.push(this.relativePath(repo, request.relPath))
    return [...new Set(await this.lines(repo, args).catch(() => []))].sort((a, b) => a.localeCompare(b))
  }

  private async commitDetails(content: Record<string, unknown>): Promise<DesktopGitHistoryResponse> {
    const repo = this.repo(content.repo)
    const hash = content.commitHash === UNCOMMITTED ? UNCOMMITTED : requireHash(content.commitHash)
    try {
      const details = hash === UNCOMMITTED
        ? await this.uncommittedDetails(repo)
        : await this.revisionDetails(repo, hash, Boolean(content.hasParents))
      return this.events({ type: 'commitDetails', content: { commitDetails: details, error: null } })
    } catch (error) {
      return this.events({ type: 'commitDetails', content: { commitDetails: null, error: errorMessage(error) } })
    }
  }

  private async revisionDetails(repo: string, hash: string, hasParents: boolean) {
    const { stdout } = await this.git.run(repo, ['-c', 'log.showSignature=false', 'show', '--quiet', hash, '--format=%H%x1f%P%x1f%aN%x1f%aE%x1f%at%x1f%cN%x1f%cE%x1f%ct%x1f%B'])
    const [commitHash, parents, author, authorEmail, authorDate, committer, committerEmail, committerDate, ...body] = stdout.split('\x1f')
    return {
      hash: commitHash, parents: parents ? parents.split(' ') : [], author, authorEmail, authorDate: Number(authorDate),
      committer, committerEmail, committerDate: Number(committerDate), body: body.join('\x1f').trim(),
      fileChanges: await this.fileChanges(repo, hasParents ? `${hash}^` : EMPTY_TREE_HASH, hash),
    }
  }

  private async uncommittedDetails(repo: string) {
    const [status, stats] = await Promise.all([
      this.lines(repo, ['status', '--porcelain', '--untracked-files=all']),
      this.lines(repo, ['diff', '--numstat', 'HEAD']).catch(() => []),
    ])
    const fileChanges = status.map((line) => {
      const statusText = line.slice(0, 2); const path = line.slice(3); const arrow = path.indexOf(' -> ')
      const oldFilePath = arrow >= 0 ? path.slice(0, arrow) : path
      const newFilePath = arrow >= 0 ? path.slice(arrow + 4) : path
      const code = statusText === '??' ? 'U' : statusText.includes('D') ? 'D' : statusText.includes('A') ? 'A' : arrow >= 0 ? 'R' : 'M'
      const statLine = stats.find((stat) => stat.split('\t')[2] === newFilePath)
      const [additions, deletions] = statLine ? statLine.split('\t') : []
      return {
        oldFilePath, newFilePath, type: code,
        additions: additions && additions !== '-' ? Number(additions) : null,
        deletions: deletions && deletions !== '-' ? Number(deletions) : null,
      }
    })
    return { hash: UNCOMMITTED, parents: [], author: '', authorEmail: '', authorDate: Math.round(Date.now() / 1000), committer: '', committerEmail: '', committerDate: Math.round(Date.now() / 1000), body: '', fileChanges }
  }

  private async fileChanges(repo: string, from: string, to: string) {
    const [names, stats] = await Promise.all([
      this.lines(repo, ['diff', '--name-status', from, to]),
      this.lines(repo, ['diff', '--numstat', from, to]),
    ])
    const changes = names.map((line) => {
      const parts = line.split('\t'); const type = parts[0][0]; const renamed = type === 'R'
      return { oldFilePath: parts[1], newFilePath: renamed ? parts[2] : parts[1], type, additions: null as number | null, deletions: null as number | null }
    })
    for (const line of stats) {
      const [adds, deletes, file] = line.split('\t'); const change = changes.find((item) => item.newFilePath === file || item.oldFilePath === file)
      if (change) { change.additions = adds === '-' ? null : Number(adds); change.deletions = deletes === '-' ? null : Number(deletes) }
    }
    return changes
  }

  private async simpleNetwork(event: string, content: Record<string, unknown>, operation: (repo: string) => Promise<void>) {
    try { await operation(this.repo(content.repo)); return this.events({ type: event, content: { error: null } }) }
    catch (error) { return this.events({ type: event, content: { error: errorMessage(error) } }) }
  }

  private async pull(content: Record<string, unknown>) {
    return this.simpleNetwork('pull', content, async (repo) => {
      const args = ['pull']
      if (content.noFastForward) args.push('--no-ff')
      if (content.squash) args.push('--squash')
      args.push(requireRef(content.remote, 'remote'), requireRef(content.branch, 'branch'))
      await this.git.run(repo, args, NETWORK_TIMEOUT_MS)
    })
  }

  private async push(window: BrowserWindow, content: Record<string, unknown>) {
    try {
      const repo = this.repo(content.repo); const branch = requireRef(content.branch, 'branch')
      if (content.force === true) {
        const answer = await dialog.showMessageBox(window, {
          type: 'warning', buttons: ['Cancel', 'Force Push'], defaultId: 0, cancelId: 0,
          title: 'Confirm force push', message: `Force push branch “${branch}” with lease?`, detail: repo,
        })
        if (answer.response !== 1) return this.events({ type: 'push', content: { error: null, cancelled: true } })
      }
      const remotes = Array.isArray(content.remotes) ? content.remotes : [content.remote]
      for (const remote of remotes) {
        const args = ['push']; if (content.force) args.push('--force-with-lease'); args.push('-u', requireRef(remote, 'remote'), branch)
        await this.git.run(repo, args, NETWORK_TIMEOUT_MS)
      }
      return this.events({ type: 'push', content: { error: null, cancelled: false } })
    } catch (error) {
      return this.events({ type: 'push', content: { error: errorMessage(error), cancelled: false } })
    }
  }

  private async quickSync(window: BrowserWindow, content: Record<string, unknown>) {
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0,
      title: 'Confirm Quick Sync', message: 'Quick Sync may stage and commit all working-tree changes, then pull and push.',
      detail: this.repo(content.repo),
    })
    if (confirmation.response !== 1) return this.events({ type: 'quickSync', content: { error: null, cancelled: true } })
    try {
      const repo = this.repo(content.repo); const branch = requireRef(content.branch, 'branch')
      const remote = content.remote ? requireRef(content.remote, 'remote') : ''
      if ((await this.lines(repo, ['status', '--porcelain', '--untracked-files=all'])).length) {
        await this.git.run(repo, ['add', '-A'])
        await this.git.run(repo, ['commit', '-m', requireFilter(content.commitMessage || 'Quick Sync', 'commit message')]).catch((error) => {
          if (!/nothing to commit/i.test(errorMessage(error))) throw error
          return { stdout: '', stderr: '' }
        })
      }
      if (remote) {
        const pullArgs = ['pull']; if (content.noFastForward) pullArgs.push('--no-ff'); if (content.squash) pullArgs.push('--squash'); pullArgs.push(remote, branch)
        await this.git.run(repo, pullArgs, NETWORK_TIMEOUT_MS); await this.git.run(repo, ['push', remote, branch], NETWORK_TIMEOUT_MS)
      }
      return this.events({ type: 'quickSync', content: { error: null } })
    } catch (error) { return this.events({ type: 'quickSync', content: { error: errorMessage(error) } }) }
  }

  private async quickSyncCommand(window: BrowserWindow, content: Record<string, unknown>) {
    if (!this.lastActiveRepo) throw new Error('Open a repository in Git History before using Quick Sync.')
    const repo = this.lastActiveRepo
    const branch = (await this.git.run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    if (!branch || branch === 'HEAD') throw new Error('Quick Sync is unavailable in detached HEAD state.')
    const remotes = await this.lines(repo, ['remote'])
    const response = await this.quickSync(window, {
      repo,
      branch,
      remote: remotes[0] ?? '',
      commitMessage: content.commitMessage || 'Quick Sync',
    })
    const result = response.events[0]?.content as { error?: string | null; cancelled?: boolean } | undefined
    return this.events({
      type: 'quickSyncCommand',
      content: { error: result?.error ?? null, cancelled: result?.cancelled ?? false, repo, branch, remote: remotes[0] ?? null },
    })
  }

  private async loadRepoConfig(content: Record<string, unknown>) {
    const repo = this.repo(content.repo); const names = await this.lines(repo, ['remote']); const remotes = []
    for (const name of names) {
      const url = await this.configValue(repo, `remote.${name}.url`); const pushUrl = await this.configValue(repo, `remote.${name}.pushurl`)
      remotes.push({ name, url, pushUrl })
    }
    return this.events({ type: 'repoConfig', content: { remotes } })
  }

  private async remoteAction(window: BrowserWindow, content: Record<string, unknown>) {
    const repo = this.repo(content.repo); const action = requireShortString(content.action, 'remote action', 16)
    if (action === 'delete') {
      const answer = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0, title: 'Delete Git remote', message: `Delete remote “${String(content.name)}”?`, detail: repo })
      if (answer.response !== 1) return this.events({ type: 'remoteActionResult', content: { error: null, cancelled: true, refresh: false } })
    }
    try {
      if (action === 'add') {
        const name = requireRef(content.name, 'remote'); await this.git.run(repo, ['remote', 'add', name, requireRemoteUrl(content.url)])
        if (content.pushUrl) await this.git.run(repo, ['remote', 'set-url', '--push', name, requireRemoteUrl(content.pushUrl)])
      } else if (action === 'edit') {
        const oldName = requireRef(content.name, 'remote'); const name = requireRef(content.newName, 'remote')
        if (oldName !== name) await this.git.run(repo, ['remote', 'rename', oldName, name])
        await this.git.run(repo, ['remote', 'set-url', name, requireRemoteUrl(content.url)])
        if (content.pushUrl) await this.git.run(repo, ['remote', 'set-url', '--push', name, requireRemoteUrl(content.pushUrl)])
      } else if (action === 'delete') await this.git.run(repo, ['remote', 'remove', requireRef(content.name, 'remote')])
      else throw new Error('Unknown remote action.')
      return this.events({ type: 'remoteActionResult', content: { error: null, cancelled: false, refresh: true } })
    } catch (error) { return this.events({ type: 'remoteActionResult', content: { error: errorMessage(error), cancelled: false, refresh: false } }) }
  }

  private async remoteWebUrls(content: Record<string, unknown>) {
    const repo = this.repo(content.repo); const urls = await this.getRemoteWebUrls(repo)
    return this.events({ type: 'remoteWebUrls', content: { repo, remoteWebUrls: urls } })
  }

  private async gitAction(window: BrowserWindow, content: Record<string, unknown>): Promise<DesktopGitHistoryResponse> {
    const action = requireShortString(content.action, 'Git action', 64)
    const repo = action === 'copyToClipboard'
      ? null
      : action === 'viewScm'
        ? this.lastActiveRepo
        : this.repo(content.repo)
    if (action === 'viewScm' && !repo) throw new Error('No Git repository is currently active.')
    if (repo && (NATIVE_CONFIRM_ACTIONS.has(action) || action === 'pushBranch' && content.force === true)) {
      const answer = await dialog.showMessageBox(window, {
        type: 'warning', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0,
        title: 'Confirm Git operation', message: describeAction(action, content), detail: repo,
      })
      if (answer.response !== 1) return this.events({ type: 'gitActionResult', content: { error: null, warning: null, refresh: false, cancelled: true } })
    }
    try {
      let preview: DesktopGitHistoryPreview | undefined
      let warning: string | null = null
      if (action === 'copyToClipboard') clipboard.writeText(requireFilter(content.text, 'clipboard text'))
      else if (action === 'copyFilePath') clipboard.writeText(content.absolute ? resolve(repo!, this.relativePath(repo!, content.filePath)) : this.relativePath(repo!, content.filePath))
      else if (action === 'openFile') preview = await this.workingFilePreview(repo!, content.filePath)
      else if (action === 'viewFileAtRevision') preview = await this.fileRevisionPreview(repo!, content.hash, content.filePath)
      else if (action === 'viewDiff' || action === 'viewDiffWithWorking') preview = await this.diffPreview(repo!, content)
      else if (action === 'viewScm') preview = await this.sourceControlPreview(repo!)
      else await this.runMutation(repo!, action, content)
      return { events: [{ type: 'gitActionResult', content: { error: null, warning, refresh: MUTATING_ACTIONS.has(action) } }], ...(preview ? { preview } : {}) }
    } catch (error) {
      return this.events({ type: 'gitActionResult', content: { error: errorMessage(error), warning: null, refresh: false } })
    }
  }

  private async runMutation(repo: string, action: string, content: Record<string, unknown>): Promise<void> {
    const hash = () => requireHash(content.hash)
    switch (action) {
      case 'checkoutBranch': {
        const args = ['checkout']; if (content.remoteTracking) args.push('-b', requireRef(content.branch, 'branch'), requireRef(content.remoteTracking, 'remote tracking ref')); else args.push(requireRef(content.branch, 'branch')); await this.git.run(repo, args); return
      }
      case 'checkoutCommit': await this.git.run(repo, ['checkout', hash()]); return
      case 'createBranch': await this.git.run(repo, content.checkout ? ['checkout', '-b', requireRef(content.branchName, 'branch'), hash()] : ['branch', requireRef(content.branchName, 'branch'), hash()]); return
      case 'deleteBranch': await this.git.run(repo, ['branch', content.force ? '-D' : '-d', requireRef(content.branch, 'branch')]); return
      case 'renameBranch': await this.git.run(repo, ['branch', '-m', requireRef(content.branch, 'branch'), requireRef(content.newName, 'branch')]); return
      case 'deleteRemoteBranch': await this.git.run(repo, ['push', requireRef(content.remote, 'remote'), '--delete', requireRef(content.branch, 'branch')], NETWORK_TIMEOUT_MS); return
      case 'pullBranch': { const args = ['pull']; if (content.noFastForward) args.push('--no-ff'); if (content.squash) args.push('--squash'); args.push(requireRef(content.remote, 'remote'), requireRef(content.branch, 'branch')); await this.git.run(repo, args, NETWORK_TIMEOUT_MS); return }
      case 'pushBranch': { const targets = Array.isArray(content.remotes) ? content.remotes : [content.remote]; for (const remote of targets) { const args = ['push']; if (content.force) args.push('--force-with-lease'); args.push('-u', requireRef(remote, 'remote'), requireRef(content.branch, 'branch')); await this.git.run(repo, args, NETWORK_TIMEOUT_MS) } return }
      case 'merge': { const args = ['merge', requireRef(content.ref, 'merge ref')]; if (content.squash) args.push('--squash'); else if (content.createNewCommit) args.push('--no-ff'); if (content.noCommit) args.push('--no-commit'); await this.git.run(repo, args); return }
      case 'cherryPick': { const args = ['cherry-pick']; if (content.noCommit) args.push('--no-commit'); if (content.recordOrigin) args.push('-x'); if (Number(content.parentIndex) > 0) args.push('-m', String(Number(content.parentIndex))); args.push(hash()); await this.git.run(repo, args); return }
      case 'revertCommit': { const args = ['revert', '--no-edit']; if (Number(content.parentIndex) > 0) args.push('-m', String(Number(content.parentIndex))); args.push(hash()); await this.git.run(repo, args); return }
      case 'resetToCommit': await this.git.run(repo, ['reset', `--${requireResetMode(content.mode)}`, hash()]); return
      case 'addTag': { const args = ['tag']; if (content.annotated) args.push('-a', '-m', requireFilter(content.message || content.tagName, 'tag message')); args.push(requireRef(content.tagName, 'tag'), hash()); await this.git.run(repo, args); if (content.pushToRemote) await this.git.run(repo, ['push', requireRef(content.pushToRemote, 'remote'), requireRef(content.tagName, 'tag')], NETWORK_TIMEOUT_MS); return }
      case 'deleteTag': { const tag = requireRef(content.tag, 'tag'); await this.git.run(repo, ['tag', '-d', tag]); if (Array.isArray(content.deleteFromRemotes)) for (const remote of content.deleteFromRemotes) await this.git.run(repo, ['push', requireRef(remote, 'remote'), `:refs/tags/${tag}`], NETWORK_TIMEOUT_MS); return }
      case 'pushTag': { const targets = Array.isArray(content.remotes) ? content.remotes : [content.remote]; for (const remote of targets) await this.git.run(repo, ['push', requireRef(remote, 'remote'), requireRef(content.tag, 'tag')], NETWORK_TIMEOUT_MS); return }
      case 'applyStash': await this.git.run(repo, ['stash', 'apply', requireStash(content.selector)]); return
      case 'popStash': await this.git.run(repo, ['stash', 'pop', requireStash(content.selector)]); return
      case 'dropStash': await this.git.run(repo, ['stash', 'drop', requireStash(content.selector)]); return
      case 'branchFromStash': await this.git.run(repo, ['stash', 'branch', requireRef(content.branchName, 'branch'), requireStash(content.selector)]); return
      case 'pushStash': await this.git.run(repo, ['stash', 'push', '-u', '-m', requireFilter(content.message || 'Stash', 'stash message')]); return
      case 'resetUncommitted': await this.git.run(repo, ['reset', `--${requireResetMode(content.mode)}`, 'HEAD']); return
      case 'cleanUntracked': { const args = ['clean', '-f']; if (content.directories) args.push('-d'); await this.git.run(repo, args); return }
      default: throw new Error(`Unsupported Git action: ${action}`)
    }
  }

  private async workingFilePreview(repo: string, value: unknown): Promise<DesktopGitHistoryPreview> {
    const path = await this.authorizedWorkingFile(repo, value); const file = basename(path); const info = await stat(path)
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Only text files up to 4 MB can be previewed.')
    return { title: file, fileName: file, right: { label: 'Working Tree', content: await readFile(path, 'utf8') } }
  }

  private async sourceControlPreview(repo: string): Promise<DesktopGitHistoryPreview> {
    const { stdout } = await this.git.run(repo, ['status', '--short', '--branch'])
    return {
      title: `Source Control — ${basename(repo)}`,
      fileName: basename(repo),
      right: { label: repo, content: stdout || 'Working tree clean.\n' },
    }
  }

  private async fileRevisionPreview(repo: string, hashValue: unknown, pathValue: unknown): Promise<DesktopGitHistoryPreview> {
    if (hashValue === UNCOMMITTED) return this.workingFilePreview(repo, pathValue)
    const filePath = this.relativePath(repo, pathValue); const hash = requireHash(hashValue); const content = await this.showFile(repo, hash, filePath)
    return { title: `${basename(filePath)} @ ${hash.slice(0, 8)}`, fileName: basename(filePath), right: { label: hash.slice(0, 8), content } }
  }

  private async diffPreview(repo: string, content: Record<string, unknown>): Promise<DesktopGitHistoryPreview> {
    const oldPath = this.relativePath(repo, content.oldFilePath ?? content.filePath); const newPath = this.relativePath(repo, content.newFilePath ?? content.filePath)
    const from = content.hash ?? content.fromHash; const to = content.action === 'viewDiffWithWorking' ? UNCOMMITTED : content.toHash
    const leftRef = from === UNCOMMITTED ? 'HEAD' : requireHash(from)
    const left = content.type === 'A' ? '' : await this.showFile(repo, leftRef, oldPath).catch(() => '')
    const right = to === UNCOMMITTED ? await this.readWorkingText(repo, newPath).catch(() => '') : content.type === 'D' ? '' : await this.showFile(repo, requireHash(to), newPath).catch(() => '')
    return { title: `${basename(newPath)} (${String(leftRef).slice(0, 8)} → ${to === UNCOMMITTED ? 'Working Tree' : String(to).slice(0, 8)})`, fileName: basename(newPath), left: { label: String(leftRef).slice(0, 8), content: left }, right: { label: to === UNCOMMITTED ? 'Working Tree' : String(to).slice(0, 8), content: right } }
  }

  private async showFile(repo: string, ref: string, filePath: string): Promise<string> {
    const { stdout } = await this.git.run(repo, ['show', `${requireHash(ref)}:${filePath}`]); return stdout
  }

  private absoluteFile(repo: string, value: unknown): string {
    const relativePath = this.relativePath(repo, value); const target = resolve(repo, relativePath); const fromRoot = relative(repo, target)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('File path escapes the authorized repository.')
    return target
  }

  private async authorizedWorkingFile(repo: string, value: unknown): Promise<string> {
    const candidate = this.absoluteFile(repo, value)
    const [realRepo, realCandidate] = await Promise.all([realpath(repo), realpath(candidate)])
    const fromRoot = relative(realRepo, realCandidate)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error('File path resolves outside the authorized repository.')
    }
    return realCandidate
  }

  private async readWorkingText(repo: string, value: unknown): Promise<string> {
    const path = await this.authorizedWorkingFile(repo, value)
    const info = await stat(path)
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Only text files up to 4 MB can be previewed.')
    return readFile(path, 'utf8')
  }

  private relativePath(repo: string, value: unknown): string {
    const path = requireShortString(value, 'file path', 32_768).replace(/\\/g, '/')
    if (path.includes('\0') || path.startsWith('/') || /^[a-z]:/i.test(path)) throw new Error('Invalid repository-relative file path.')
    const target = resolve(repo, path); const fromRoot = relative(repo, target)
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('File path escapes the authorized repository.')
    return fromRoot.replace(/\\/g, '/')
  }

  private async getRemoteWebUrls(repo: string) {
    const names = await this.lines(repo, ['remote']); const urls: Array<{ name: string; url: string }> = []
    for (const name of names) { const raw = await this.configValue(repo, `remote.${name}.url`); const url = raw ? remoteToWebUrl(raw) : null; if (url) urls.push({ name, url }) }
    return urls
  }

  private async configValue(repo: string, key: string): Promise<string | null> {
    try { return (await this.git.run(repo, ['config', '--get', key])).stdout.trim() || null } catch { return null }
  }

  private async lines(repo: string, args: string[]): Promise<string[]> {
    return (await this.git.run(repo, args)).stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
  }

  private events(...events: DesktopGitHistoryEvent[]): DesktopGitHistoryResponse { return { events } }
}

function defaultHistoryRequest(repo: string): HistoryRequest {
  return { repo, branches: null, maxCommits: 300, showTags: true, showRemoteBranches: true, includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date', hideRemotes: [], showStashes: true }
}

function emptyRepoInfo(error: string): RepoInfo { return { branches: [], head: null, remotes: [], stashes: [], authors: [], hasRemoteUrl: false, remoteWebUrls: [], error } }
function emptyCommitData(error: string) { return { commits: [], head: null, tags: [], moreCommitsAvailable: false, error } }
function normalizePath(path: string): string { return resolve(path).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value) }
function requireRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object payload.'); return value as Record<string, unknown> }
function requireShortString(value: unknown, label: string, max: number): string { if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${label}.`); return value }
function requireFilter(value: unknown, label: string): string { const text = requireShortString(value, label, 8192); if (/[\r\n]/.test(text)) throw new TypeError(`Invalid ${label}.`); return text }
function requireRef(value: unknown, label: string): string { const ref = requireFilter(value, label); if (ref.startsWith('-') || /[~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.endsWith('.') || ref.endsWith('/')) throw new TypeError(`Invalid ${label}.`); return ref }
function requireHash(value: unknown): string { const hash = requireFilter(value, 'commit hash'); if (!/^[0-9a-f]{4,64}(?:\^)?$/i.test(hash) && hash !== 'HEAD') throw new TypeError('Invalid commit hash.'); return hash }
function requireStash(value: unknown): string { const stash = requireFilter(value, 'stash selector'); if (!/^(?:refs\/)?stash@\{\d+\}$/.test(stash)) throw new TypeError('Invalid stash selector.'); return stash }
function requireResetMode(value: unknown): 'soft' | 'mixed' | 'hard' { if (value === 'soft' || value === 'mixed' || value === 'hard') return value; throw new TypeError('Invalid reset mode.') }
function requireOrdering(value: unknown): 'date' | 'author-date' | 'topo' { return value === 'author-date' || value === 'topo' ? value : 'date' }
function requireRemoteUrl(value: unknown): string { const url = requireFilter(value, 'remote URL'); if (url.startsWith('-') || /^ext::/i.test(url) || (!/^(?:https?|ssh|git|file):\/\//i.test(url) && !/^[^@\s]+@[^:\s]+:.+/.test(url) && !/^(?:[a-z]:[\\/]|\/|\.\.?[\\/])/i.test(url))) throw new TypeError('Unsupported remote URL.'); return url }
function requireWebUrl(value: unknown): string { const url = new URL(requireShortString(value, 'URL', 2048)); if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new TypeError('Only credential-free HTTP(S) URLs may be opened.'); return url.href }
function selectGitError(stderr: string, stdout: string): string { const lines = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)].map((line) => line.trim()).filter(Boolean); return lines.find((line) => /fatal|error|conflict|failed|aborting|cannot|could not/i.test(line)) ?? lines[0] ?? 'Git command failed.' }
function decodeGitOutput(buffer: Buffer): string {
  if (buffer.length === 0) return ''
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { /* try Windows encodings */ }
  for (const encoding of ['GBK', 'BIG5', 'Shift_JIS'] as const) {
    try { const decoded = iconv.decode(buffer, encoding); if (decoded) return decoded } catch { /* try next */ }
  }
  return buffer.toString('utf8')
}
function describeAction(action: string, content: Record<string, unknown>): string { const target = content.branch ?? content.tag ?? content.selector ?? content.hash ?? ''; return `${action}${target ? `: ${String(target)}` : ''}` }
function remoteToWebUrl(raw: string): string | null {
  const value = raw.trim().replace(/\.git$/, '')
  if (/^https?:\/\//i.test(value)) return value
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(value); if (scp) return `https://${scp[1]}/${scp[2].replace(/^\/+/, '')}`
  try { const url = new URL(value.replace(/^git\+ssh:/, 'ssh:')); if (url.protocol === 'ssh:' || url.protocol === 'git:') return `https://${url.hostname}/${url.pathname.replace(/^\/+/, '')}` } catch { /* ignore */ }
  return null
}
