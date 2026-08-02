// REST API: fetch с таймаутом + авторизация через Bearer-токен

export interface ApiContext {
  serverUrl: string;
  token: string | null;
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = 10000
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    if (err.name === 'AbortError') throw new Error('Таймаут запроса');
    throw new Error('Нет связи с сервером');
  }
}

// api(path, method, body) — JSON-запрос к бэкенду с Bearer-токеном.
// ctx берётся по ссылке на момент вызова (это синглтон state приложения).
export function createApi(ctx: ApiContext) {
  return async function api(path: string, method = 'GET', body?: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
    const res = await fetchWithTimeout(ctx.serverUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `http_${res.status}`);
    return data;
  };
}
