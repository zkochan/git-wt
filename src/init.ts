const BASH_ZSH = `wt() {
  local __wt_dir
  __wt_dir=$(command git-wt "$@") || return $?
  [ -n "$__wt_dir" ] && cd -- "$__wt_dir"
}
`

const FISH = `function wt
    set -l dir (command git-wt $argv)
    or return $status
    test -n "$dir"; and cd -- $dir
end
`

export function emitShellInit (shell: string): string {
  switch (shell) {
    case 'bash':
    case 'zsh':
      return BASH_ZSH
    case 'fish':
      return FISH
    default:
      throw new Error(`Unsupported shell: ${shell}. Supported: bash, zsh, fish.`)
  }
}
