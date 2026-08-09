# Yan.Pro — Платформа такси и помощи на дороге

Полнофункциональная платформа для заказа такси и вызова механика, состоящая из:
- **Backend** — Node.js/Express + Socket.IO + PostgreSQL + Redis
- **PWA для пассажира** — реактивный веб-клиент с картой и поиском адреса
- **PWA для водителя/механика** — управление заказами, заработок, история (стиль Яндекс.Про)
- **Android приложение (водитель)** — нативное, взаимодействует с тем же бэкендом

## Быстрый старт (локально)

### 1. Требования
- Node.js 18+
- PostgreSQL 14+ с PostGIS
- Redis
- Docker (опционально)

### 2. Подготовка БД
```bash
sudo -u postgres createuser yanpro -P
sudo -u postgres createdb yanpro -O yanpro
psql "postgres://yanpro:ваш_пароль@localhost/yanpro" -f backend/db/schema.sql
```

### 3. Запуск сервера
```bash
cd backend
cp .env.example .env
# Отредактируйте .env: DATABASE_URL, REDIS_URL, JWT_SECRET (openssl rand -hex 32)
npm install
node db/seed.js admin "МойПароль123" "Администратор"
npm start
```

Сервер слушает на `http://localhost:3002`. 

### 4. Доступ к клиентам
- **Пассажир**: `http://localhost:3002/passenger`
- **Водитель/механик**: `http://localhost:3002/driver`

### 5. Health check
```bash
curl http://localhost:3002/health
```

## Развёртывание на новом сервере (Docker)

Всё (PostgreSQL + PostGIS, Redis, бэкенд и собранные PWA-клиенты) поднимается через
Docker Compose одной командой.

### Требования
- Linux-сервер (Ubuntu/Debian), **1 vCPU / 1–2 ГБ RAM / 10+ ГБ SSD** — минимум; рекомендуемо 2 vCPU / 2–4 ГБ RAM / 20+ ГБ SSD
- Docker + Docker Compose v2 (`docker compose version` — должен работать)

### Установка (одна команда)

```bash
git clone https://github.com/codemag33/yanpro-full.git
cd yanpro-full

# Аргумент — ваш будущий домен (для CORS). Можно без аргумента — будет https://localhost
# Опция --nginx — автоматически установит nginx + certbot и выпустит HTTPS-сертификат
./scripts/install.sh https://taxi.example.ru --nginx
```

Скрипт автоматически:
1. Проверяет Docker
2. Создаёт `.github/docker/.env` с сгенерированными паролями БД/Redis и JWT_SECRET
3. Скачивает APK водителя из GitHub Release в `apk/`
4. Собирает образ и запускает контейнеры (`docker compose up -d --build`)
5. Ждёт готовности и создаёт администратора
6. Настраивает прод: **swap 2 ГБ** (если RAM ≤ 2 ГБ), **файрвол ufw** (наружу только 22/80/443), автозапуск Docker, **cron-бэкап БД** (ежедневно 03:00, 7 копий в `backups/`)
7. Выводит **логин/пароль админа** и адреса
8. С `--nginx` — ставит nginx + certbot, настраивает прокси на 127.0.0.1:3002 и выпускает сертификат Let's Encrypt (домен должен указывать A-записью на сервер)

> ⚠️ Пароль администратора печатается один раз — сохраните его.
> ⚠️ Файрвол открывает только 22/80/443 — Postgres и Redis остаются доступны лишь локально (127.0.0.1), как и задумано.

### Бэкапы

```bash
# Запустить вручную (после каждого деплоя тоже не помешает)
./scripts/backup-db.sh          # сохранит копию в backups/yanpro-ГГГГ-ММ-ДД-ЧЧММ.dump

# Восстановить последнюю копию
docker compose -f .github/docker/docker-compose.yml exec -T postgres \
  pg_restore -U yanpro -d yanpro --clean --if-exists < backups/yanpro-XXXX.dump
```

### Вручную

```bash
git clone https://github.com/codemag33/yanpro-full.git && cd yanpro-full

# Переменные окружения: compose читает .env из своей папки (.github/docker/.env)
cat > .github/docker/.env <<EOF
DB_PASSWORD=сложный_пароль
REDIS_PASSWORD=сложный_пароль
JWT_SECRET=длинная_случайная_строка
CORS_ORIGIN=https://taxi.example.ru
EOF

# APK водителя (опционально, для /apk/yanpro-driver.apk)
./scripts/update-apk.sh

# Сборка и запуск
docker compose -f .github/docker/docker-compose.yml up -d --build
```

### Nginx + HTTPS

