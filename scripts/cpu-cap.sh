#!/bin/bash
# Claude shell prefix when runtime.shellCpuSeconds > 0: the CLI runs each agent command as `cpu-cap.sh '<command>'`.
# On a shared login node one agent's analysis can take the CPU every other conversation and user needs. A process
# over the soft limit gets SIGXCPU and exits 152.
CAP=${CLAWSTRUM_CPU_CAP_S:-300}
# The CLI starts MCP stdio servers through the same prefix. Clawstrum's server lives for the whole run, so a
# cumulative CPU limit would eventually kill it.
case "$1" in *cli.[jt]s*mcp*) exec /bin/bash -c "$1" ;; esac
ulimit -S -t "$CAP" 2>/dev/null
# SLURM copies rlimits into jobs (PropagateResourceLimits=ALL), so sbatch/srun/salloc go through wrappers that lift
# the limit first. The CLI's command starts by sourcing a shell snapshot that re-exports the session-start PATH, so
# the wrapper directory goes in again right after that source; exported functions cover a changed command shape.
WRAP="$(dirname "$(readlink -f "$0")")/cpu-cap-bin"
export PATH="$WRAP:$PATH"
for b in sbatch srun salloc; do
  eval "$b() { \"$WRAP/$b\" \"\$@\"; }"
  export -f "$b"
done
cmd="$1"
anchor=' 2>/dev/null || true && '
case "$cmd" in
  "source "*"$anchor"*)
    # Split instead of ${cmd/…/…}: from bash 5.2 an unquoted & in a replacement expands to the match.
    cmd="${cmd%%"$anchor"*}${anchor}export PATH='$WRAP':\"\$PATH\" && ${cmd#*"$anchor"}"
    ;;
esac
ulimit -c 0 2>/dev/null
/bin/bash -c "$cmd"
rc=$?
if [ "$rc" -eq 152 ]; then
  echo "[clawstrum] killed: a process used more than ${CAP} CPU-seconds (runtime.shellCpuSeconds) on a shared host. Run heavy work as a batch job; sbatch, srun and salloc are not capped." >&2
fi
exit $rc
