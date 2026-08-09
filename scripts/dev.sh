#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Yan.Pro — локальный запуск в Docker на компьютере.
#
#   ./scripts/dev.sh [--seed] [--build]
#
# Поднимает Postgres + Redis + приложение на http://localhost:3002
#   --seed   дополнительно создать админа (логин admin, пароль из аргумента или admin123)
#   --build  принудительно пересобрать образ (нужно после изменений в frontend/src)
# ═══════════════════════════════════════════════════════════════════════
set -e

SEED=0
BUILD=0
for arg in "$@"; do
  [ "$arg" = "--seed" ] && SEED=1
  [ "$arg" = "--build" ] && BUILD=1
done

COMPOSE="docker compose -f .github/docker/docker-compose.yml"
ENV_FILE=".github/docker/.env"

echo "💻 Yan.Pro — локальный запуск в Docker"

# ─── Требования ────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ Docker не установлен. Установите Docker Desktop: https://www.docker.com/products/docker-desktop/"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "❌ Docker Compose v2 (плагин 'docker compose') не найден"
  exit 1
fi

# ─── Файл окружения (локальные значения) ───────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "📝 Создаю ${ENV_FILE} (локальный режим)..."
  umask 077
  cat > "$ENV_FILE" <<EOF
DB_PASSWORD=local_dev_db_pass
REDIS_PASSWORD=local_dev_redis_pass
JWT_SECRET=local_dev_jwt_secret_change_me
CORS_ORIGIN=http://localhost:3002
EOF
  echo "✅ ${ENV_FILE} создан"
else
  echo "ℹ️  Использую существующий ${ENV_FILE}"
fi

# ─── Запуск ────────────────────────────────────────────────────────────
if [ "$BUILD" = 1 ]; then
  echo "🐳 Пересборка образа..."
  $COMPOSE up -d --build
else
  echo "🐳 Запуск контейнеров (при первом запуске образ соберётся автоматически)..."
  $COMPOSE up -d
fi

# ─── Ожидание готовности ───────────────────────────────────────────────
echo "⏳ Ожидаю готовности приложения..."
for i in $(seq 1 45); do
  if curl -fsS "http://localhost:3002/health" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "✅ Приложение запущено"
    break
  fi
  if [ "$i" = 45 ]; then
    echo "❌ Приложение не поднялось за 90 секунд. Логи:"
    $COMPOSE logs app --tail 40
    exit 1
  fi
  sleep 2
done

# ─── Админ (опционально) ───────────────────────────────────────────────
if [ "$SEED" = 1 ]; then
  ADMIN_PASS="${2:-admin123}"
  $COMPOSE exec -T app node db/seed.js admin "$ADMIN_PASS" "Администратор" >/dev/null
  echo "👤 Администратор: admin / ${ADMIN_PASS}"
fi

echo ""
echo "══════════════════════════════════════════════════════"
echo "📱 Доступ:"
echo "   Пассажир:          http://localhost:3002/passenger"
echo "   Водитель/механик:  http://localhost:3002/driver"
echo "   Админка:           http://localhost:3002/admin"
echo "   API:               http://localhost:3002/api"
echo ""
echo "🔧 Команды:"
echo "   Логи:    ${COMPOSE} logs -f app"
echo "   Стоп:    ${COMPOSE} down"
echo "   Сброс БД: ${COMPOSE} down -v"
echo "══════════════════════════════════════════════════════"
