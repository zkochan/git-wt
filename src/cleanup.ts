import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface CleanupOptions {
  dryRun: boolean
  /** Remove worktrees even when they hold uncommitted work. */
  force?: boolean
  /** Also strip build artifacts from worktrees that are kept. */
  reclaim?: boolean
  /** Only reclaim from worktrees with no commit, checkout, edit or build this recent. */
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
  /** Tip commit of the PR's head branch, the only durable link to a PR. */
  headRefOid: string
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
  const mergedByBranch = ghRepo ? fetchMergedPrs(ghRepo) : new Map<string, MergedPr[]>()
  const defaultBranch = detectDefaultBranch()

  let removed = 0
  let failed = 0
  let skipped = 0
  let reclaimed = 0
  let reclaimedBytes = 0

  for (const entry of listWorktrees()) {
    if (entry.bare) continue

    const { path: worktreePath } = entry
    const branch = entry.detached ? null : entry.branch
    const label = branch ?? 'detached HEAD'

    let realWorktree: string
    try {
      realWorktree = fs.realpathSync(worktreePath)
    } catch {
      continue
    }
    if (realWorktree === currentWorktree) {
      process.stderr.write(`SKIP (current worktree): ${worktreePath} [${label}]\n`)
      skipped++
      continue
    }

    let keepReason: string | null = null
    let mergedPr: MergedPr | null = null
    if (!branch) {
      // No branch to judge merged and none to delete, but still a checkout
      // with build output in it — and one nothing else will ever remove.
      keepReason = 'detached HEAD'
    } else if (isProtectedBranch(branch)) {
      keepReason = 'protected branch'
    } else if (!force && hasUncommittedChanges(worktreePath)) {
      // A merged PR does not mean the directory is idle — it is a normal place to
      // start the follow-up. Removing it with --force would take that work with it.
      keepReason = 'uncommitted changes'
    } else if (!force && hasUnpushedCommits(worktreePath)) {
      keepReason = 'unpushed commits'
    } else {
      mergedPr = findMergedPr(ghRepo, branch, resolveBranchTip(branch), mergedByBranch)
      // A PR lookup keys on the head branch name, which misses two common cases:
      // a worktree created from someone else's PR, where the local name is not
      // the contributor's branch, and a branch merged without a PR at all. Being
      // an ancestor of the default branch settles it either way.
      if (!mergedPr && !isMergedIntoDefault(branch, defaultBranch)) keepReason = 'no merged PR'
    }

    if (keepReason || !branch) {
      process.stderr.write(`SKIP (${keepReason}): ${worktreePath} [${label}]\n`)
      skipped++
      // Whatever keeps the checkout — a protected branch, unfinished work, an
      // open PR — is no reason to keep its build output. Unfinished work is the
      // common case, and it used to be exactly the one reclaim never reached.
      if (reclaim) {
        const freed = reclaimWorktree(worktreePath, label, {
          dryRun,
          idleDays,
          keepTarget,
          keepNodeModules,
        })
        if (freed !== null) {
          reclaimed++
          reclaimedBytes += freed
        }
      }
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
    if (reclaim) process.stderr.write(`Would reclaim ${reclaimed} worktree(s), ${formatBytes(reclaimedBytes)}.\n`)
    process.stderr.write('Run without --dry-run to actually remove them.\n')
  } else {
    process.stderr.write(`Removed ${removed} worktree(s). Failed ${failed}. Skipped ${skipped}.\n`)
    if (reclaim) process.stderr.write(`Reclaimed ${reclaimed} worktree(s), freed ${formatBytes(reclaimedBytes)}.\n`)
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
function fetchMergedPrs (repo: string): Map<string, MergedPr[]> {
  const byBranch = new Map<string, MergedPr[]>()
  try {
    const output = execFileSync(
      'gh',
      [
        'pr', 'list',
        '--repo', repo,
        '--state', 'merged',
        '--json', 'number,title,headRefName,headRefOid',
        '--limit', String(BULK_PR_LIMIT),
      ],
      { encoding: 'utf8' }
    ).trim()
    for (const pr of JSON.parse(output) as MergedPrListItem[]) {
      // Branch names are recycled, so a name can carry several merged PRs.
      if (!pr.headRefName || !pr.headRefOid) continue
      const prs = byBranch.get(pr.headRefName)
      const entry = { number: pr.number, title: pr.title, headRefOid: pr.headRefOid }
      if (prs) prs.push(entry)
      else byBranch.set(pr.headRefName, [entry])
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
  return isAncestor(branch, defaultBranch)
}

/** False when either commit is unknown here, which is the conservative answer. */
function isAncestor (commit: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, descendant], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function findMergedPr (
  repo: string | null,
  branch: string,
  tip: string | null,
  bulk: Map<string, MergedPr[]>
): MergedPr | null {
  if (!tip) return null

  const fromBulk = prCoveringTip(bulk.get(branch), tip)
  if (fromBulk) return fromBulk
  if (!repo) return null

  // The bulk window only reaches back so far, and a branch name that lives long
  // enough to be recycled is exactly the one whose match sits outside it.
  try {
    const output = execFileSync(
      'gh',
      ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'merged', '--json', 'number,title,headRefOid'],
      { encoding: 'utf8' }
    ).trim()
    return prCoveringTip(JSON.parse(output) as MergedPr[], tip)
  } catch {
    return null
  }
}

/**
 * A head branch name is not an identity: pnpm/pnpm merged a `side-effects` PR in
 * 2020 and a new `side-effects` branch opened years later inherited its verdict,
 * so the daily run deleted a worktree whose PR was still open. Only a PR whose
 * head commit contains what is checked out here is evidence that this work
 * landed — everything else keeps the worktree.
 */
function prCoveringTip (prs: MergedPr[] | undefined, tip: string): MergedPr | null {
  if (!prs) return null
  // Equality is the common case; ancestry covers a local branch left behind the
  // head that was pushed and merged.
  return prs.find((pr) => pr.headRefOid === tip || isAncestor(tip, pr.headRefOid)) ?? null
}

function resolveBranchTip (branch: string): string | null {
  try {
    const oid = execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return oid || null
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
 *
 * Returns the bytes freed, or null when nothing was touched.
 */
function reclaimWorktree (worktree: string, branch: string, options: ReclaimOptions): number | null {
  // The cheap signals first, so a worktree that is plainly active is never
  // walked at all.
  let lastActive = lastGitActivity(worktree)
  if (daysSince(lastActive) < options.idleDays) return null

  const candidates = findArtifactDirs(worktree, {
    target: !options.keepTarget,
    nodeModules: !options.keepNodeModules,
  })
  if (candidates.length === 0) return null

  // A build in a checkout nobody edited — reviewing a PR, say — leaves no trace
  // in git, only in the artifacts themselves.
  for (const dir of candidates) lastActive = Math.max(lastActive, newestMtime(dir))
  const age = daysSince(lastActive)
  if (age < options.idleDays) return null

  // A build leaves the worktree clean in git terms, so status cannot see it.
  // Deleting target/ underneath one corrupts the build rather than restarting it.
  if (isBusy(worktree)) {
    process.stderr.write(`SKIP (build running): ${worktree} [${branch}]\n`)
    return null
  }

  const tracked = trackedPathsUnderArtifacts(worktree)
  const victims: string[] = []
  let kept = 0
  for (const dir of candidates) {
    const rel = path.relative(worktree, dir).split(path.sep).join('/')
    if (tracked.some((file) => file.startsWith(`${rel}/`))) kept++
    else victims.push(dir)
  }
  if (victims.length === 0) return null

  const bytes = diskUsage(victims)
  const note = kept > 0 ? ` (${kept} kept: tracked files)` : ''
  if (options.dryRun) {
    process.stderr.write(`RECLAIM: ${worktree} [${branch}]\n`)
    process.stderr.write(`  -> Would remove ${victims.length} build dir(s), ${formatBytes(bytes)}, idle ${age}d${note}\n\n`)
    return bytes
  }

  for (const dir of victims) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
  process.stderr.write(`RECLAIM: ${worktree} [${branch}]\n`)
  process.stderr.write(`  -> Removed ${victims.length} build dir(s), ${formatBytes(bytes)}, idle ${age}d${note}\n\n`)
  return bytes
}

function daysSince (epochSeconds: number): number {
  return Math.floor((Date.now() / 1000 - epochSeconds) / 86400)
}

/**
 * Seconds since the epoch of the last sign of someone working here, as far as
 * git can tell. The commit date alone is not it: a worktree with a
 * three-week-old commit and yesterday's edits is in daily use.
 */
function lastGitActivity (worktree: string): number {
  return Math.max(lastCommitTime(worktree), lastHeadMove(worktree), newestChangedFile(worktree))
}

function lastCommitTime (worktree: string): number {
  try {
    const ts = Number(
      execFileSync('git', ['-C', worktree, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim()
    )
    return Number.isFinite(ts) ? ts : 0
  } catch {
    return 0
  }
}

/**
 * The commit date belongs to whoever wrote the commit. A worktree checked out
 * yesterday from a month-old PR is not a month idle; the reflog records when
 * HEAD last moved here — the checkout itself, a reset, a commit.
 */
function lastHeadMove (worktree: string): number {
  try {
    const output = execFileSync(
      'git',
      ['-C', worktree, 'reflog', 'show', '-1', '--date=unix', '--format=%gd', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    const match = /\{(\d+)\}/.exec(output)
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

/** Uncommitted edits are the one sign of life the history cannot see. */
function newestChangedFile (worktree: string): number {
  let output: string
  try {
    output = execFileSync('git', ['-C', worktree, 'status', '--porcelain', '-z'], { encoding: 'utf8' })
  } catch {
    return 0
  }
  let newest = 0
  let renameSource = false
  // Enough to see a real edit; a worktree with thousands of changes is not idle
  // on the evidence of the first thousand either.
  for (const entry of output.split('\0').filter(Boolean).slice(0, 1000)) {
    let rel: string
    if (renameSource) {
      // A rename is followed by a second record holding the old path, bare.
      rel = entry
      renameSource = false
    } else {
      rel = entry.slice(3)
      renameSource = /^([RC].|.[RC])/.test(entry)
    }
    try {
      newest = Math.max(newest, fs.lstatSync(path.join(worktree, rel)).mtimeMs / 1000)
    } catch {
      // Deleted files are changes too, but there is nothing to stat.
    }
  }
  return newest
}

/**
 * Cargo never touches target/ itself on a rebuild but writes into
 * target/<profile>/deps and .fingerprint, and pnpm rewrites node_modules/.pnpm
 * on install — so two levels down is where a directory's last use shows.
 */
function newestMtime (root: string, depth = 2): number {
  let newest = 0
  const visit = (dir: string, level: number): void => {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(dir)
    } catch {
      return
    }
    newest = Math.max(newest, stat.mtimeMs / 1000)
    if (level === 0 || !stat.isDirectory()) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(dir, entry.name), level - 1)
    }
  }
  visit(root, depth)
  return newest
}

/** Bytes on disk under the given directories, counting a hard-linked file once. */
function diskUsage (dirs: string[]): number {
  let bytes = 0
  const seen = new Set<string>()
  const stack = [...dirs]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // Symlinks are not directories to Dirent, so nothing outside is followed.
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue
      }
      if (stat.nlink > 1) {
        const key = `${stat.dev}:${stat.ino}`
        if (seen.has(key)) continue
        seen.add(key)
      }
      bytes += stat.blocks * 512
    }
  }
  return bytes
}

function formatBytes (bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
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
