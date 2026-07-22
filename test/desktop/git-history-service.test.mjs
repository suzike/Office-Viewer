import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const { GitHistoryService } = await import('../../out/desktop/main/git-history-service.js')

async function git(repo, ...args) {
  return execFileAsync('git', args, { cwd: repo, windowsHide: true })
}

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'office-viewer-git-history-'))
  await git(repo, 'init')
  await git(repo, 'config', 'user.name', 'Office Viewer Test')
  await git(repo, 'config', 'user.email', 'office-viewer@example.invalid')
  await writeFile(join(repo, 'hello.txt'), 'first\n')
  await git(repo, 'add', 'hello.txt')
  await git(repo, 'commit', '-m', 'Initial commit')
  await writeFile(join(repo, 'hello.txt'), 'first\nsecond\n')
  return realpath(repo)
}

function authorize(service, repo) {
  service.authorizedRepos.set(resolve(repo).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase(), repo)
}

test('loads the original Git History data contract from an authorized repository', async (t) => {
  const repo = await fixture()
  t.after(() => rm(repo, { recursive: true, force: true }))
  const service = new GitHistoryService()
  authorize(service, repo)

  const result = await service.request({}, 'loadRepository', {
    repo,
    branches: null,
    maxCommits: 300,
    showTags: true,
    showRemoteBranches: true,
    showStashes: true,
    includeCommitsMentionedByReflogs: false,
    onlyFollowFirstParent: false,
    commitOrdering: 'date',
    hideRemotes: [],
  })

  const loaded = result.events.find((event) => event.type === 'repositoryLoaded')
  assert.ok(loaded)
  assert.equal(loaded.content.repoInfo.error, null)
  assert.equal(loaded.content.commitData.commits[0].hash, '*')
  assert.equal(loaded.content.commitData.commits[1].message, 'Initial commit')
  assert.deepEqual(loaded.content.commitData.commits[0].parents, [loaded.content.commitData.head])
})

test('supports safe branch mutation and rejects repository path traversal', async (t) => {
  const repo = await fixture()
  t.after(() => rm(repo, { recursive: true, force: true }))
  const service = new GitHistoryService()
  authorize(service, repo)
  const head = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()

  const created = await service.request({}, 'gitAction', {
    action: 'createBranch', repo, hash: head, branchName: 'desktop-test', checkout: false,
  })
  assert.equal(created.events[0].content.error, null)
  assert.match((await git(repo, 'branch', '--list', 'desktop-test')).stdout, /desktop-test/)

  const traversal = await service.request({}, 'gitAction', {
    action: 'openFile', repo, filePath: '../outside.txt',
  })
  assert.match(traversal.events[0].content.error, /escapes the authorized repository/i)
})

test('does not accept unselected repository roots', async (t) => {
  const repo = await fixture()
  t.after(() => rm(repo, { recursive: true, force: true }))
  const service = new GitHistoryService()
  await assert.rejects(
    () => service.request({}, 'loadRepository', { repo }),
    /has not been authorized/i,
  )
})

test('preserves stash nodes and file-history filtering used by the original graph', async (t) => {
  const repo = await fixture()
  t.after(() => rm(repo, { recursive: true, force: true }))
  await git(repo, 'stash', 'push', '-u', '-m', 'desktop stash')
  await writeFile(join(repo, 'other.txt'), 'other\n')
  await git(repo, 'add', 'other.txt')
  await git(repo, 'commit', '-m', 'Other file')
  const service = new GitHistoryService()
  authorize(service, repo)

  const result = await service.request({}, 'loadRepository', {
    repo, branches: null, maxCommits: 300, showTags: true, showRemoteBranches: true,
    showStashes: true, includeCommitsMentionedByReflogs: false,
    onlyFollowFirstParent: false, commitOrdering: 'date', hideRemotes: [], relPath: 'hello.txt',
  })
  const commits = result.events.find((event) => event.type === 'repositoryLoaded').content.commitData.commits
  assert.ok(commits.some((commit) => commit.stash))
  assert.ok(commits.some((commit) => commit.message === 'Initial commit'))
  assert.ok(!commits.some((commit) => commit.message === 'Other file'))
})
