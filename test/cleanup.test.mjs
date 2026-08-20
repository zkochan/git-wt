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
      cleanupWorktrees({ dryRun: false, force: true })
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
      return captureStderr(() => cleanupWorktrees({ dryRun: false, force: true }))
    })

    assert.match(stderr, /Removed 0 worktree\(s\)\. Failed 1\. Skipped 1\./)
    assert.equal(fs.existsSync(fixture.worktree), true)
    assert.equal(listBranch(fixture), fixture.branch)
  } finally {
    fixture.remove()
  }
})

test('cleanup keeps a merged worktree that holds uncommitted work', () => {
  // A merged PR does not mean the directory is idle: it is a normal place to
  // start the follow-up, and --force would take that work with it.
  const fixture = createRepo('dirty-target')
  const toolsDir = createFakeTools({
    mergedBranch: fixture.branch,
    removeMode: 'ok',
  })

  try {
    const stderr = withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      return captureStderr(() => cleanupWorktrees({ dryRun: false }))
    })

    assert.match(stderr, /SKIP \(uncommitted changes\)/)
    assert.match(stderr, /Removed 0 worktree\(s\)\./)
    assert.equal(fs.existsSync(fixture.worktree), true)
    assert.equal(listBranch(fixture), fixture.branch)
  } finally {
    fixture.remove()
  }
})

test('cleanup --force removes a merged worktree that holds uncommitted work', () => {
  const fixture = createRepo('forced-target')
  const toolsDir = createFakeTools({
    mergedBranch: fixture.branch,
    removeMode: 'ok',
  })

  try {
    withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      cleanupWorktrees({ dryRun: false, force: true })
    })

    assert.equal(fs.existsSync(fixture.worktree), false)
    assert.equal(listBranch(fixture), '')
  } finally {
    fixture.remove()
  }
})

test('cleanup removes a branch contained in the default branch with no PR', () => {
  // A worktree created from someone else's PR carries a local name that no PR
  // has as its head, and a locally merged branch may have no PR at all.
  const fixture = createRepo('no-pr-target')
  const toolsDir = createFakeTools({ mergedBranch: 'nothing-merged', removeMode: 'ok' })
  fs.rmSync(path.join(fixture.worktree, 'leftovers'), { recursive: true, force: true })

  try {
    const stderr = withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      return captureStderr(() => cleanupWorktrees({ dryRun: false }))
    })

    assert.match(stderr, /Contained in main, no PR under this branch name/)
    assert.equal(fs.existsSync(fixture.worktree), false)
    assert.equal(listBranch(fixture), '')
  } finally {
    fixture.remove()
  }
})

test('cleanup without GitHub still removes locally merged branches', () => {
  // The daily timer runs unattended; a GitHub outage used to abort the whole
  // run before any local work happened, and the disk kept filling.
  const fixture = createRepo('offline-target')
  const toolsDir = createFakeTools({ mergedBranch: 'unused', removeMode: 'ok', ghMode: 'down' })
  fs.rmSync(path.join(fixture.worktree, 'leftovers'), { recursive: true, force: true })

  try {
    const stderr = withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      return captureStderr(() => cleanupWorktrees({ dryRun: false }))
    })

    assert.match(stderr, /WARN: GitHub unavailable/)
    assert.equal(fs.existsSync(fixture.worktree), false)
    assert.equal(listBranch(fixture), '')
  } finally {
    fixture.remove()
  }
})

test('reclaim without GitHub still deletes build artifacts', () => {
  const fixture = createReclaimRepo('offline-reclaim-target')
  const toolsDir = createFakeTools({ mergedBranch: 'unused', removeMode: 'ok', ghMode: 'down' })

  try {
    withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      cleanupWorktrees({ dryRun: false, reclaim: true, idleDays: 0 })
    })

    assert.equal(fs.existsSync(fixture.worktree), true)
    assert.equal(listBranch(fixture), fixture.branch)
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'target')), false)
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'node_modules')), false)
  } finally {
    fixture.remove()
  }
})

test('reclaim deletes build artifacts but keeps the worktree and its branch', () => {
  const fixture = createReclaimRepo('reclaim-target')
  const toolsDir = createFakeTools({ mergedBranch: 'nothing-merged', removeMode: 'ok' })

  try {
    withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      cleanupWorktrees({ dryRun: false, reclaim: true, idleDays: 0 })
    })

    // The worktree itself survives — only its build output goes.
    assert.equal(fs.existsSync(fixture.worktree), true)
    assert.equal(listBranch(fixture), fixture.branch)
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'target')), false)
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'node_modules')), false)
  } finally {
    fixture.remove()
  }
})

