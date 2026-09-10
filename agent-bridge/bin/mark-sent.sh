#!/usr/bin/env bash
# Move an outbox item to sent/ after successful SendToAgent dispatch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID="${1:-}"
if [[ -z "$ID" ]]; then
  echo "Usage: mark-sent.sh <outbox-id>" >&2
  exit 1
fi
ID="${ID%.json}"
SRC="$ROOT/outbox/${ID}.json"
DST="$ROOT/sent/${ID}.json"
if [[ ! -f "$SRC" ]]; then
  echo "Not found in outbox: $ID" >&2
  exit 1
fi
# Update status then move
node -e '
  const fs=require("fs");
  const p=process.argv[1];
  const o=JSON.parse(fs.readFileSync(p,"utf8"));
  o.status="sent";
  o.sent_at=new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(o,null,2)+"\n");
' "$SRC"
mv "$SRC" "$DST"
echo "marked sent: $ID → $DST"
