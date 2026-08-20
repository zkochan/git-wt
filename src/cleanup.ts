import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface CleanupOptions {
  dryRun: boolean
  /** Remove worktrees even when they hold uncommitted work. */
  force?: boolean
  /** Also strip build artifacts from worktrees that are kept. */
  reclaim?: boolean
  /** Only reclaim from worktrees whose last commit is at least this old. */
  idleDays?: number
  keepTarget?: boolean
  keepNodeModules?: boolean
}

interface WorktreeEntry {
  path: string
  branch: string | null
  bare: boolean
  detached: boolean
}

interface MergedPr {
  number: number
  title: string
}

interface MergedPrListItem extends MergedPr {
  headRefName?: string
}

/** One bulk query covers the recent window; older branches fall back to a lookup. */
const BULK_PR_LIMIT = 200

export function cleanupWorktrees (options: CleanupOptions): void {
  const {
    dryRun,
    force = false,
    reclaim = false,
    idleDays = 14,
    keepTarget = false,
    keepNodeModules = false,
  } = options

  if (dryRun) {
    process.stderr.write('=== DRY RUN MODE ===\n\n')
  }

  // GitHub going away must not stop the run: reclaim is the disk-pressure
  // valve and needs no network, and ancestry of the default branch still
  // detects merged work. Without GitHub the run only gets more conservative —
  // branches merged via a PR but not yet in the local default branch are
  // skipped, never removed.
  const ghRepo = detectGhRepo()
  if (ghRepo) {
    process.stderr.write(`Repository: ${ghRepo}\n\n`)
  } else {
    process.stderr.write('WARN: GitHub unavailable (gh failed); using local merge detection only.\n\n')
  }

  const currentWorktree = fs.realpathSync(process.cwd())
  const mergedByBranch = ghRepo ? fetchMergedPrs(ghRepo) : new Map<string, MergedPr>()
  const defaultBranch = detectDefaultBranch()

  let removed = 0
  let failed = 0
  let skipped = 0
  let reclaimed = 0

  for (const entry of listWorktrees()) {
    if (entry.bare || entry.detached || !entry.branch) continue

    const { path: worktreePath, branch } = entry

    if (isProtectedBranch(branch)) {
      process.stderr.write(`SKIP (protected branch): ${worktreePath} [${branch}]\n`)
      skipped++
      continue
    }

    let realWorktree: string
    try {
      realWorktree = fs.realpathSync(worktreePath)
    } catch {
      continue
    }
    if (realWorktree === currentWorktree) {
      process.stderr.write(`SKIP (current worktree): ${worktreePath} [${branch}]\n`)
      skipped++
      continue
    }

    // A merged PR does not mean the directory is idle — it is a normal place to
    // start the follow-up. Removing it with --force would take that work with it.
    if (!force && hasUncommittedChanges(worktreePath)) {
      process.stderr.write(`SKIP (uncommitted changes): ${worktreePath} [${branch}]\n`)
      skipped++
      continue
    }
    if (!force && hasUnpushedCommits(worktreePath)) {
      process.stderr.write(`SKIP (unpushed commits): ${worktreePath} [${branch}]\n`)
      skipped++
      continue
    }

    const mergedPr = mergedByBranch.get(branch) ?? (ghRepo ? findMergedPr(ghRepo, branch) : null)
    // A PR lookup keys on the head branch name, which misses two common cases:
    // a worktree created from someone else's PR, where the local name is not
    // the contributor's branch, and a branch merged without a PR at all. Being
    // an ancestor of the default branch settles it either way.
    const mergedLocally = !mergedPr && isMergedIntoDefault(branch, defaultBranch)

    if (!mergedPr && !mergedLocally) {
      if (reclaim) {
        reclaimed += reclaimWorktree(worktreePath, branch, {
          dryRun,
          idleDays,
          keepTarget,
          keepNodeModules,
        })
          ? 1
          : 0
      } else {
        process.stderr.write(`SKIP (no merged PR): ${worktreePath} [${branch}]\n`)
      }
      skipped++
      continue
    }

    process.stderr.write(`MERGED: ${worktreePath}\n`)
    process.stderr.write(`  Branch: ${branch}\n`)
    if (mergedPr) {
      process.stderr.write(`  PR #${mergedPr.number}: ${mergedPr.title}\n`)
    } else {
      process.stderr.write(`  Contained in ${defaultBranch!}, no PR under this branch name\n`)
    }

    if (dryRun) {
      process.stderr.write('  -> Would remove worktree and delete branch\n\n')
      removed++
    } else {
      if (removeWorktree(worktreePath, branch)) removed++
      else failed++
    }
  }

  process.stderr.write('\n---\n')
  if (dryRun) {
    process.stderr.write(`Would remove ${removed} worktree(s). Skipped ${skipped}.\n`)
    if (reclaim) process.stderr.write(`Would reclaim ${reclaimed} worktree(s).\n`)
    process.stderr.write('Run without --dry-run to actually remove them.\n')
  } else {
    process.stderr.write(`Removed ${removed} worktree(s). Failed ${failed}. Skipped ${skipped}.\n`)
    if (reclaim) process.stderr.write(`Reclaimed ${reclaimed} worktree(s).\n`)
  }
}

