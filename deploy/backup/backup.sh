#!/bin/sh
# Periodic consistent backup of the SQLite keys/usage/records DB using the online
# .backup API (safe with WAL + a live writer). Keeps the last N daily backups.
set -eu

DB="${DB_PATH:-/data/cbam.sqlite}"
OUT="${BACKUP_DIR:-/backups}"
KEEP="${KEEP:-14}"
INTERVAL="${INTERVAL_SECONDS:-86400}"

mkdir -p "$OUT"

backup_once() {
  if [ ! -f "$DB" ]; then
    echo "$(date -u +%FT%TZ) db not present yet at $DB; skipping"
    return 0
  fi
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dest="$OUT/cbam-$ts.sqlite"
  # .backup is a hot, consistent snapshot (not a raw file copy).
  sqlite3 "$DB" ".backup '$dest'"
  gzip -f "$dest"
  echo "$(date -u +%FT%TZ) backup written: ${dest}.gz"
  # Retention: keep the newest $KEEP, delete the rest.
  ls -1t "$OUT"/cbam-*.sqlite.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old"
    echo "$(date -u +%FT%TZ) pruned old backup: $old"
  done
}

echo "sqlite backup loop: db=$DB out=$OUT keep=$KEEP interval=${INTERVAL}s"
while true; do
  backup_once || echo "$(date -u +%FT%TZ) backup failed (continuing)"
  sleep "$INTERVAL"
done
