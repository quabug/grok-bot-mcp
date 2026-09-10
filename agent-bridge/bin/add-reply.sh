#!/usr/bin/env bash
# Record a teammate reply into inbox/.
# Usage:
#   add-reply.sh <from_agent_id_or_name> <message...>
#   echo "message" | add-reply.sh <from_agent_id_or_name>
#   add-reply.sh --from <id|name> --name <name> --message <text>
#
# --from / positional from always resolves to a UUID via agents.json when possible.
# from_agent_id stored in the inbox JSON is always a UUID (or the raw key if unresolved).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INBOX="$ROOT/inbox"
AGENTS_JSON="$ROOT/agents.json"

FROM_KEY=""
FROM_NAME=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM_KEY="$2"; shift 2 ;;
    --name) FROM_NAME="$2"; shift 2 ;;
    --message|-m) MESSAGE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: add-reply.sh <from_agent_id_or_name> [message...]"
      echo "       echo msg | add-reply.sh <from_agent_id_or_name>"
      echo "       add-reply.sh --from ID_OR_NAME [--name NAME] --message TEXT"
      exit 0
      ;;
    *)
      if [[ -z "$FROM_KEY" ]]; then
        FROM_KEY="$1"; shift
      else
        MESSAGE="${MESSAGE:+$MESSAGE }$1"; shift
      fi
      ;;
  esac
done

if [[ -z "$FROM_KEY" ]]; then
  echo "from_agent_id (or name) required" >&2
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

# Resolve --from / positional to UUID (+ name) via agents.json whenever possible.
FROM_ID="$FROM_KEY"
if [[ -f "$AGENTS_JSON" ]]; then
  RESOLVED="$(node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const key=String(process.argv[2]||"").trim();
    const lower=key.toLowerCase();
    const agents=j.agents||[];
    const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let a=agents.find(x=>x.id===key);
    if(!a) a=agents.find(x=>x.serverId!=null && String(x.serverId)===key);
    if(!a) a=agents.find(x=>String(x.name).toLowerCase()===lower);
    if(!a) {
      const partial=agents.filter(x=>String(x.name).toLowerCase().includes(lower));
      if(partial.length===1) a=partial[0];
    }
    if(a) {
      console.log(JSON.stringify({id:a.id,name:a.name,resolved:true}));
    } else if(uuidRe.test(key)) {
      console.log(JSON.stringify({id:key,name:"",resolved:false}));
    } else {
      console.log(JSON.stringify({id:key,name:"",resolved:false,warn:"unresolved_name"}));
    }
  ' "$AGENTS_JSON" "$FROM_KEY" 2>/dev/null || true)"
  if [[ -n "$RESOLVED" ]]; then
    FROM_ID="$(node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(o.id)' "$RESOLVED")"
    RESOLVED_NAME="$(node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(o.name||"")' "$RESOLVED")"
    if [[ -z "$FROM_NAME" && -n "$RESOLVED_NAME" ]]; then
      FROM_NAME="$RESOLVED_NAME"
    fi
    WARN="$(node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(o.warn||"")' "$RESOLVED")"
    if [[ "$WARN" == "unresolved_name" ]]; then
      echo "warning: could not resolve '$FROM_KEY' to a UUID in agents.json; storing as-is" >&2
    fi
  fi
fi

# If still missing name but we have a UUID, look up again
if [[ -z "$FROM_NAME" && -f "$AGENTS_JSON" ]]; then
  FROM_NAME="$(node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const id=process.argv[2];
    const a=(j.agents||[]).find(x=>x.id===id || String(x.serverId)===id);
    process.stdout.write(a?a.name:"");
  ' "$AGENTS_JSON" "$FROM_ID" 2>/dev/null || true)"
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
