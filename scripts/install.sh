#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Yan.Pro — установка на новый сервер одной командой.
#
#   ./scripts/install.sh [https://ваш-домен.ru] [--nginx]
#
# Что делает:
#   1. Проверяет Docker и Docker Compose
#   2. Создаёт .github/docker/.env с безопасными паролями (если нет)
#   3. Скачивает APK водителя из GitHub Release (если доступен)
#   4. Собирает и запускает Postgres + Redis + приложение
#   5. Ждёт готовности и создаёт администратора
#   6. Печатает пароль админа и адреса
#   7. [--nginx] ставит nginx + certbot и выпускает HTTPS-сертификат
# ═══════════════════════════════════════════════════════════════════════
set -e

DOMAIN="${1:-https://localhost}"
WITH_NGINX=0
for arg in "$@"; do [ "$arg" = "--nginx" ] && WITH_NGINX=1; done

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

# ─── 7. Nginx + HTTPS (опционально) ───────────────────────────────────
HOST="${DOMAIN#https://}"
HOST="${HOST#http://}"
if [ "$WITH_NGINX" = 1 ]; then
  if [ "$HOST" = "localhost" ]; then
    echo "❌ Для --nginx нужен реальный домен (не https://localhost). Пропускаю настройку nginx."
  else
    echo "🌐 Настраиваю nginx + HTTPS для ${HOST}..."
    if command -v nginx >/dev/null 2>&1; then
      echo "ℹ️  nginx уже установлен"
    else
      apt-get update -y && apt-get install -y nginx certbot python3-certbot-nginx || { echo "❌ Не удалось установить nginx/certbot (нужны права root). Пропускаю."; }
    fi
    if command -v nginx >/dev/null 2>&1; then
      cat > /etc/nginx/sites-available/yanpro <<EOF
server {
    listen 80;
    server_name ${HOST};

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Socket.IO не должен буферизоваться
    location /socket.io {
        proxy_pass http://127.0.0.1:3002/socket.io;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    gzip on;
    gzip_types text/plain text/css text/javascript application/javascript application/json;
    gzip_min_length 1000;
    gzip_proxied any;
}
EOF
      ln -sf /etc/nginx/sites-available/yanpro /etc/nginx/sites-enabled/yanpro
      rm -f /etc/nginx/sites-enabled/default
      nginx -t && systemctl reload nginx
      echo "🔐 Выпускаю сертификат Let's Encrypt..."
      certbot --nginx -d "${HOST}" --redirect --non-interactive --agree-tos \
        --register-unsafely-without-email || \
        echo "⚠️  Не удалось выпустить сертификат. Проверьте, что A-запись ${HOST} указывает на этот сервер."
      systemctl reload nginx
      echo "✅ HTTPS настроен: https://${HOST}"
    fi
  fi
fi

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
if [ "$WITH_NGINX" = 1 ] && [ "$HOST" != "localhost" ]; then
  echo "✅ HTTPS настроен — ничего делать не нужно."
else
  echo "⚠️  Следующие шаги:"
  echo "   1. Настройте nginx с HTTPS → 127.0.0.1:3002 (или повторно запустите с --nginx)"
  echo "      ./scripts/install.sh ${DOMAIN} --nginx"
  echo "   2. Если меняли домен — обновите CORS_ORIGIN в ${ENV_FILE} и перезапустите:"
  echo "      ${COMPOSE} up -d"
fi
