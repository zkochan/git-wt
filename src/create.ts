import { execSync, type StdioOptions } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function createWorktree (arg: string): string {
  const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()

  // Git output goes to stderr so stdout carries only the final worktree path
  // (enables: cd "$(git-wt <arg>)")
  const gitStdio: StdioOptions = ['inherit', process.stderr, process.stderr]

  let localBranch: string
  let worktreePath: string

  if (/^\d+$/.test(arg)) {
    ({ localBranch, worktreePath } = createForPullRequest(arg, repoRoot, gitStdio))
  } else {
    ({ localBranch, worktreePath } = createForBranch(arg, repoRoot, gitStdio))
  }

  linkSharedDirs(repoRoot, worktreePath)

  return worktreePath
}

function createForPullRequest (prNumber: string, repoRoot: string, gitStdio: StdioOptions) {
  const localBranch = `pr-${prNumber}`
  const worktreePath = path.join(path.dirname(repoRoot), localBranch)

  const prJson = execSync(`gh pr view ${prNumber} --json headRefName,headRepositoryOwner,headRepository`, {
    encoding: 'utf8',
    cwd: repoRoot,
  })
  const pr = JSON.parse(prJson) as {
    headRefName: string
    headRepositoryOwner: { login: string }
    headRepository: { name: string }
  }
  const forkOwner = pr.headRepositoryOwner.login
  const forkRepo = pr.headRepository.name
  const remoteBranch = pr.headRefName

  // Use "origin" if the PR is from the same repo, otherwise add the fork as a remote
  const originUrl = execSync('git remote get-url origin', { encoding: 'utf8', cwd: repoRoot }).trim()
  const isFromOrigin = originUrl.includes(`/${forkOwner}/${forkRepo}`)
  const remoteName = isFromOrigin ? 'origin' : forkOwner

  if (!isFromOrigin) {
    try {
      execSync(`git remote get-url "${remoteName}"`, { encoding: 'utf8', cwd: repoRoot })
    } catch {
      execSync(`git remote add "${remoteName}" "https://github.com/${forkOwner}/${forkRepo}.git"`, { stdio: gitStdio, cwd: repoRoot })
    }
  }

  execSync(`git fetch "${remoteName}" "${remoteBranch}:${localBranch}"`, { stdio: gitStdio, cwd: repoRoot })
  execSync(`git worktree add "${worktreePath}" "${localBranch}"`, { stdio: gitStdio, cwd: repoRoot })

  // Set upstream so `git push` targets the correct fork and branch.
  // Use git-config directly instead of `branch --set-upstream-to` because
  // the targeted fetch above doesn't create a remote-tracking ref.
  execSync(`git -C "${worktreePath}" config "branch.${localBranch}.remote" "${remoteName}"`)
  execSync(`git -C "${worktreePath}" config "branch.${localBranch}.merge" "refs/heads/${remoteBranch}"`)

  return { localBranch, worktreePath }
}

function createForBranch (branch: string, repoRoot: string, gitStdio: StdioOptions) {
  // Slashes replaced with dashes so the directory name is filesystem-friendly
  const worktreePath = path.join(path.dirname(repoRoot), branch.replace(/\//g, '-'))
  try {
    execSync(`git worktree add "${worktreePath}" "${branch}"`, { stdio: gitStdio, cwd: repoRoot })
  } catch {
    // Branch doesn't exist yet — create it from the repo's default branch
    const baseBranch = detectDefaultBranch(repoRoot)
    execSync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, { stdio: gitStdio, cwd: repoRoot })
  }
  return { localBranch: branch, worktreePath }
}

function detectDefaultBranch (repoRoot: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', { encoding: 'utf8', cwd: repoRoot }).trim()
    // ref looks like "refs/remotes/origin/main"
    return ref.replace(/^refs\/remotes\/origin\//, '')
  } catch {
    return 'main'
  }
}

function linkSharedDirs (repoRoot: string, worktreePath: string): void {
  // Symlink shared directories from the git common dir into the new worktree so all
  // worktrees share the same settings without duplication. Only links dirs that already
  // exist in the common dir — so this is a no-op for repos that don't use them.
  const gitCommonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8', cwd: repoRoot }).trim()
  for (const dir of ['.claude', '.local-settings']) {
    const sharedDir = path.resolve(repoRoot, gitCommonDir, dir)
    if (!fs.existsSync(sharedDir)) continue
    const newDir = path.join(worktreePath, dir)
    if (fs.existsSync(newDir)) continue
    // 'junction' works without elevated privileges on Windows; ignored on Unix
    fs.symlinkSync(sharedDir, newDir, 'junction')
  }
}