function detectGhRepo (): string | null {
  try {
    const repo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      encoding: 'utf8',
    }).trim()
    return repo || null
  } catch {
    return null
  }
}

/**
 * Querying per branch costs a round trip each, which is minutes across a large
 * fleet. Fetch the recent window once; anything older still falls back below.
 */
function fetchMergedPrs (repo: string): Map<string, MergedPr> {
  const byBranch = new Map<string, MergedPr>()
  try {
    const output = execFileSync(
      'gh',
      [
        'pr', 'list',
        '--repo', repo,
        '--state', 'merged',
        '--json', 'number,title,headRefName',
        '--limit', String(BULK_PR_LIMIT),
      ],
      { encoding: 'utf8' }
    ).trim()
    for (const pr of JSON.parse(output) as MergedPrListItem[]) {
      if (pr.headRefName && !byBranch.has(pr.headRefName)) {
        byBranch.set(pr.headRefName, { number: pr.number, title: pr.title })
      }
    }
  } catch {
    // Best effort: every branch falls back to its own lookup.
  }
  return byBranch
}

function listWorktrees (): WorktreeEntry[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null

  for (const line of output.split('\n')) {
    if (line === '') {
      if (current) entries.push(current)
      current = null
      continue
    }
    if (!current) current = { path: '', branch: null, bare: false, detached: false }

    if (line.startsWith('worktree ')) current.path = line.slice('worktree '.length)
    else if (line === 'bare') current.bare = true
    else if (line === 'detached') current.detached = true
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
  }
  if (current) entries.push(current)
  return entries
}

function isProtectedBranch (branch: string): boolean {
  return /^(main|master|v[0-9].*)$/.test(branch)
}

/** Ignored paths (build output) are excluded by default, so this means real work. */
function hasUncommittedChanges (worktree: string): boolean {
  try {
    return execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return true // unreadable state is not a licence to delete
  }
}

function hasUnpushedCommits (worktree: string): boolean {
  try {
    const count = execFileSync('git', ['-C', worktree, 'rev-list', '--count', '@{upstream}..HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return count !== '' && count !== '0'
  } catch {
    // No upstream at all, usually because the remote branch was deleted on
    // merge. The merged PR is the evidence that the work landed.
    return false
  }
}

function detectDefaultBranch (): string | null {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (ref) return ref.replace(/^origin\//, '')
  } catch {
    // No origin/HEAD; fall back to the conventional names.
  }
  for (const name of ['main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { stdio: 'ignore' })
      return name
    } catch {
      // try the next one
    }
  }
  return null
}

function isMergedIntoDefault (branch: string, defaultBranch: string | null): boolean {
  if (!defaultBranch || branch === defaultBranch) return false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, defaultBranch], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function findMergedPr (repo: string, branch: string): MergedPr | null {
  try {
    const output = execFileSync(
      'gh',
      ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'merged', '--json', 'number,title'],
      { encoding: 'utf8' }
    ).trim()
    const prs = JSON.parse(output) as MergedPr[]
    return prs.length > 0 ? prs[0]! : null
  } catch {
    return null
  }
}

function removeWorktree (worktreePath: string, branch: string): boolean {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { stdio: ['ignore', process.stderr, process.stderr] })
    process.stderr.write('  -> Removed worktree\n')
  } catch {
    if (!removeUnregisteredWorktreeLeftovers(worktreePath)) {
      process.stderr.write('  -> Failed to remove worktree\n')
      return false
    }
    process.stderr.write('  -> Removed worktree leftovers\n')
  }
  try {
    execFileSync('git', ['branch', '-D', branch], { stdio: ['ignore', process.stderr, process.stderr] })
    process.stderr.write(`  -> Deleted branch ${branch}\n`)
  } catch {
    // Branch delete is best-effort
  }
  process.stderr.write('\n')
  return true
}