Скрипт делает это автоматически с опцией `--nginx` (ставит nginx, certbot и выпускает сертификат). Вручную — так:

Приложение слушает порт `3002` (внутри контейнера). Наружу его выводит nginx с SSL:

```nginx
# .github/docker/nginx.conf — готовый шаблон (обновите server_name и пути к сертификатам)
server {
    listen 443 ssl;
    server_name taxi.example.ru;
    ssl_certificate     /etc/letsencrypt/live/taxi.example.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/taxi.example.ru/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
server {
    listen 80;
    server_name taxi.example.ru;
    return 301 https://$host$request_uri;
}
```

```bash
apt install -y nginx certbot python3-certbot-nginx
certbot --nginx -d taxi.example.ru        # выпустит сертификат и пропишет в конфиг
systemctl reload nginx
```

### Обновление после `git pull`

```bash
cd yanpro-full
git pull
docker compose -f .github/docker/docker-compose.yml up -d --build
```

### Полезные команды

```bash
docker compose -f .github/docker/docker-compose.yml logs -f app   # логи
docker compose -f .github/docker/docker-compose.yml ps            # статус
docker compose -f .github/docker/docker-compose.yml down          # остановить
```

### Структура контейнеров

| Сервис | Назначение | Порт |
|--------|-----------|------|
| `app` | Node.js бэкенд + собранные PWA (`/passenger`, `/driver`, `/admin`), раздача APK (`/apk`) | 3002 (наружу) |
| `postgres` | PostgreSQL + PostGIS, схема создаётся автоматически из `backend/db/schema.sql` | 127.0.0.1:5432 |
| `redis` | Кэш и гео-индексы водителей | 127.0.0.1:6379 |

### Вручную (без Docker)
1. Установите PostgreSQL, Redis, Node.js
2. Создайте БД (см. выше)
3. `npm install && npm start` в `backend/`
4. Раздача PWA (`/passenger` и `/driver`) встроена в Express

## GitHub Actions CI/CD

Pipeline автоматически:
- Проверяет синтаксис Node.js кода
- Запускает тесты (если есть)
- Собирает Docker образ на каждый коммит в `main`
- Пушит образ в Docker Registry (GitHub Container Registry)

Конфиг: `.github/workflows/deploy.yml`

## Android приложение водителя

Сборка полностью автоматизирована через GitHub Actions (`.github/workflows/android.yml`).

### Как собирается

```
push в android/** (main/develop)  или  вручную: Actions → Android Build → Run workflow
        │
        ▼
ubuntu-latest: JDK 17 → ./gradlew assembleDebug   (всегда)
                 └→ ./gradlew assembleRelease      (если заданы секреты подписи)
        │
        ▼
main + push → публикация в GitHub Release "latest-apk" → yanpro-driver.apk
        │
        ▼
сервер: scripts/update-apk.sh (cron) → apk/ → https://ваш-домен/apk/yanpro-driver.apk
```

- **Debug APK** собирается всегда — артефакт в Actions (`driver-app-debug`).
- **Release APK** (minified + подписанный) собирается, если в репозитории заданы
  секреты подписи — приоритет при публикации.

### Настройка подписи (однократно)

1. Создайте keystore локально:
   ```bash
   keytool -genkey -v -keystore release.keystore -alias yanpro -keyalg RSA \
     -keysize 2048 -validity 10000
   ```
2. В GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
   | Secret | Значение |
   |--------|----------|
   | `KEYSTORE_FILE_B64` | `base64 release.keystore` (команда: `base64 -w0 release.keystore`) |
   | `KEYSTORE_PASSWORD` | пароль keystore |
   | `KEY_ALIAS` | алиас (`yanpro`) |
   | `KEY_PASSWORD` | пароль ключа |

3. Без секретов CI просто соберёт debug-APK (как раньше).

### Локальная сборка

```bash
cd android
./gradlew assembleDebug      # debug
./gradlew assembleRelease    # release (нужен keystore, см. ниже)

# Release с подписью локально: укажите переменные или добавьте в ~/.gradle/gradle.properties
export KEYSTORE_FILE=/path/to/release.keystore KEYSTORE_PASSWORD=... KEY_ALIAS=... KEY_PASSWORD=...
./gradlew assembleRelease
```

## API документация

### Authentication
```
POST /api/auth/login
POST /api/auth/register
```
Оба возвращают JWT-токен, который передаётся через Socket.IO при подключении.

### Socket.IO события (водитель/механик слушает)
```
ride:new_request        — входящий заказ такси
ride:accepted           — заказ принят водителем
ride:started            — водитель начал поездку
ride:finished           — поездка завершена
ride:cancelled          — поездка отменена

assistance:new_request  — входящая заявка на помощь
assistance:accepted     — заявка принята механиком
assistance:finished     — механик завершил работу
assistance:cancelled    — заявка отменена

chat:message            — новое сообщение в чате
chat:history            — история чата для ride/assist_id
```

