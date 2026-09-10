#!/usr/bin/env bash
# List pending outbox messages for parent dispatch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTBOX="$ROOT/outbox"
shopt -s nullglob
files=("$OUTBOX"/*.json)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "[]"
  exit 0
fi
# Prefer jq if present; else node
if command -v jq >/dev/null 2>&1; then
  jq -s 'sort_by(.created_at)' "$OUTBOX"/*.json
else
  node -e '
    const fs=require("fs"); const path=require("path");
    const d=process.argv[1];
    const items=fs.readdirSync(d).filter(f=>f.endsWith(".json"))
      .map(f=>JSON.parse(fs.readFileSync(path.join(d,f),"utf8")))
      .sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
    console.log(JSON.stringify(items,null,2));
  ' "$OUTBOX"
fi
