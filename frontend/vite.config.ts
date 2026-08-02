import { defineConfig } from 'vite';

// Многостраничное PWA: пассажир, водитель/механик, админка (3 страницы).
// Сборка: npm run build → dist/ (отдаётся бэкендом как статика)
// Пути input — относительно root ('src').
export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // shared/protocol.js — CommonJS (используется и бэкендом) — преобразуем в ESM
    commonjsOptions: { include: [/node_modules/, /shared\//] },
    rollupOptions: {
      input: {
        'passenger/index': '/passenger/index.html',
        'driver/index': '/driver/index.html',
        'driver/earnings': '/driver/earnings.html',
        'admin/index': '/admin/index.html',
        'admin/index_v2': '/admin/index_v2.html',
        'admin/dispatch': '/admin/dispatch.html',
      },
      output: {
        // Крупные вендор-библиотеки — в отдельные чанки (кэширование)
        manualChunks: {
          maplibre: ['maplibre-gl'],
          'socket.io-client': ['socket.io-client'],
          chart: ['chart.js'],
        },
      },
    },
  },
  server: {
    fs: { allow: ['..'] }, // доступ к shared/protocol.js вне корня фронтенда
  },
});
