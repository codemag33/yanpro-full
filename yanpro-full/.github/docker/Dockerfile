FROM node:18-alpine

WORKDIR /app

# Копируем backend
COPY backend/package.json .
COPY backend/src ./src
COPY backend/db ./db
COPY backend/.env.example .env

# Копируем PWA клиентов для раздачи
RUN mkdir -p passenger driver
COPY pwa/passenger/index.html passenger/
COPY pwa/passenger/manifest.json passenger/
COPY pwa/driver/index.html driver/
COPY pwa/driver/manifest.json driver/

# Установка зависимостей
RUN npm install --omit=dev && npm cache clean --force

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 3002

CMD ["npm", "start"]
