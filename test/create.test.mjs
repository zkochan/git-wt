import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const cli = path.resolve(import.meta.dirname, '../lib/index.js')

for (const name of ['cleanup', 'init', '123']) {
  test(`-- ${name} creates a worktree for a branch named ${name}`, () => {
    const fixture = createRepo()
    try {
      const result = runCli(fixture.repo, ['--', name])
      assert.equal(result.status, 0, result.stderr)
      const expected = path.join(fixture.root, name)
      assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(expected))
      assert.equal(git(expected, 'rev-parse', '--abbrev-ref', 'HEAD'), name)
    } finally {
      fixture.remove()
    }
  })
}

test('-- without a branch name is an error', () => {
  const fixture = createRepo()
  try {
    const result = runCli(fixture.repo, ['--'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage: git-wt -- <branch-name>/)
  } finally {
    fixture.remove()
  }
})

function runCli (cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: gitEnv() })
}

function createRepo () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-wt-create-'))
  const repo = path.join(root, 'main')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  return {
    root,
    repo,
    remove () {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function git (cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim()
}

function gitEnv () {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
}
