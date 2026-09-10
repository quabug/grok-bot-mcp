#!/usr/bin/env bash
echo "Unauthenticated public start is disabled." >&2
echo "Use: bash start-secure.sh   # HTTPS + OAuth for remote clients" >&2
echo " Or: bash start-stdio.sh    # stdio bridge for Claude/Cursor (loopback)" >&2
exit 1
