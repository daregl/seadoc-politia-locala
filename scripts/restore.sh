#!/usr/bin/env bash
# Restaurează un backup într-o bază și un director NOI, apoi verifică integritatea.
# Folosire: restore.sh <director-backup> <baza-noua> <director-fisiere-nou>
set -euo pipefail
[ $# -eq 3 ] || { echo "folosire: restore.sh <director-backup> <baza-noua> <director-fisiere-nou>" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN=/usr/lib/postgresql/16/bin
PORT="${SEADOC_PG_PORT:-55432}"
SOCK="$ROOT/.data/sock"
BACKUP="$1"; DB="$2"; FILES="$3"
if [ -n "$(ls -A "$FILES" 2>/dev/null)" ]; then echo "Directorul $FILES nu este gol" >&2; exit 1; fi
( cd "$BACKUP" && sha256sum -c --quiet SHA256SUMS )
"$BIN/createdb" -h "$SOCK" -p "$PORT" -U seadoc "$DB"
"$BIN/pg_restore" -h "$SOCK" -p "$PORT" -U seadoc -d "$DB" --no-owner --exit-on-error "$BACKUP/db.dump"
mkdir -p "$FILES"
tar -C "$FILES" -xf "$BACKUP/files.tar"
cd "$ROOT"
DATABASE_URL="postgres://seadoc@127.0.0.1:$PORT/$DB" RESTORE_FILES="$FILES" node scripts/verify-restore.mjs
