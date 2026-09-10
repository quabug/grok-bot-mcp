#!/usr/bin/env bash
# Record a teammate reply into inbox/.
# Usage:
#   add-reply.sh <from_agent_id> <message...>
#   echo "message" | add-reply.sh <from_agent_id>
#   add-reply.sh --from <id> --name <name> --message <text>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INBOX="$ROOT/inbox"
AGENTS_JSON="$ROOT/agents.json"

FROM_ID=""
FROM_NAME=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM_ID="$2"; shift 2 ;;
    --name) FROM_NAME="$2"; shift 2 ;;
    --message|-m) MESSAGE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: add-reply.sh <from_agent_id> [message...]"
      echo "       echo msg | add-reply.sh <from_agent_id>"
      echo "       add-reply.sh --from ID [--name NAME] --message TEXT"
      exit 0
      ;;
    *)
      if [[ -z "$FROM_ID" ]]; then
        FROM_ID="$1"; shift
      else
        MESSAGE="${MESSAGE:+$MESSAGE }$1"; shift
      fi
      ;;
  esac
done

if [[ -z "$FROM_ID" ]]; then
  echo "from_agent_id required" >&2
  exit 1
fi

if [[ -z "$MESSAGE" ]]; then
  if [[ ! -t 0 ]]; then
    MESSAGE="$(cat)"
  fi
fi
MESSAGE="$(printf '%s' "$MESSAGE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ -z "$MESSAGE" ]]; then
  echo "message required (args or stdin)" >&2
  exit 1
fi

# Resolve name from agents.json if missing
if [[ -z "$FROM_NAME" && -f "$AGENTS_JSON" ]]; then
  FROM_NAME="$(node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const id=process.argv[2];
    const a=(j.agents||[]).find(x=>x.id===id || String(x.serverId)===id);
    process.stdout.write(a?a.name:"");
  ' "$AGENTS_JSON" "$FROM_ID" 2>/dev/null || true)"
fi
# If FROM_ID looked like a name, try reverse resolve
if [[ ! "$FROM_ID" =~ ^[0-9a-f-]{36}$ ]] && [[ -f "$AGENTS_JSON" ]]; then
  RESOLVED="$(node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const key=process.argv[2].toLowerCase();
    const a=(j.agents||[]).find(x=>x.id===process.argv[2] || String(x.serverId)===process.argv[2]
      || String(x.name).toLowerCase()===key);
    if(a) console.log(JSON.stringify({id:a.id,name:a.name}));
  ' "$AGENTS_JSON" "$FROM_ID" 2>/dev/null || true)"
  if [[ -n "$RESOLVED" ]]; then
    FROM_NAME="$(node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(o.name)' "$RESOLVED")"
    FROM_ID="$(node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(o.id)' "$RESOLVED")"
  fi
fi

ID="$(node -e 'console.log(require("crypto").randomUUID())')"
FILE="$INBOX/${ID}.json"
node -e '
  const fs=require("fs");
  const [file,id,fromId,fromName,message]=process.argv.slice(1);
  const item={
    id,
    from_agent_id: fromId,
    from_name: fromName || fromId,
    message,
    created_at: new Date().toISOString(),
    read: false,
  };
  fs.writeFileSync(file, JSON.stringify(item,null,2)+"\n");
  console.log(JSON.stringify({ok:true, inbox_id:id, path:file, from_agent_id:fromId, from_name:item.from_name},null,2));
' "$FILE" "$ID" "$FROM_ID" "${FROM_NAME:-}" "$MESSAGE"
