#!/usr/bin/env bash
# Backup: baza de date și fișierele criptate. Păstrează ultimele KEEP copii.
# Cheia din .env NU intră în backup: păstrați-o separat, fără ea fișierele nu se pot citi.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN=/usr/lib/postgresql/16/bin
DEST="${SEADOC_BACKUP_DIR:-$ROOT/.data/backups}"
KEEP="${SEADOC_BACKUP_KEEP:-14}"
DB="${SEADOC_BACKUP_DB:-seadoc}"
PORT="${SEADOC_PG_PORT:-55432}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$DEST/.tmp-$STAMP"
umask 077
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

"$BIN/pg_dump" -h "$ROOT/.data/sock" -p "$PORT" -U seadoc -Fc -f "$TMP/db.dump" "$DB"
# Fișierele se copiază după baza de date: orice document din dump are deja fișierul pe disc.
FILES="$(grep -E '^STORAGE_DIR=' "$ROOT/.env" | cut -d= -f2)"; FILES="${FILES:-.data/files}"
case "$FILES" in /*) ;; *) FILES="$ROOT/$FILES" ;; esac
tar -C "$FILES" -cf "$TMP/files.tar" .
( cd "$TMP" && sha256sum db.dump files.tar > SHA256SUMS )
mv "$TMP" "$DEST/$STAMP"
trap - EXIT

ls -1d "$DEST"/[0-9]*-[0-9]* | sort | head -n -"$KEEP" | while read -r old; do rm -rf -- "$old"; done
du -sh "$DEST/$STAMP" | awk -v s="$STAMP" '{print "backup " s ": " $1}'
