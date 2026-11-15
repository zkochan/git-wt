import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { emitShellInit } from '../lib/init.js'

const SHELLS = ['bash', 'zsh', 'fish'].filter(isInstalled)

for (const shell of SHELLS) {
  test(`${shell}: the hook in .config/git-wt wins over the one in .git-wt`, () => {
    const fixture = createFixture()
    try {
      fixture.addHook('.config/git-wt/pr-hook', 'config-dir')
      fixture.addHook('.git-wt/pr-hook', 'root-dir')
      fixture.addHook('xdg/git-wt/pr-hook', 'user')
      assert.equal(runWt(shell, fixture, '42'), 'config-dir 42')
    } finally {
      fixture.remove()
    }
  })

  test(`${shell}: the hook in .git-wt runs when .config/git-wt has none`, () => {
    const fixture = createFixture()
    try {
      fixture.addHook('.git-wt/pr-hook', 'root-dir')
      fixture.addHook('xdg/git-wt/pr-hook', 'user')
      assert.equal(runWt(shell, fixture, '42'), 'root-dir 42')
    } finally {
      fixture.remove()
    }
  })

  test(`${shell}: the user hook runs when the worktree has none`, () => {
    const fixture = createFixture()
    try {
      fixture.addHook('xdg/git-wt/pr-hook', 'user')
      assert.equal(runWt(shell, fixture, '42'), 'user 42')
    } finally {
      fixture.remove()
    }
  })

  test(`${shell}: no hook runs for a branch checkout`, () => {
    const fixture = createFixture()
    try {
      fixture.addHook('.config/git-wt/pr-hook', 'config-dir')
      assert.equal(runWt(shell, fixture, 'some-branch'), '')
    } finally {
      fixture.remove()
    }
  })
}

function runWt (shell, fixture, arg) {
  const initFile = path.join(fixture.root, `init.${shell}`)
  fs.writeFileSync(initFile, emitShellInit(shell))
  const script = shell === 'fish'
    ? `source ${initFile}; wt ${arg}`
    : `. ${initFile}; wt ${arg}`
  const result = spawnSync(shell, ['-c', script], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
      XDG_CONFIG_HOME: path.join(fixture.worktree, 'xdg'),
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return fs.existsSync(fixture.marker) ? fs.readFileSync(fixture.marker, 'utf8').trim() : ''
}

function createFixture () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-wt-init-'))
  const worktree = path.join(root, 'worktree')
  const binDir = path.join(root, 'bin')
  const marker = path.join(root, 'hook-ran')
  fs.mkdirSync(worktree)
  fs.mkdirSync(binDir)
  writeExecutable(path.join(binDir, 'git-wt'), `#!/bin/sh\necho '${worktree}'\n`)
  return {
    root,
    worktree,
    binDir,
    marker,
    addHook (relativePath, name) {
      writeExecutable(path.join(worktree, relativePath), `#!/bin/sh\necho "${name} $PR_NUMBER" > '${marker}'\n`)
    },
    remove () {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function writeExecutable (file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode: 0o755 })
}

function isInstalled (shell) {
  return spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0
}