function removeUnregisteredWorktreeLeftovers (worktreePath: string): boolean {
  if (!fs.existsSync(worktreePath)) return true
  if (isRegisteredWorktree(worktreePath)) return false
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

function isRegisteredWorktree (worktreePath: string): boolean {
  try {
    return listWorktrees().some((entry) => entry.path === worktreePath)
  } catch {
    return true
  }
}

interface ReclaimOptions {
  dryRun: boolean
  idleDays: number
  keepTarget: boolean
  keepNodeModules: boolean
}

/**
 * An unmerged worktree still holds its build output, and that is where the disk
 * goes: a Cargo target directory dwarfs the checkout beside it. Deleting it
 * costs a rebuild, which a compiler cache makes cheap, and keeps the branch.
 */
function reclaimWorktree (worktree: string, branch: string, options: ReclaimOptions): boolean {
  const age = idleDaysOf(worktree)
  if (age < options.idleDays) return false

  // A build leaves the worktree clean in git terms, so status cannot see it.
  // Deleting target/ underneath one corrupts the build rather than restarting it.
  if (isBusy(worktree)) {
    process.stderr.write(`SKIP (build running): ${worktree} [${branch}]\n`)
    return false
  }

  const candidates = findArtifactDirs(worktree, {
    target: !options.keepTarget,
    nodeModules: !options.keepNodeModules,
  })
  if (candidates.length === 0) return false

  const tracked = trackedPathsUnderArtifacts(worktree)
  const victims: string[] = []
  let kept = 0
  for (const dir of candidates) {
    const rel = path.relative(worktree, dir).split(path.sep).join('/')
    if (tracked.some((file) => file.startsWith(`${rel}/`))) kept++
    else victims.push(dir)
  }
  if (victims.length === 0) return false

  const note = kept > 0 ? ` (${kept} kept: tracked files)` : ''
  if (options.dryRun) {
    process.stderr.write(`RECLAIM: ${worktree} [${branch}]\n`)
    process.stderr.write(`  -> Would remove ${victims.length} build dir(s), idle ${age}d${note}\n\n`)
    return true
  }

  for (const dir of victims) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
  process.stderr.write(`RECLAIM: ${worktree} [${branch}]\n`)
  process.stderr.write(`  -> Removed ${victims.length} build dir(s), idle ${age}d${note}\n\n`)
  return true
}

function idleDaysOf (worktree: string): number {
  try {
    const ts = Number(
      execFileSync('git', ['-C', worktree, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim()
    )
    if (!Number.isFinite(ts)) return 0
    return Math.floor((Date.now() / 1000 - ts) / 86400)
  } catch {
    return 0
  }
}

/**
 * The test fixtures of some repositories keep tracked files under node_modules.
 * Deleting those dirties the worktree and breaks the tests that read them, so
 * any candidate directory that contains one is left alone.
 */
function trackedPathsUnderArtifacts (worktree: string): string[] {
  try {
    return execFileSync('git', ['-C', worktree, 'ls-files', '--', '*node_modules/*', '*target/*'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

function findArtifactDirs (root: string, want: { target: boolean, nodeModules: boolean }): string[] {
  const found: string[] = []
  const stack: string[] = [root]

  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // isDirectory() is false for symlinks, so the global virtual store that
      // node_modules links into is never walked or deleted through here.
      if (!entry.isDirectory()) continue
      if (entry.name === '.git') continue

      const full = path.join(dir, entry.name)
      if (want.nodeModules && entry.name === 'node_modules') {
        found.push(full)
        continue
      }
      if (want.target && entry.name === 'target' && fs.existsSync(path.join(full, 'CACHEDIR.TAG'))) {
        // Cargo stamps CACHEDIR.TAG into every target directory it creates,
        // which is what separates a build directory from a fixture of the
        // same name.
        found.push(full)
        continue
      }
      stack.push(full)
    }
  }
  return found
}

function isBusy (dir: string): boolean {
  if (process.platform !== 'linux') return false
  let pids: string[]
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return false
  }
  const prefix = dir + path.sep
  for (const pid of pids) {
    let cwd: string
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      continue
    }
    if (cwd === dir || cwd.startsWith(prefix)) return true
  }
  return false
}
