# @zkochan/git-wt

Create git worktrees quickly from branches or PRs, with a shell helper that
`cd`s into the new worktree for you.

## Install

```sh
pnpm add -g @zkochan/git-wt
```

Then wire the `wt` shell function into your shell config so it's available
in every future session. Pick the one-liner for your shell — it appends the
snippet to the right rc file and activates it in the current session too:

**fish**:

```sh
echo 'git-wt init fish | source' >> ~/.config/fish/config.fish
git-wt init fish | source
```

**bash**:

```sh
echo 'eval "$(git-wt init bash)"' >> ~/.bashrc
eval "$(git-wt init bash)"
```

**zsh**:

```sh
echo 'eval "$(git-wt init zsh)"' >> ~/.zshrc
eval "$(git-wt init zsh)"
```

## Usage

From inside any existing worktree:

```sh
# Create a worktree for an existing branch and switch to it
wt fix/4444

# Create a worktree for a new branch (branched from the default branch) and switch to it
wt feat/my-feature

# Create a worktree for a GitHub PR (works for forks too) and switch to it
wt 10000
```

The new worktree is created as a sibling of the current one. Slashes in branch
names are replaced with dashes in the directory name (`feat/my-feature` →
`feat-my-feature/`).

Passing a number is interpreted as a PR number. The PR is fetched from the
appropriate remote (the fork's remote is added automatically if it doesn't
exist yet) into a local branch named `pr-<number>`, with upstream tracking set
so `git push` targets the right fork and branch. Requires the
[GitHub CLI](https://cli.github.com/) (`gh`).

### Without the shell helper

If you just want the path, invoke the binary directly:

```sh
git-wt feat/my-feature
git-wt 10000
```

Because `git-wt` follows the `git-<cmd>` plugin convention, you can also call
it as a native git subcommand:

```sh
git wt feat/my-feature
```

(Note: `git wt` can't change your shell's directory — that's what the `wt`
shell function is for.)

## Running a hook after creating a PR worktree

After `wt <pr-number>` creates a worktree and `cd`s into it, the shell function
runs an executable hook if one is found. It looks in two places, in order:

1. `<worktree>/.git-wt/pr-hook` — a per-repo hook that can be checked into the
   repo so every contributor gets the same behavior.
2. `~/.config/git-wt/pr-hook` (or `$XDG_CONFIG_HOME/git-wt/pr-hook`) — your
   personal default for any repo without its own hook.

The PR number is exposed to the hook as the `PR_NUMBER` environment variable.

A typical use is to launch a code review tool. Example: drop the following into
`~/.config/git-wt/pr-hook` (and `chmod +x` it) to start a Claude Code review of
every PR you check out:

```sh
#!/bin/sh
exec claude --dangerously-skip-permissions "Review and fix PR #$PR_NUMBER. Steps:
1. Use gh to read the PR description, diff, and all review comments (both PR-level and inline).
2. Understand the intent of the PR and what each change does.
3. Address every review comment — fix the code as requested or as appropriate.
4. Look for any other bugs, issues, or style problems in the changed code and fix those too.
5. Run the relevant tests to verify your fixes work.
6. Give me a summary of what you found and what you changed.
Do NOT push. Leave all non-merge changes unstaged for me to review."
```

The hook only runs for PR worktrees (when the argument is purely numeric); plain
branch checkouts skip it.

## Cleaning up merged worktrees

Over time, worktrees pile up for PRs that have long since been merged. Run:

```sh
git-wt cleanup --dry-run   # preview what would be removed
git-wt cleanup             # actually remove them
```

A worktree is removed, and its local branch deleted, when either signal says the
work has landed:

- the branch belongs to a merged PR (`gh pr list --head <branch> --state merged`)
- the branch is contained in the default branch (`git merge-base --is-ancestor`)

Both are needed. The PR lookup keys on the *head branch name*, so on its own it
misses a worktree created from someone else's PR — the local branch is
`pr-13024` while the PR's head is the contributor's own branch — and it misses
branches merged without a PR at all. Ancestry covers those; the PR lookup covers
branches whose remote ref was deleted on merge.

Never touched:

- protected branches (`main`, `master`, `v<NN>`), the current worktree, the bare
  repo, and detached HEADs
- worktrees holding **uncommitted changes or unpushed commits**. A merged PR does
  not mean the directory is idle — it is a normal place to start the follow-up.
  Pass `--force` to remove them anyway.

Requires the [GitHub CLI](https://cli.github.com/) (`gh`) to be authenticated.

### Reclaiming disk from worktrees you are keeping

Removing merged worktrees leaves the ones still in flight, and that is usually
where the disk has gone: a Cargo `target/` directory dwarfs the checkout beside
it. `--reclaim` deletes build artifacts from the worktrees that are kept, leaving
the checkout and the branch intact:

```sh
git-wt cleanup --reclaim --dry-run
git-wt cleanup --reclaim --idle-days 7
```

This applies to every worktree the run keeps, whatever kept it: an open PR,
uncommitted or unpushed work, a protected branch, a detached HEAD. Unfinished work is the reason
most worktrees are kept, and it is no reason to keep their compiler output — the
checkout, the branch and the edits all stay.

Only worktrees idle for at least `--idle-days` (default 14) are touched. Idle
means none of these for that long:

- a commit on the branch
- HEAD moving in that worktree (the checkout itself, a reset, a commit) — so a
  worktree checked out yesterday from a month-old PR is not idle
- an edit: the newest uncommitted file is what dates it, not the last commit
- a build, read off the artifacts themselves (`target/<profile>/deps` and the
  like) — so re-running the tests in a checkout you never edited keeps it

`--keep-target` and `--keep-node-modules` narrow what is deleted. The log
reports the bytes each reclaim freed.

Three things it will not delete:

- **Directories holding git-tracked files.** Test fixtures routinely keep tracked
  files under `node_modules/`; deleting those dirties the worktree and breaks the
  tests that read them.
- **A `target/` directory cargo did not create.** Only directories carrying
  cargo's `CACHEDIR.TAG` marker count as build output.
- **Anything in a worktree with a running build.** A build leaves the worktree
  clean in git terms, so `git status` cannot see it; the check reads `/proc`
  instead (Linux only).

The cost is a rebuild, which `sccache` makes cheap. On a 60-worktree checkout of
`pnpm/pnpm` this recovered 1.7 TB.

## Shared config across worktrees

If `.claude` or `.local-settings` exists in your repo's [git common dir][common-dir]
(i.e. the shared gitdir, which for a bare repo is the bare repo directory itself),
`git-wt` will symlink it into every new worktree. This lets all your worktrees
share the same Claude Code / local settings without duplication. Non-existent
dirs are silently skipped.

[common-dir]: https://git-scm.com/docs/git-rev-parse#Documentation/git-rev-parse.txt---git-common-dir

## Recommended layout: bare repo with worktrees as children

`git-wt` works great with a bare-repo layout where every branch is a directory
next to the others, instead of having one "main clone" with siblings:

```
~/src/pnpm/pnpm/          # the bare repo (HEAD, config, objects/, refs/, worktrees/)
├── main/                 # worktree for main
├── fix-1234/             # worktree for branch fix/1234
└── feat-my-feature/      # worktree for branch feat/my-feature
```

One-time setup:

```sh
# Clone as bare at the directory that will hold all worktrees
git clone --bare https://github.com/<owner>/<repo>.git ~/src/<owner>/<repo>
cd ~/src/<owner>/<repo>

# (Optional) If you use Husky, point it at a path that exists in every worktree
git config core.hooksPath .husky/_

# Add the first worktree for the default branch
git worktree add main main
cd main
```

From then on, `wt <branch>` or `wt <pr-number>` creates new worktrees as
siblings of `main/`.

## License

MIT
