FROM node:18-alpine

WORKDIR /app

# Копируем backend
COPY backend/package.json .
COPY backend/src ./src
COPY backend/db ./db
COPY backend/.env.example .env
# Общий контракт сокет-протокола (используется бэкендом и фронтендом)
COPY shared/ ./shared

# Копируем PWA клиентов и админку для раздачи
RUN mkdir -p passenger driver admin
COPY pwa/passenger/index.html passenger/
COPY pwa/passenger/manifest.json passenger/
COPY pwa/driver/index.html driver/
COPY pwa/driver/manifest.json driver/
COPY pwa/driver/earnings.html driver/
COPY pwa/connection-manager.js ./
COPY admin/ admin/

# Установка зависимостей
RUN npm install --omit=dev && npm cache clean --force

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 3002

CMD ["npm", "start"]
