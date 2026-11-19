#!/bin/sh
set -eu
umask 077

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

BACKUP_DIR=${SPOTTER_BACKUP_DIR:-"$ROOT_DIR/backups"}
ENV_FILE=${SPOTTER_COMPOSE_ENV_FILE:-}
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
CONTAINER_BACKUP="/tmp/spotter-sqlite-$STAMP.sqlite3"
OUTPUT="$BACKUP_DIR/spotter-$STAMP.sqlite3"
TEMP_OUTPUT="$OUTPUT.tmp"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

compose() {
	if [ -n "$ENV_FILE" ]; then
		docker compose --env-file "$ENV_FILE" "$@"
	else
		docker compose "$@"
	fi
}

cleanup() {
	compose exec -T backend rm -f "$CONTAINER_BACKUP" >/dev/null 2>&1 || true
	rm -f "$TEMP_OUTPUT"
}
trap cleanup EXIT HUP INT TERM

compose exec -T backend python -c 'import sqlite3,sys; source=sqlite3.connect("/data/db.sqlite3"); target=sqlite3.connect(sys.argv[1]); source.backup(target); target.close(); source.close()' "$CONTAINER_BACKUP"
compose exec -T backend python -c 'import sqlite3,sys; db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); result=db.execute("PRAGMA integrity_check").fetchone()[0]; db.close(); print(result); sys.exit(result != "ok")' "$CONTAINER_BACKUP" >/dev/null
compose exec -T backend sh -c 'cat "$1"' sh "$CONTAINER_BACKUP" > "$TEMP_OUTPUT"
mv "$TEMP_OUTPUT" "$OUTPUT"
find "$BACKUP_DIR" -type f -name 'spotter-*.sqlite3' -mtime +14 -delete
printf 'SQLite backup saved: %s\n' "$OUTPUT"
