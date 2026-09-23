#!/usr/bin/env node
import { cleanupWorktrees } from './cleanup.js'
import { createWorktree } from './create.js'
import { emitShellInit } from './init.js'

const USAGE = `Usage:
  git-wt <branch-name>          Create a worktree for a branch and print its path
  git-wt <pr-number>            Create a worktree for a GitHub PR and print its path
  git-wt cleanup [options]      Remove worktrees whose branches belong to merged PRs
  git-wt init <bash|zsh|fish>   Print a shell function \`wt\` that cds into new worktrees

Run \`git-wt cleanup --help\` for cleanup options.
`

const CLEANUP_USAGE = `Usage: git-wt cleanup [options]

Removes worktrees whose branches belong to merged PRs, and deletes the branch.

  --dry-run             Report what would happen, change nothing
  --force               Remove worktrees even when they hold uncommitted or
                        unpushed work. Without this they are skipped.
  --reclaim             For every worktree that is kept, whatever the reason,
                        delete its build artifacts (Cargo target/ and
                        node_modules) once idle. The branch and the checkout
                        stay, uncommitted work included.
  --idle-days <n>       Days without a commit, checkout, edit or build before
                        a worktree counts as idle (default: 14)
  --idle-hours <n>      The same threshold in hours, for a fleet that fills
                        the disk within days
  --keep-target         Do not delete Cargo target directories
  --keep-node-modules   Do not delete node_modules
  -h, --help            This message

Never removed: protected branches (main, master, v*), detached HEADs, the
current worktree and worktrees a running process is using. Never reclaimed:
the current worktree, directories holding git-tracked files, and worktrees a
running process is using.
`

const args = process.argv.slice(2)

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(USAGE)
  process.exit(args.length === 0 ? 1 : 0)
}

if (args[0] === 'init') {
  const shell = args[1]
  if (!shell) {
    process.stderr.write('Usage: git-wt init <bash|zsh|fish>\n')
    process.exit(1)
  }
  process.stdout.write(emitShellInit(shell))
  process.exit(0)
}

if (args[0] === 'cleanup') {
  const rest = args.slice(1)
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(CLEANUP_USAGE)
    process.exit(0)
  }

  const options = {
    dryRun: false,
    force: false,
    reclaim: false,
    idleHours: 14 * 24,
    keepTarget: false,
    keepNodeModules: false,
  }

  // Unrecognised flags are an error rather than a no-op: silently ignoring a
  // mistyped --dry-run would turn a rehearsal into a real removal.
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    switch (arg) {
      case '--dry-run': options.dryRun = true; break
      case '--force': options.force = true; break
      case '--reclaim': options.reclaim = true; break
      case '--keep-target': options.keepTarget = true; break
      case '--keep-node-modules': options.keepNodeModules = true; break
      case '--idle-days':
        options.idleHours = parseIdleValue(arg, rest[++i]) * 24
        break
      case '--idle-hours':
        options.idleHours = parseIdleValue(arg, rest[++i])
        break
      default:
        process.stderr.write(`Error: unknown option \`${arg}\`\n\n${CLEANUP_USAGE}`)
        process.exit(1)
    }
  }

  cleanupWorktrees(options)
  process.exit(0)
}

const worktreePath = createWorktree(args[0]!)
process.stdout.write(worktreePath + '\n')

function parseIdleValue (flag: string, raw: string | undefined): number {
  const value = Number(raw)
  if (raw === undefined || !Number.isInteger(value) || value < 0) {
    process.stderr.write(`Error: ${flag} needs a non-negative integer\n`)
    process.exit(1)
  }
  return value
}
