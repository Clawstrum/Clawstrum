#!/bin/bash
# Installs the voice-note transcriber used by src/voice.ts into ASR_DIR (first argument, default
# $CLAWSTRUM_HOME/asr): sherpa-onnx + PyAV under py/, Parakeet TDT 0.6b v2 int8 (~630 MB) under models/, a BPE
# vocabulary for boost lists, and Whisper's vocabulary (only used to tell rare words from common ones).
# PYTHON picks the interpreter (default python3); it must be the one named in config.json voice.python.
# Safe to re-run.
set -euo pipefail
ASR_DIR=${1:-${CLAWSTRUM_HOME:-$HOME/.clawstrum}/asr}
PY=${PYTHON:-python3}
M=sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
mkdir -p "$ASR_DIR/models"
cd "$ASR_DIR"

"$PY" -m pip install --quiet --upgrade --target ./py 'sherpa-onnx==1.13.8' 'av>=12' numpy

if [ ! -f "models/$M/encoder.int8.onnx" ]; then
  curl -sSfL -o "models/$M.tar.bz2" "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$M.tar.bz2"
  tar xjf "models/$M.tar.bz2" -C models && rm "models/$M.tar.bz2"
fi

# sherpa-onnx crashes on boost lists without a BPE vocabulary; Parakeet ships only tokens.txt
awk '$1 !~ /^</ {printf "%s\t%d\n", $1, -$2}' "models/$M/tokens.txt" > bpe.vocab

if [ ! -s whisper-vocab.txt ]; then
  curl -sSfL https://huggingface.co/Systran/faster-whisper-small/resolve/main/tokenizer.json |
    "$PY" -c 'import json,sys; v=json.load(sys.stdin)["model"]["vocab"]; print("\n".join(k[1:] for k in v if k.startswith("Ġ") and len(k)>2))' > whisper-vocab.txt
fi
echo "voice transcriber ready in $ASR_DIR"
