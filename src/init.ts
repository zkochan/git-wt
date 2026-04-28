const BASH_ZSH = `wt() {
  local __wt_dir
  __wt_dir=$(command git-wt "$@") || return $?
  [ -n "$__wt_dir" ] && [ -d "$__wt_dir" ] && cd -- "$__wt_dir" || return 1
  if [[ "$1" =~ ^[0-9]+$ ]]; then
    local __wt_hook="\${XDG_CONFIG_HOME:-$HOME/.config}/git-wt/pr-hook"
    [ -x "$__wt_hook" ] && PR_NUMBER="$1" "$__wt_hook"
  fi
}
`

const FISH = `function wt
    set -l dir (command git-wt $argv)
    or return $status
    test -n "$dir" -a -d "$dir"; and cd -- $dir
    or return 1
    if string match -qr '^\\d+$' -- $argv[1]
        set -l config_home (set -q XDG_CONFIG_HOME; and echo $XDG_CONFIG_HOME; or echo $HOME/.config)
        set -l hook $config_home/git-wt/pr-hook
        test -x $hook; and PR_NUMBER=$argv[1] $hook
    end
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
