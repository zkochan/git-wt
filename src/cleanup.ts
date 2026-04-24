import { execSync } from 'node:child_process'
import fs from 'node:fs'

interface CleanupOptions {
  dryRun: boolean
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

export function cleanupWorktrees ({ dryRun }: CleanupOptions): void {
  if (dryRun) {
    process.stderr.write('=== DRY RUN MODE ===\n\n')
  }

  const ghRepo = detectGhRepo()
  process.stderr.write(`Repository: ${ghRepo}\n\n`)

  const currentWorktree = fs.realpathSync(process.cwd())

  let removed = 0
  let skipped = 0

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

    const mergedPr = findMergedPr(ghRepo, branch)
    if (!mergedPr) {
      process.stderr.write(`SKIP (no merged PR): ${worktreePath} [${branch}]\n`)
      skipped++
      continue
    }

    process.stderr.write(`MERGED: ${worktreePath}\n`)
    process.stderr.write(`  Branch: ${branch}\n`)
    process.stderr.write(`  PR #${mergedPr.number}: ${mergedPr.title}\n`)

    if (dryRun) {
      process.stderr.write('  -> Would remove worktree and delete branch\n\n')
    } else {
      removeWorktree(worktreePath, branch)
    }
    removed++
  }

  process.stderr.write('\n---\n')
  if (dryRun) {
    process.stderr.write(`Would remove ${removed} worktree(s). Skipped ${skipped}.\n`)
    process.stderr.write('Run without --dry-run to actually remove them.\n')
  } else {
    process.stderr.write(`Removed ${removed} worktree(s). Skipped ${skipped}.\n`)
  }
}

function detectGhRepo (): string {
  let repo = ''
  try {
    repo = execSync('gh repo view --json nameWithOwner --jq .nameWithOwner', { encoding: 'utf8' }).trim()
  } catch {
    // fall through
  }
  if (!repo) {
    process.stderr.write('Error: could not determine GitHub repository. Make sure `gh` is authenticated.\n')
    process.exit(1)
  }
  return repo
}

function listWorktrees (): WorktreeEntry[] {
  const output = execSync('git worktree list --porcelain', { encoding: 'utf8' })
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

function findMergedPr (repo: string, branch: string): MergedPr | null {
  try {
    const output = execSync(
      `gh pr list --repo "${repo}" --head "${branch}" --state merged --json number,title`,
      { encoding: 'utf8' }
    ).trim()
    const prs = JSON.parse(output) as MergedPr[]
    return prs.length > 0 ? prs[0]! : null
  } catch {
    return null
  }
}

function removeWorktree (worktreePath: string, branch: string): void {
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, { stdio: ['ignore', process.stderr, process.stderr] })
    process.stderr.write('  -> Removed worktree\n')
  } catch {
    process.stderr.write('  -> Failed to remove worktree\n')
    return
  }
  try {
    execSync(`git branch -D "${branch}"`, { stdio: ['ignore', process.stderr, process.stderr] })
    process.stderr.write(`  -> Deleted branch ${branch}\n`)
  } catch {
    // Branch delete is best-effort
  }
  process.stderr.write('\n')
}
