#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Yan.Pro — ежедневный бэкап PostgreSQL.
# Запуск: ./scripts/backup-db.sh
# Cron (автоматически добавляется install.sh): 0 3 * * *
# Хранит последние 7 копий в backups/
# ═══════════════════════════════════════════════════════════════════════
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${ROOT}/backups"
KEEP=7
mkdir -p "${DIR}"

docker compose -f "${ROOT}/.github/docker/docker-compose.yml" exec -T postgres \
  pg_dump -U yanpro -d yanpro --format=custom > "${DIR}/yanpro-$(date +%F-%H%M).dump"

ls -1t "${DIR}"/yanpro-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) бэкап создан: ${DIR}/yanpro-$(date +%F-%H%M).dump"
