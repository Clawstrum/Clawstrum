#!/bin/bash
# Runs one subagent Bash command inside bubblewrap when config.sandbox.workers is on. The PreToolUse hook in
# src/worker-sandbox.ts rewrites each subagent Bash call to `/bin/bash <this> [options] -- '<command>'`.
#
#   --role R              subagent role (informational; the hook decides --offline)
#   --cwd DIR             worker directory: writable, and the command's working directory
#   --writable PATH       extra writable path (repeatable)
#   --offline             no network
#   --clawstrum-home DIR   state directory: its keys, logins, database and history are hidden
#   --storage-dir DIR     database directory (STORAGE.json), if not the state directory
#   --workspace DIR       the session workspace: its history/ is hidden
#   --account-home DIR    a provider login home (repeatable): hidden
#
# Everything is read-only except /tmp, the worker directory and --writable paths. Key-looking environment
# variables are dropped, $HOME shows only its non-dot entries and toolchain dirs, and SLURM clients are
# replaced by a stub that refuses at once.
set -u
role='' cwd=$PWD offline=0 mhome='' storage='' workspace=''
writable=() accounts=()
while [ $# -gt 0 ]; do
  case "$1" in
    --role) role=$2; shift 2 ;;
    --cwd) cwd=$2; shift 2 ;;
    --writable) writable+=("$2"); shift 2 ;;
    --offline) offline=1; shift ;;
    --clawstrum-home) mhome=$2; shift 2 ;;
    --storage-dir) storage=$2; shift 2 ;;
    --workspace) workspace=$2; shift 2 ;;
    --account-home) accounts+=("$2"); shift 2 ;;
    --) shift; break ;;
    *) echo "worker sandbox: unknown option $1" >&2; exit 2 ;;
  esac
done
cmd=${1?usage: worker-sandbox.sh [options] -- <command>}
: "$role"
# Mounts go on real paths: a state directory reached through a symlink was skipped below, leaving it all readable.
real() { [ -n "$1" ] && readlink -f -- "$1" || printf '%s' "$1"; }
mhome=$(real "$mhome") storage=$(real "$storage") workspace=$(real "$workspace")
for i in "${!accounts[@]}"; do accounts[i]=$(real "${accounts[i]}"); done

BWRAP=$(command -v bwrap || true)
if [ -z "$BWRAP" ]; then
  echo "worker sandbox: bubblewrap (bwrap) is not installed on $(hostname), so subagent shell commands are refused. Tell the lead." >&2
  exit 126
fi

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
H=${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}

for v in $(compgen -e); do
  case "${v^^}" in *KEY* | *TOKEN* | *SECRET* | *PASSW* | *CRED* | *AUTH* | *COOKIE*) unset "$v" ;; esac
done
unset BASH_ENV ENV

a=(--unshare-pid --die-with-parent --new-session)
[ "$offline" = 1 ] && a+=(--unshare-net)

# Mount points from mountinfo as "<fstype> <path>", octal escapes decoded. The kernel writes \ooo but %b reads
# \0 plus up to three digits, so "\0402" (a space before a 2) would decode to byte 2: rewrite to \0ooo first.
mi=$(printf '%b' "$(awk '{for (i = 7; i <= NF; i++) if ($i == "-") { print $(i + 1), $5; break }}' /proc/self/mountinfo |
  sed 's/\\\([0-7]\{3\}\)/\\0\1/g')")
is_autofs() { grep -qxF "autofs $1" <<<"$mi"; }

