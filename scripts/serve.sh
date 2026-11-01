#!/usr/bin/env bash
# Pornește baza de date și aplicația dacă nu rulează deja. Se poate rula oricând.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
[ -f "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
PORT="$(grep -E '^PORT=' "$ROOT/.env" | cut -d= -f2)"; PORT="${PORT:-4100}"
LOG="$ROOT/.data/seadoc.log"

bash "$ROOT/scripts/db.sh" start >/dev/null || { echo "$(date -Is) baza de date nu a pornit" >> "$LOG"; exit 1; }
if ss -ltn "sport = :$PORT" | grep -q LISTEN; then exit 0; fi
# Jurnalul nu crește la nesfârșit.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 52428800 ]; then mv -f "$LOG" "$LOG.1"; fi
echo "$(date -Is) pornire SeaDoc" >> "$LOG"
cd "$ROOT"
setsid nohup node apps/api/dist/src/main.js >> "$LOG" 2>&1 < /dev/null &
disown
