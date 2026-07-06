import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { cleanupWorktrees } from '../lib/cleanup.js'

const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()

test('cleanup removes leftovers after git unregisters the worktree before failing', () => {
  const fixture = createRepo('cleanup-target')
  const toolsDir = createFakeTools({
    mergedBranch: fixture.branch,
    removeMode: 'partial',
  })

  try {
    withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      cleanupWorktrees({ dryRun: false })
    })

    assert.equal(fs.existsSync(fixture.worktree), false)
    assert.equal(listBranch(fixture), '')
  } finally {
    fixture.remove()
  }
})

test('cleanup reports failed removals without counting them as removed', () => {
  const fixture = createRepo('fail-target')
  const toolsDir = createFakeTools({
    mergedBranch: fixture.branch,
    removeMode: 'fail',
  })

  try {
    const stderr = withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      return captureStderr(() => cleanupWorktrees({ dryRun: false }))
    })

    assert.match(stderr, /Removed 0 worktree\(s\)\. Failed 1\. Skipped 1\./)
    assert.equal(fs.existsSync(fixture.worktree), true)
    assert.equal(listBranch(fixture), fixture.branch)
  } finally {
    fixture.remove()
  }
})

function createRepo (branch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-wt-cleanup-'))
  const repo = path.join(root, 'repo')
  const worktree = path.join(root, 'worktree')

  fs.mkdirSync(repo)
  git(['init', '-q', '-b', 'main'], { cwd: repo })
  git(['config', 'user.email', 'test@example.com'], { cwd: repo })
  git(['config', 'user.name', 'Test'], { cwd: repo })
  git(['config', 'commit.gpgsign', 'false'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n')
  git(['add', 'README.md'], { cwd: repo })
  git(['commit', '-qm', 'init'], { cwd: repo })
  git(['branch', branch], { cwd: repo })
  git(['worktree', 'add', '-q', worktree, branch], { cwd: repo })
  fs.mkdirSync(path.join(worktree, 'leftovers'))
  fs.writeFileSync(path.join(worktree, 'leftovers', 'file.txt'), 'leftover\n')

  return {
    branch,
    repo,
    worktree,
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function createFakeTools ({ mergedBranch, removeMode }) {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-wt-tools-'))
  writeExecutable(path.join(toolsDir, 'gh'), `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo "zkochan/git-wt"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  head=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--head" ]; then
      shift
      head="$1"
    fi
    shift
  done
  if [ "$head" = "${mergedBranch}" ]; then
    printf '[{"number":1,"title":"merged"}]\\n'
  else
    printf '[]\\n'
  fi
  exit 0
fi
exit 1
`)
  writeExecutable(path.join(toolsDir, 'git'), `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  worktree_path="$4"
  if [ "${removeMode}" = "partial" ]; then
    gitdir="$(sed -n 's/^gitdir: //p' "$worktree_path/.git")"
    rm -rf "$gitdir"
    echo "error: failed to delete '$worktree_path': Directory not empty" >&2
    exit 128
  fi
  if [ "${removeMode}" = "fail" ]; then
    echo "error: failed to delete '$worktree_path': Directory not empty" >&2
    exit 128
  fi
fi
exec "${realGit}" "$@"
`)
  return toolsDir
}

function writeExecutable (file, content) {
  fs.writeFileSync(file, content)
  fs.chmodSync(file, 0o755)
}

function withCleanupEnv ({ cwd, toolsDir }, fn) {
  const oldCwd = process.cwd()
  const oldPath = process.env.PATH
  process.chdir(cwd)
  process.env.PATH = `${toolsDir}${path.delimiter}${oldPath}`
  try {
    return fn()
  } finally {
    process.env.PATH = oldPath
    process.chdir(oldCwd)
    fs.rmSync(toolsDir, { recursive: true, force: true })
  }
}

function captureStderr (fn) {
  const write = process.stderr.write
  let output = ''
  process.stderr.write = function (chunk, encoding, callback) {
    output += Buffer.isBuffer(chunk) ? chunk.toString() : chunk
    if (typeof encoding === 'function') encoding()
    if (typeof callback === 'function') callback()
    return true
  }
  try {
    fn()
  } finally {
    process.stderr.write = write
  }
  return output
}

function git (args, { cwd }) {
  const result = spawnSync(realGit, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result
}

function listBranch ({ repo, branch }) {
  return git(['branch', '--list', branch, '--format=%(refname:short)'], { cwd: repo }).stdout.trim()
}
