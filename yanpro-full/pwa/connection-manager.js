// ════════════════════════════════════════════════════════════════
// ConnectionManager — управление соединением с сервером
// ════════════════════════════════════════════════════════════════

class ConnectionManager {
  constructor(serverUrl, token) {
    this.serverUrl = serverUrl;
    this.token = token;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.retryDelay = 2000; // 2 сек
    this.isOnline = navigator.onLine;
    this.listeners = [];
    this.socket = null;
    
    // Слушаем события online/offline
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
  }

  // Подключиться к серверу с retry
  async connect() {
    try {
      console.log(`🔌 Подключение к ${this.serverUrl}...`);
      
      // Проверяем доступность сервера
      const response = await this.fetchWithTimeout(
        this.serverUrl + '/api/health',
        { method: 'GET' },
        5000 // 5 сек таймаут
      );

      if (!response.ok) throw new Error('Server not responding');

      this.retryCount = 0;
      this.isOnline = true;
      this.notify('connected');
      console.log('✅ Подключено к серверу');
      return true;
    } catch (err) {
      console.error('❌ Ошибка подключения:', err.message);
      return this.retry();
    }
  }

  // Retry с экспоненциальной задержкой
  async retry() {
    if (this.retryCount >= this.maxRetries) {
      this.isOnline = false;
      this.notify('offline');
      console.error('🚨 Не удалось подключиться после ' + this.maxRetries + ' попыток');
      return false;
    }

    this.retryCount++;
    const delay = this.retryDelay * Math.pow(2, this.retryCount - 1); // Экспоненциальная задержка
    console.log(`⏳ Повтор подключения через ${delay}ms (попытка ${this.retryCount}/${this.maxRetries})`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return this.connect();
  }

  // Fetch с таймаутом
  async fetchWithTimeout(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          ...options.headers
        }
      });
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error(`Таймаут запроса (${timeout}ms)`);
      }
      throw err;
    }
  }

  // Обработка потери соединения
  handleOffline() {
    console.warn('📴 Потеряно соединение с интернетом');
    this.isOnline = false;
    this.notify('offline', 'Нет соединения с интернетом');
  }

  // Обработка восстановления соединения
  handleOnline() {
    console.log('📡 Соединение восстановлено');
    this.isOnline = true;
    this.retryCount = 0;
    this.connect();
  }

  // Подписаться на события
  subscribe(listener) {
    this.listeners.push(listener);
  }

  // Оповестить слушателей
  notify(status, message = '') {
    this.listeners.forEach(listener => {
      listener({ status, message, isOnline: this.isOnline });
    });
  }

  // Проверить соединение
  isConnected() {
    return this.isOnline;
  }
}

// Экспортируем
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ConnectionManager;
}
