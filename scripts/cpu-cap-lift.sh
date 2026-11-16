#!/bin/bash
# Usage: cpu-cap-lift.sh <command> [args...], called by the cpu-cap-bin wrappers. SLURM copies rlimits into jobs
# (PropagateResourceLimits=ALL), so lift the agent's CPU limit, then run the next <command> on PATH after
# cpu-cap-bin.
ulimit -S -t unlimited 2>/dev/null
name=$1
shift
skip=$(cd "$(dirname "$(readlink -f "$0")")/cpu-cap-bin" && pwd -P)
IFS=: read -ra dirs <<<"$PATH"
for d in "${dirs[@]}"; do
  [ -n "$d" ] && [ -x "$d/$name" ] || continue
  [ "$(cd "$d" 2>/dev/null && pwd -P)" = "$skip" ] && continue
  exec "$d/$name" "$@"
done
echo "$name: not found on PATH" >&2
exit 127