### REST endpoints (водитель/механик)
```
GET /api/driver/stats/today  — заработок за день, количество поездок
GET /api/driver/history      — последние 30 поездок/заявок
```

### Geocoding (для пассажира)
```
GET /api/geocode?q=...       — поиск адреса (Nominatim через прокси)
GET /api/geocode/reverse?lat=...&lon=...  — обратное геокодирование
```

## Архитектура

### Модель безопасности
- Пароли хешируются bcrypt (12 раундов)
- JWT-токены для сессий (30 дней)
- Токены передаются через Socket.IO `auth` при подключении
- Все socket-события проверяют роль пользователя и принадлежность к комнате

### Масштабирование
- **Redis GEO** для поиска ближайших водителей O(log N) вместо перебора
- **Socket.IO rooms** — каждая поездка (ride_{id}) — отдельная комната, чат/события приватны
- **PostgreSQL PostGIS** для хранения геоточек и истории
- Один Node.js процесс, но архитектура готова к балансировщику + Redis adapter

### Комнаты Socket.IO
```
user_{id}         — персональная комната для restore-сессии
ride_{id}         — комната поездки (пассажир + водитель видят друг друга)
assist_{id}       — комната заявки на помощь (пассажир + механик)
```

## Файловая структура

```
yanpro-full/
├── backend/
│   ├── src/
│   │   ├── index.js          — Express + Socket.IO entry
│   │   ├── db.js             — Postgres pool
│   │   ├── redis.js          — Redis client
│   │   ├── auth.js           — JWT, bcrypt helpers
│   │   ├── routes/           — REST endpoints
│   │   ├── sockets/          — Socket.IO handlers
│   │   └── middleware/       — auth middleware
│   ├── db/
│   │   ├── schema.sql        — PostGIS таблицы
│   │   └── seed.js           — создание админа
│   ├── package.json
│   └── .env.example
├── pwa/
│   ├── passenger/
│   │   ├── index.html        — одно-файловое PWA пассажира
│   │   └── manifest.json
│   └── driver/
│       ├── index.html        — одно-файловое PWA водителя/механика
│       └── manifest.json
├── android/
│   ├── app/                  — Android Studio проект
│   └── build.gradle.kts
├── .github/
│   ├── workflows/
│   │   └── deploy.yml        — CI/CD pipeline
│   └── docker/
│       ├── Dockerfile        — образ бэкенда
│       └── docker-compose.yml
├── scripts/
│   ├── install.sh            — установка на новый сервер одной командой
│   ├── backup-db.sh          — ежедневный бэкап БД (cron: 03:00, 7 копий)
│   ├── deploy.sh             — скрипт для инициализации на сервере
│   ├── update-apk.sh         — обновление APK водителя из GitHub Release
│   └── dev.sh                — локальная разработка
└── docs/
    └── API.md                — документация
```

## Переменные окружения

Два файла (не путать):

1. **`.github/docker/.env`** — для Docker Compose (продакшен). Обязательные:
   ```bash
   DB_PASSWORD=...            # пароль PostgreSQL
   REDIS_PASSWORD=...         # пароль Redis
   JWT_SECRET=...             # длинная случайная строка
   CORS_ORIGIN=https://taxi.example.ru
   ```
   `scripts/install.sh` генерирует их автоматически.

2. **`backend/.env`** — для локального запуска без Docker:
   ```bash
   PORT=3002
   DATABASE_URL=postgres://yanpro:password@localhost:5432/yanpro
   REDIS_URL=redis://localhost:6379
   JWT_SECRET=your-long-random-string
   JWT_EXPIRES_IN=30d
   CORS_ORIGIN=https://your-domain.example
   ```

## Проблемы и решения

### Геолокация на старых устройствах
Если `navigator.geolocation` не отвечает, пассажир всегда может коснуться карты или ввести адрес вручную. Нет fallback-магии — только явные действия пользователя.

### Входящий заказ не показывается
Проверьте:
1. Водитель в статусе `online` (переключатель «На линии»)
2. Redis работает (`redis-cli ping`)
3. Socket.IO соединение активно (в консоли браузера нет ошибок)

### Чат не работает
Убедитесь, что оба пользователя в одной комнате (`ride_{id}` или `assist_{id}`). Сервер физически запрещает писать в чужой чат.

## Лицензия

MIT

## Контакт

Для вопросов и предложений — см. GitHub Issues.