# The root is rebuilt from the top-level entries of /. An automounter directory (/net -hosts, /misc, /cvmfs)
# becomes a tmpfs holding only what is already mounted below it, so no lookup starts a new mount.
for e in /*; do
  case "$e" in /proc | /dev | /lost+found) continue ;; esac
  if [ -L "$e" ]; then
    a+=(--symlink "$(readlink "$e")" "$e")
  elif [ -d "$e" ] && is_autofs "$e"; then
    a+=(--tmpfs "$e")
    # Sorted with / lowest so each mount directly follows the one it sits in.
    top=''
    while IFS= read -r p; do
      [ -n "$top" ] && case "$p" in "$top" | "$top"/*) continue ;; esac
      # On a shared node, another user's automount can be one this user may not even stat; bwrap aborts on it.
      [ -e "$p" ] || continue
      a+=(--ro-bind "$p" "$p")
      top=$p
    done < <(awk -v e="$e/" '$1 != "autofs" { p = substr($0, length($1) + 2); if (index(p, e) == 1) print p }' <<<"$mi" | tr / '\001' | LC_ALL=C sort | tr '\001' /)
    a+=(--remount-ro "$e")
  elif [ -d "$e" ]; then
    a+=(--ro-bind "$e" "$e")
  fi
done
a+=(--dev /dev --proc /proc --bind /tmp /tmp)

# Entries of the state and database directories that stay hidden: keys and logins (runtime/accounts.json holds
# account tokens), history, diagnostics and the database.
hidden_entry() {
  case "$1" in
    .env | config.json | accounts | runtime | transcripts | history | reviews | diagnostics) return 0 ;;
    clawstrum.db | clawstrum.db-* | memory-lock.db | memory-lock.db-*) return 0 ;;
  esac
  return 1
}
# A path inside a hidden entry is already gone. Masking it again would make bwrap create its mount point on the
# read-only state tmpfs and fail every command, as account homes in the default H/accounts/<id>/<provider> did.
gone() {
  local d rel
  for d in ${mhome:+"$mhome"} ${storage:+"$storage"}; do
    case "$1" in "$d"/*) rel=${1#"$d"/} && hidden_entry "${rel%%/*}" && return 0 ;; esac
  done
  return 1
}
mask() {
  gone "$1" && return
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    a+=(--tmpfs "$1")
  elif [ -e "$1" ]; then a+=(--ro-bind /dev/null "$1"); fi
}

# $HOME starts as an empty tmpfs and gets back its non-dot entries plus toolchain dot-entries, read-only. Every
# other dot-entry (.ssh, .netrc, provider logins, app tokens) stays hidden without being listed.
a+=(--tmpfs "$H")
for p in "$H"/[!.]* "$H"/.local "$H"/.nvm "$H"/.mamba "$H"/.conda "$H"/.cache "$H"/.npm "$H"/.ipython \
  "$H"/.keras "$H"/.triton "$H"/.nv "$H"/.venvs "$H"/.gitconfig "$H"/.config/matplotlib; do
  if [ -L "$p" ]; then
    a+=(--symlink "$(readlink "$p")" "$p")
  elif [ -e "$p" ]; then a+=(--ro-bind-try "$p" "$p"); fi
done
# The state and database directories become a tmpfs that gets back, read-only, every entry except keys, logins,
# history and the database. Masking each database file instead would race SQLite: a -wal, -shm or -journal file
# that vanishes between the check and bwrap fails the call (bwrap cannot create its mount point on a read-only
# tree), and one created after the check would be readable. Entries come back with --ro-bind-try, so one removed
# in between is skipped. Done before the worker binds, which may sit inside the state directory.
shopt -s nullglob dotglob
for d in ${mhome:+"$mhome"} ${storage:+"$storage"}; do
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  a+=(--tmpfs "$d")
  for p in "$d"/*; do
    hidden_entry "${p##*/}" && continue
    if [ -L "$p" ]; then
      a+=(--symlink "$(readlink "$p")" "$p")
    else a+=(--ro-bind-try "$p" "$p"); fi
  done
  a+=(--remount-ro "$d")
done
shopt -u nullglob dotglob
for p in "$cwd" "${writable[@]}"; do
  [ -e "$p" ] && a+=(--bind "$p" "$p")
done

mask "$H/.cache/huggingface"
[ -n "$mhome" ] && for p in "$mhome"/groups/*/history; do mask "$p"; done
[ -n "$workspace" ] && mask "$workspace/history"
# Every channel's workspace sits in the same folder; the other channels' history is hidden too.
[ -n "$workspace" ] && for p in "$(dirname "$workspace")"/*/history; do mask "$p"; done
for p in "${accounts[@]}"; do mask "$p"; done
# SLURM's munge authentication socket and the user's runtime directory (D-Bus, keyring, agent sockets).
mask /run/munge
mask "/run/user/$(id -u)"

# SLURM clients fail at once with a reason, wherever they sit on PATH (cpu-cap-bin wrappers included).
IFS=: read -ra dirs <<<"${PATH:-}"
for d in "${dirs[@]}"; do
  for b in sbatch srun salloc scancel scontrol squeue sacct; do
    [ -n "$d" ] && [ -f "$d/$b" ] && a+=(--ro-bind "$HERE/worker-sandbox-noslurm.sh" "$d/$b")
  done
done

a+=(--remount-ro "$H" --remount-ro /)
exec "$BWRAP" "${a[@]}" --chdir "$cwd" /bin/bash -c "$cmd"
