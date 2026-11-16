#!/bin/bash
# Bound over every SLURM client inside scripts/worker-sandbox.sh.
echo "worker sandbox: $(basename "$0") is not available to subagents (no SLURM access in the sandbox). Say in your answer what job should run and the lead will submit it." >&2
exit 126
