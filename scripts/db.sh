#!/usr/bin/env bash
# Cluster PostgreSQL privat al proiectului (fără sudo, separat de cel al sistemului).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN=/usr/lib/postgresql/16/bin
DATA="$ROOT/.data/pg"
PORT="${SEADOC_PG_PORT:-55432}"
SOCK="$ROOT/.data/sock"

ensure_env() {
  [ -f "$ROOT/.env" ] && return
  cat > "$ROOT/.env" <<ENV
DATABASE_URL=postgres://seadoc@127.0.0.1:$PORT/seadoc
PORT=4100
HOST=127.0.0.1
STORAGE_KEY=$(openssl rand -hex 32)
SIGNATURE_SECRET=$(openssl rand -hex 32)
STORAGE_DIR=.data/files
COOKIE_SECURE=false
ENV
  chmod 600 "$ROOT/.env"
}

case "${1:-start}" in
  start)
    ensure_env
    mkdir -p "$SOCK"
    if [ ! -f "$DATA/PG_VERSION" ]; then
      mkdir -p "$DATA"
      "$BIN/initdb" -D "$DATA" -U seadoc --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
      cat >> "$DATA/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
port = $PORT
unix_socket_directories = '$SOCK'
shared_buffers = 64MB
max_connections = 30
CONF
    fi
    if ! "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      "$BIN/pg_ctl" -D "$DATA" -l "$ROOT/.data/pg.log" -w start >/dev/null
    fi
    for db in seadoc seadoc_test; do
      "$BIN/psql" -h "$SOCK" -p "$PORT" -U seadoc -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
        || "$BIN/createdb" -h "$SOCK" -p "$PORT" -U seadoc "$db"
    done
    echo "PostgreSQL pornit pe 127.0.0.1:$PORT"
    ;;
  stop)
    "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null && echo "PostgreSQL oprit"
    ;;
  *)
    echo "folosire: db.sh start|stop" >&2; exit 2 ;;
esac