test('reclaim keeps directories holding git-tracked files', () => {
  // Test fixtures keep tracked files under node_modules. Deleting those dirties
  // the worktree and breaks the tests that read them.
  const fixture = createReclaimRepo('tracked-target')
  const toolsDir = createFakeTools({ mergedBranch: 'nothing-merged', removeMode: 'ok' })

  try {
    withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      cleanupWorktrees({ dryRun: false, reclaim: true, idleDays: 0 })
    })

    const tracked = path.join(fixture.worktree, '__fixtures__/sample/node_modules/.modules.yaml')
    assert.equal(fs.existsSync(tracked), true)
    assert.equal(status(fixture.worktree), '', 'reclaim must not dirty the worktree')
  } finally {
    fixture.remove()
  }
})

test('reclaim leaves a target directory that cargo did not create', () => {
  const fixture = createReclaimRepo('marker-target')
  const toolsDir = createFakeTools({ mergedBranch: 'nothing-merged', removeMode: 'ok' })

  try {
    withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      cleanupWorktrees({ dryRun: false, reclaim: true, idleDays: 0 })
    })

    // No CACHEDIR.TAG, so it is a directory that merely shares the name.
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'suite/target/keep.txt')), true)
  } finally {
    fixture.remove()
  }
})

test('reclaim respects --idle-days', () => {
  const fixture = createReclaimRepo('fresh-target')
  const toolsDir = createFakeTools({ mergedBranch: 'nothing-merged', removeMode: 'ok' })

  try {
    withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      cleanupWorktrees({ dryRun: false, reclaim: true, idleDays: 30 })
    })

    // The fixture's only commit is seconds old, so nothing is idle enough.
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'target')), true)
  } finally {
    fixture.remove()
  }
})

test('reclaim in dry-run mode changes nothing', () => {
  const fixture = createReclaimRepo('dry-target')
  const toolsDir = createFakeTools({ mergedBranch: 'nothing-merged', removeMode: 'ok' })

  try {
    const stderr = withCleanupEnv({ cwd: fixture.repo, toolsDir }, () => {
      return captureStderr(() => cleanupWorktrees({ dryRun: true, reclaim: true, idleDays: 0 }))
    })

    assert.match(stderr, /Would remove \d+ build dir\(s\)/)
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'target')), true)
    assert.equal(fs.existsSync(path.join(fixture.worktree, 'node_modules')), true)
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

function createReclaimRepo (branch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-wt-reclaim-'))
  const repo = path.join(root, 'repo')
  const worktree = path.join(root, 'worktree')

  fs.mkdirSync(repo)
  git(['init', '-q', '-b', 'main'], { cwd: repo })
  git(['config', 'user.email', 'test@example.com'], { cwd: repo })
  git(['config', 'user.name', 'Test'], { cwd: repo })
  git(['config', 'commit.gpgsign', 'false'], { cwd: repo })

  // Build output is ignored, which is why a worktree full of it still reads as
  // clean and so reaches the reclaim path at all.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'target/\nnode_modules/\n')
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n')
  fs.mkdirSync(path.join(repo, '__fixtures__/sample/node_modules'), { recursive: true })
  fs.writeFileSync(path.join(repo, '__fixtures__/sample/node_modules/.modules.yaml'), 'tracked\n')
  git(['add', '-f', '.gitignore', 'README.md', '__fixtures__'], { cwd: repo })
  git(['commit', '-qm', 'init'], { cwd: repo })
  git(['branch', branch], { cwd: repo })
  git(['worktree', 'add', '-q', worktree, branch], { cwd: repo })

  // Put a commit on the branch so it is not contained in main — otherwise it
  // reads as merged and gets removed rather than reclaimed.
  fs.writeFileSync(path.join(worktree, 'work.txt'), 'work\n')
  git(['add', 'work.txt'], { cwd: worktree })
  git(['commit', '-qm', 'work'], { cwd: worktree })

  // A cargo build directory, marked the way cargo marks them.
  fs.mkdirSync(path.join(worktree, 'target/debug'), { recursive: true })
  fs.writeFileSync(
    path.join(worktree, 'target/CACHEDIR.TAG'),
    'Signature: 8a477f597d28d172789f06886806bc55\n'
  )
  fs.writeFileSync(path.join(worktree, 'target/debug/app'), 'binary\n')

  // Same name, no marker: not a build directory.
  fs.mkdirSync(path.join(worktree, 'suite/target'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'suite/target/keep.txt'), 'keep\n')

  // Installed dependencies, deletable.
  fs.mkdirSync(path.join(worktree, 'node_modules/dep'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'node_modules/dep/index.js'), 'x\n')

  return {
    branch,
    repo,
    worktree,
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function status (worktree) {
  return git(['status', '--porcelain'], { cwd: worktree }).stdout.trim()
}

function createFakeTools ({ mergedBranch, removeMode, ghMode = 'ok' }) {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-wt-tools-'))
  writeExecutable(path.join(toolsDir, 'gh'), `#!/bin/sh
if [ "${ghMode}" = "down" ]; then
  echo "error connecting to api.github.com" >&2
  exit 1
fi
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
