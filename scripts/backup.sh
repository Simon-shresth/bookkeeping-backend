#!/usr/bin/env bash
# Writes a compressed, timestamped pg_dump of the whole database.
#   DATABASE_URL=postgres://... npm run backup
#
# IMPORTANT (Supabase): pg_dump needs a DIRECT connection (port 5432) or the
# session pooler — NOT the transaction pooler (port 6543) that the running
# app may use. Use a separate BACKUP_DATABASE_URL if they differ.
# Backups contain all financial data: store them encrypted, off the same
# provider/account as the database, and never commit them to git.
set -euo pipefail

URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
if [ -z "$URL" ]; then echo "Set BACKUP_DATABASE_URL or DATABASE_URL" >&2; exit 1; fi
command -v pg_dump >/dev/null || { echo "pg_dump not found — install the PostgreSQL client tools" >&2; exit 1; }

OUT_DIR="${BACKUP_DIR:-backups}"
mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/bookkeeping-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

pg_dump "$URL" --no-owner --no-privileges | gzip > "$FILE"
echo "Wrote $FILE ($(du -h "$FILE" | cut -f1))"
