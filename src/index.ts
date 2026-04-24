#!/usr/bin/env node
import { cleanupWorktrees } from './cleanup.js'
import { createWorktree } from './create.js'
import { emitShellInit } from './init.js'

const USAGE = `Usage:
  git-wt <branch-name>          Create a worktree for a branch and print its path
  git-wt <pr-number>            Create a worktree for a GitHub PR and print its path
  git-wt cleanup [--dry-run]    Remove worktrees whose branches belong to merged PRs
  git-wt init <bash|zsh|fish>   Print a shell function \`wt\` that cds into new worktrees
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
  const dryRun = args.slice(1).includes('--dry-run')
  cleanupWorktrees({ dryRun })
  process.exit(0)
}

const worktreePath = createWorktree(args[0]!)
process.stdout.write(worktreePath + '\n')
