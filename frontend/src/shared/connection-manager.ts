// ConnectionManager — управление соединением с сервером (проверка /api/health
// с экспоненциальным retry + обработка online/offline браузера).
// Наследие от старого PWA; используется там, где нужен отдельный мониторинг.

export interface ConnListenerPayload {
  status: 'connected' | 'offline';
  message: string;
  isOnline: boolean;
}

export class ConnectionManager {
  private serverUrl: string;
  private token: string;
  private retryCount = 0;
  private readonly maxRetries = 5;
  private readonly retryDelay = 2000; // 2 сек
  private isOnline: boolean = navigator.onLine;
  private listeners: Array<(p: ConnListenerPayload) => void> = [];

  constructor(serverUrl: string, token: string) {
    this.serverUrl = serverUrl;
    this.token = token;
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
  }

  async connect(): Promise<boolean> {
    try {
      console.log(`Подключение к ${this.serverUrl}...`);
      const response = await this.fetchWithTimeout(
        this.serverUrl + '/api/health',
        { method: 'GET' },
        5000
      );
      if (!response.ok) throw new Error('Server not responding');

      this.retryCount = 0;
      this.isOnline = true;
      this.notify('connected');
      return true;
    } catch (err) {
      console.error('Ошибка подключения:', err.message);
      return this.retry();
    }
  }

  async retry(): Promise<boolean> {
    if (this.retryCount >= this.maxRetries) {
      this.isOnline = false;
      this.notify('offline');
      console.error('Не удалось подключиться после ' + this.maxRetries + ' попыток');
      return false;
    }
    this.retryCount++;
    const delay = this.retryDelay * Math.pow(2, this.retryCount - 1);
    console.log(`Повтор подключения через ${delay}ms (попытка ${this.retryCount}/${this.maxRetries})`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return this.connect();
  }

  async fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 10000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          ...(options.headers as Record<string, string> | undefined),
        },
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

  handleOffline() {
    console.warn('Потеряно соединение с интернетом');
    this.isOnline = false;
    this.notify('offline', 'Нет соединения с интернетом');
  }

  handleOnline() {
    console.log('Соединение восстановлено');
    this.isOnline = true;
    this.retryCount = 0;
    this.connect();
  }

  subscribe(listener: (p: ConnListenerPayload) => void) {
    this.listeners.push(listener);
  }

  private notify(status: 'connected' | 'offline', message = '') {
    this.listeners.forEach((listener) => {
      listener({ status, message, isOnline: this.isOnline });
    });
  }

  isConnected() {
    return this.isOnline;
  }
}
