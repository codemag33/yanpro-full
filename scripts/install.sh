#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Yan.Pro — установка на новый сервер одной командой.
#
#   ./scripts/install.sh [https://ваш-домен.ru]
#
# Что делает:
#   1. Проверяет Docker и Docker Compose
#   2. Создаёт .github/docker/.env с безопасными паролями (если нет)
#   3. Скачивает APK водителя из GitHub Release (если доступен)
#   4. Собирает и запускает Postgres + Redis + приложение
#   5. Ждёт готовности и создаёт администратора
#   6. Печатает пароль админа и адреса
# ═══════════════════════════════════════════════════════════════════════
set -e

DOMAIN="${1:-https://localhost}"
COMPOSE="docker compose -f .github/docker/docker-compose.yml"
ENV_FILE=".github/docker/.env"

echo "🚗 Yan.Pro — установка (домен: ${DOMAIN})"

# ─── 1. Требования ─────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ Docker не установлен. Установите Docker: https://docs.docker.com/engine/install/"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "❌ Docker Compose v2 (плагин 'docker compose') не найден"
  exit 1
fi

# ─── 2. Файл окружения ─────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "📝 Создаю ${ENV_FILE} с безопасными значениями..."
  umask 077
  cat > "$ENV_FILE" <<EOF
DB_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 48)
CORS_ORIGIN=${DOMAIN}
EOF
  echo "✅ ${ENV_FILE} создан"
else
  echo "ℹ️  ${ENV_FILE} уже существует — использую его (домен: $(grep -o '^CORS_ORIGIN=.*' "$ENV_FILE" | cut -d= -f2-))"
fi

# ─── 3. APK водителя (не критично для веб-версии) ──────────────────────
if [ -f scripts/update-apk.sh ]; then
  echo "📲 Загружаю APK водителя..."
  ./scripts/update-apk.sh || echo "⚠️  APK не загрузился — папка apk/ пуста, ссылка /apk будет 404"
else
  mkdir -p apk
fi

# ─── 4. Сборка и запуск ────────────────────────────────────────────────
echo "🐳 Собираю и запускаю контейнеры (первые разы — несколько минут)..."
$COMPOSE up -d --build

# ─── 5. Ожидание готовности ────────────────────────────────────────────
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

# ─── 6. Администратор ──────────────────────────────────────────────────
ADMIN_PASS=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)
$COMPOSE exec -T app node db/seed.js admin "$ADMIN_PASS" "Администратор" >/dev/null

echo ""
echo "══════════════════════════════════════════════════════"
echo "👤 Администратор:"
echo "   Логин:  admin"
echo "   Пароль: ${ADMIN_PASS}"
echo "   ⚠️  Сохраните его — второй раз он не покажется."
echo ""
echo "📱 Доступ:"
echo "   Пассажир:          ${DOMAIN}/passenger"
echo "   Водитель/механик:  ${DOMAIN}/driver"
echo "   Админка:           ${DOMAIN}/admin"
echo "   APK водителя:      ${DOMAIN}/apk/yanpro-driver.apk"
echo "══════════════════════════════════════════════════════"
echo ""
echo "⚠️  Следующие шаги:"
echo "   1. Настройте nginx с HTTPS → 127.0.0.1:3002 (шаблон: .github/docker/nginx.conf)"
echo "   2. Если меняли домен — обновите CORS_ORIGIN в ${ENV_FILE} и перезапустите:"
echo "      ${COMPOSE} up -d"
