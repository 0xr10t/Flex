#!/usr/bin/env bash
# Runs the agent-layer edge-case prompts against the local Ollama model and writes a report.
#
#   scripts/edge-cases.sh                 # all cases
#   scripts/edge-cases.sh E1,F6,H3        # selected case IDs
#
# Env: EDGE_MODEL (default qwen3:8b), EDGE_THINK=1 to allow model thinking, EDGE_TAG for the report name.
# Reports land in test/edge/results/<tag>.md and .json. No real chain, wallet or payment is touched.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -s "$HOME/.nvm/nvm.sh" ] && [ -f .nvmrc ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use >/dev/null
fi

if ! curl --fail --silent --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "Ollama is not running on 127.0.0.1:11434. Start it with: ollama serve" >&2
  exit 1
fi

if [ $# -gt 0 ]; then export EDGE_IDS="$1"; fi
export EDGE_TAG="${EDGE_TAG:-edge-$(date +%Y%m%d-%H%M%S)}"

npx vitest run --config test/edge/vitest.edge.config.ts --reporter=verbose
