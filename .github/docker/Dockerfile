# ── Стадия 1: сборка фронтенда (Vite + TypeScript) ───────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /build

# Кэширование зависимостей: package*.json сначала, исходники потом
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund

COPY frontend/src ./frontend/src
COPY frontend/vite.config.ts ./frontend/
COPY frontend/tsconfig.json ./frontend/
# Общий контракт сокет-протокола (импортируется из frontend/src/shared/protocol.ts)
COPY shared/ ./shared

RUN cd frontend && npm run build

# ── Стадия 2: рантайм бэкенда ────────────────────────────────────────────
FROM node:18-alpine

WORKDIR /app

# Копируем backend
COPY backend/package.json .
COPY backend/src ./src
COPY backend/db ./db
COPY backend/.env.example .env
# Общий контракт сокет-протокола (используется бэкендом и фронтендом)
COPY shared/ ./shared

# Установка зависимостей
RUN npm install --omit=dev && npm cache clean --force

# Собранный фронтенд (dist от Vite): /passenger, /driver, /admin, /assets
COPY --from=frontend-build /build/frontend/dist ./web

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 3002

CMD ["npm", "start"]
