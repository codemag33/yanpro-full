// Точка входа PWA пассажира: авторизация, socket.io, поиск адресов,
// геолокация, заказ/отмена, чат, меню.
import { io } from 'socket.io-client';
import { state } from './core';
import { EVENTS } from '../shared/protocol';
import { api } from './api';
import { toast } from './ui';
import { initMap, placeMarker, setPickup, setDestination, getAndDrawRoute } from './map';
import {
  renderSheetIdle,
  renderSheetSearching,
  renderRideState,
  renderAssistState,
  showPriceOffer,
} from './sheet';

/* ════════════════════════ АВТОРИЗАЦИЯ ════════════════════════ */
const authError = document.getElementById('authError');
document.getElementById('toRegister').onclick = () => {
  document.getElementById('loginForm').classList.add('hidden');
  document.getElementById('registerForm').classList.remove('hidden');
  authError.textContent = '';
};
document.getElementById('toLogin').onclick = () => {
  document.getElementById('registerForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
  authError.textContent = '';
};
document.getElementById('btnServerSettings').onclick = () => {
  const url = prompt('Адрес сервера (например, https://taxi.example.com)', state.serverUrl);
  if (url) {
    state.serverUrl = url.trim().replace(/\/$/, '');
    localStorage.setItem('yanpro_server_url', state.serverUrl);
    toast('Адрес сервера сохранён');
  }
};

document.getElementById('btnLogin').onclick = async () => {
  const login = (document.getElementById('loginLogin') as HTMLInputElement).value.trim();
  const password = (document.getElementById('loginPass') as HTMLInputElement).value;
  if (!login || !password) {
    authError.textContent = 'Заполните все поля';
    return;
  }
  try {
    const data = await api('/api/auth/login', 'POST', { login, password });
    onAuthSuccess(data);
  } catch {
    authError.textContent = 'Неверный логин или пароль';
  }
};

// Enter в полях логина/пароля = вход без нажатия кнопки
for (const id of ['loginLogin', 'loginPass']) {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (document.getElementById('btnLogin') as HTMLButtonElement).click();
    }
  });
}

document.getElementById('btnRegister').onclick = async () => {
  const name = (document.getElementById('regName') as HTMLInputElement).value.trim();
  const login = (document.getElementById('regLogin') as HTMLInputElement).value.trim();
  const phone = (document.getElementById('regPhone') as HTMLInputElement).value.trim();
  const password = (document.getElementById('regPass') as HTMLInputElement).value;
  if (!name || !login || password.length < 6) {
    authError.textContent = 'Проверьте поля (пароль от 6 символов)';
    return;
  }
  try {
    const data = await api('/api/auth/register', 'POST', { name, login, phone, password, role: 'passenger' });
    onAuthSuccess(data);
  } catch (e: any) {
    authError.textContent = e.message === 'login_taken' ? 'Такой логин уже занят' : 'Ошибка регистрации';
  }
};

// Enter в полях регистрации = регистрация без нажатия кнопки
for (const id of ['regName', 'regLogin', 'regPhone', 'regPass']) {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (document.getElementById('btnRegister') as HTMLButtonElement).click();
    }
  });
}

function onAuthSuccess(data: any) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('yanpro_token', state.token);
  localStorage.setItem('yanpro_user', JSON.stringify(state.user));
  startApp();
}

/* ════════════════════════ СТАРТ ПРИЛОЖЕНИЯ ════════════════════════ */
function startApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('topBar').classList.remove('hidden');
  if (!state.map) initMap();
  connectSocket();
  renderSheetIdle();
  locateMe(true);
}
if (state.token && state.user) startApp();

/* ─── Жизненный цикл страницы ──────────────────────────────── */
window.addEventListener('pagehide', () => {
  state.backgrounded = true;
});
window.addEventListener('pageshow', () => {
  state.backgrounded = false;
});
document.addEventListener('visibilitychange', () => {
  state.backgrounded = document.visibilityState === 'hidden';
  if (!state.backgrounded) {
    state.bgRecoveryTimer = true;
    setTimeout(() => {
      state.bgRecoveryTimer = false;
    }, 3000);
  }
});

/* ════════════════════════ ГЕОЛОКАЦИЯ С ГРАДАЦИЕЙ FALLBACK'ОВ ═══════════════
   1) GPS/браузерная геолокация с таймаутом
   2) если недоступна/не отвечает — просто оставляем карту там, где она есть,
      и пользователь ставит точку сам (drag или клик) — это ОСНОВНОЙ способ
      на старых устройствах/планшетах, а не "аварийный".                    */
function getPositionWithTimeout(timeoutMs = 8000) {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no_geolocation_api'));
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve(pos);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}

async function locateMe(silent: boolean) {
  try {
    const pos = await getPositionWithTimeout();
    const { latitude: lat, longitude: lon } = pos.coords;
    state.map?.flyTo({ center: [lon, lat], zoom: 15 });
    if (!state.pickup) setPickup(lat, lon);
    else if (!silent) toast('Местоположение обновлено');
  } catch {
    if (!silent) toast('Не удалось определить местоположение — поставьте точку на карте вручную');
    // Карта остаётся там, где была (или на Оренбурге по умолчанию) — пользователь ставит пин сам.
  }
}
document.getElementById('btnLocate').onclick = () => locateMe(false);

/* ════════════════════════ ПОИСК АДРЕСА (через серверный прокси) ═══════════ */
let searchDebounce: ReturnType<typeof setTimeout>;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = (e.target as HTMLInputElement).value.trim();
  const box = document.getElementById('suggestions');
  if (q.length < 3) {
    box.classList.add('hidden');
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const data = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      box.innerHTML = '';
      if (!data.results.length) {
        box.innerHTML = '<div>Ничего не найдено — можно поставить точку на карте вручную</div>';
      }
      data.results.forEach((r: any) => {
        const div = document.createElement('div');
        div.textContent = r.address;
        div.onclick = () => {
          box.classList.add('hidden');
          (document.getElementById('searchInput') as HTMLInputElement).value = '';
          state.map?.flyTo({ center: [r.lon, r.lat], zoom: 15 });
          if (!state.pickup) {
            setPickup(r.lat, r.lon);
          } else {
            state.destination = { lat: r.lat, lon: r.lon, address: r.address };
            placeMarker('dest', r.lat, r.lon);
            renderSheetIdle();
          }
        };
        box.appendChild(div);
      });
      box.classList.remove('hidden');
    } catch {
      box.classList.add('hidden');
      toast('Поиск адреса недоступен');
    }
  }, 400);
});

/* ════════════════════════ SOCKET.IO ════════════════════════ */
function updateConn(status: 'online' | 'connecting' | 'offline') {
  if (state.backgrounded) return;
  if (state.bgRecoveryTimer && status !== 'online') return;
  const bar = document.getElementById('connBar');
  if (!bar) return;
  bar.className = status === 'online' ? 'hidden' : '';
  bar.style.background = status === 'online' ? '#1B5E20' : status === 'connecting' ? '#E65100' : '#B71C1C';
  bar.style.color = '#fff';
  bar.textContent = { online: '✅ Подключено', connecting: '⏳ Переподключение...', offline: '📴 Нет соединения с сервером' }[status];
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  updateConn('connecting');
  state.socket = io(state.serverUrl, {
    auth: { token: state.token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    reconnectionAttempts: Infinity,
  });

  state.socket.on(EVENTS.CONNECT_ERROR, (err: any) => {
    if (err.message === 'invalid_token' || err.message === 'no_token') {
      logout();
    } else updateConn('connecting');
  });
  state.socket.on(EVENTS.CONNECT, () => {
    if (!state.backgrounded) toast('Подключено к серверу');
    updateConn('online');
  });
  state.socket.on(EVENTS.DISCONNECT, () => {
    if (!state.backgrounded) updateConn('offline');
  });

  state.socket.on(EVENTS.SESSION_RESTORE_RIDE, (ride: any) => {
    state.activeRide = ride;
    renderRideState(ride.status);
    state.chatContext = { contextType: 'ride', contextId: ride.id };
  });
  state.socket.on(EVENTS.SESSION_RESTORE_ASSIST, (a: any) => {
    state.activeAssist = a;
    renderAssistState(a.status);
    state.chatContext = { contextType: 'assist', contextId: a.id };
  });

  state.socket.on(EVENTS.RIDE_CREATED, () => renderSheetSearching('ride'));
  state.socket.on(EVENTS.RIDE_ACCEPTED, (data: any) => {
    state.activeRide = { ...(state.activeRide || {}), id: data.rideId, driver_id: data.driverId, driverName: data.driverName };
    state.chatContext = { contextType: 'ride', contextId: data.rideId };
    toast(`Водитель ${data.driverName} принял заказ`);
    renderRideState('accepted', data.driverName);
  });
  state.socket.on(EVENTS.RIDE_ALREADY_TAKEN, () => toast('Заказ уже занят'));
  state.socket.on(EVENTS.RIDE_DRIVER_LOCATION, (data: any) => {
    placeMarker('driver', data.lat, data.lon);
  });
  state.socket.on(EVENTS.RIDE_STARTED, () => renderRideState('in_progress'));
  state.socket.on(EVENTS.RIDE_PRICE_OFFERED, (data: any) => {
    if (!state.activeRide || state.activeRide.id !== data.rideId) return;
    showPriceOffer(data.price);
    toast(`Водитель предлагает цену ${data.price} ₽`);
  });
  state.socket.on(EVENTS.RIDE_FINISHED, () => {
    toast('Поездка завершена');
    resetRide();
  });
  state.socket.on(EVENTS.RIDE_CANCELLED, (data: any) => {
    toast(data.by === 'driver' ? 'Водитель отменил поездку' : 'Поездка отменена');
    resetRide();
  });

  state.socket.on(EVENTS.ASSIST_CREATED, () => renderSheetSearching('assist'));
  state.socket.on(EVENTS.ASSIST_ACCEPTED, (data: any) => {
    state.activeAssist = { ...(state.activeAssist || {}), id: data.assistId, mechanic_id: data.mechanicId, mechanicName: data.mechanicName };
    state.chatContext = { contextType: 'assist', contextId: data.assistId };
    toast(`Мастер ${data.mechanicName} выехал`);
    renderAssistState('accepted', data.mechanicName);
  });
  state.socket.on(EVENTS.ASSIST_ALREADY_TAKEN, () => toast('Заявку уже принял другой мастер'));
  state.socket.on(EVENTS.ASSIST_DRIVER_LOCATION, (data: any) => placeMarker('driver', data.lat, data.lon));
  state.socket.on(EVENTS.ASSIST_FINISHED, () => {
    toast('Мастер завершил работу');
    resetAssist();
  });
  state.socket.on(EVENTS.ASSIST_CANCELLED, (data: any) => {
    toast(data.by === 'mechanic' ? 'Мастер отменил заявку' : 'Заявка отменена');
    resetAssist();
  });

  state.socket.on(EVENTS.CHAT_MESSAGE, (m: any) => appendChatMessage(m));
  state.socket.on(EVENTS.CHAT_HISTORY, (data: any) => {
    document.getElementById('chatMessages').innerHTML = '';
    data.messages.forEach(appendChatMessage);
  });

  state.socket.on(EVENTS.ERROR_SERVER, (e: any) => console.warn('server error', e));
}

function sendLocationUpdate(lat: number, lon: number) {
  if (!state.socket) return;
  const payload: any = { lat, lon };
  if (state.activeRide) payload.rideId = state.activeRide.id;
  if (state.activeAssist) payload.assistId = state.activeAssist.id;
  state.socket.emit(EVENTS.LOCATION_UPDATE, payload);
}
// Пассажир тоже периодически шлёт своё местоположение — полезно для точного пикапа,
// не мешает водителям (водители видны через отдельный geo-набор на сервере).
if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (pos) => sendLocationUpdate(pos.coords.latitude, pos.coords.longitude),
    () => {},
    { enableHighAccuracy: false, maximumAge: 15000, timeout: 10000 }
  );
}

/* ════════════════════════ ДЕЙСТВИЯ ════════════════════════ */
export async function orderRide() {
  if (!state.pickup || !state.destination) return;

  // Показываем "Ищу маршрут..."
  renderSheetSearching('ride');

  // Получаем маршрут через OSRM
  const route = await getAndDrawRoute(state.pickup.lat, state.pickup.lon, state.destination.lat, state.destination.lon);

  // Отправляем заказ с маршрутом
  state.socket?.emit(EVENTS.RIDE_REQUEST, {
    pickup: { lat: state.pickup.lat, lon: state.pickup.lon },
    pickupAddress: state.pickup.address,
    destination: { lat: state.destination.lat, lon: state.destination.lon },
    destinationAddress: state.destination.address,
    route,
  });
}

export function requestAssistance() {
  if (!state.pickup) return;
  const breakdownType = (document.getElementById('breakdownType') as HTMLSelectElement).value;
  const carMake = (document.getElementById('carMake') as HTMLInputElement).value.trim();
  const phone = (document.getElementById('phoneField') as HTMLInputElement).value.trim();
  const description = (document.getElementById('descField') as HTMLTextAreaElement).value.trim();
  state.socket?.emit(EVENTS.ASSIST_REQUEST, {
    pickup: { lat: state.pickup.lat, lon: state.pickup.lon },
    breakdownType,
    carMake,
    phone,
    description,
  });
  renderSheetSearching('assist');
}

export function cancelRide(reason: string) {
  if (!state.activeRide && !state.socket) return;
  const rideId = state.activeRide?.id;
  if (rideId) state.socket?.emit(EVENTS.RIDE_CANCEL, { rideId, reason });
  resetRide();
}
export function cancelAssistance() {
  const assistId = state.activeAssist?.id;
  if (assistId) state.socket?.emit(EVENTS.ASSIST_CANCEL, { assistId });
  resetAssist();
}

function resetRide() {
  state.activeRide = null;
  state.chatContext = null;
  state.pickup = null;
  state.destination = null;
  Object.values(state.markers).forEach((m) => m && m.remove());
  state.markers = { pickup: null, dest: null, driver: null };
  renderSheetIdle();
}
function resetAssist() {
  state.activeAssist = null;
  state.chatContext = null;
  state.pickup = null;
  Object.values(state.markers).forEach((m) => m && m.remove());
  state.markers = { pickup: null, dest: null, driver: null };
  renderSheetIdle();
}

/* ════════════════════════ ЧАТ (строго внутри комнаты ride/assist на сервере) ══ */
export function openChat() {
  document.getElementById('chatOverlay').classList.remove('hidden');
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('chatPeerName').textContent =
    state.activeRide?.driverName || state.activeAssist?.mechanicName || (state.activeRide ? 'Водитель' : 'Мастер');
  if (state.chatContext) state.socket?.emit(EVENTS.CHAT_HISTORY, state.chatContext);
}
document.getElementById('chatBack').onclick = () => document.getElementById('chatOverlay').classList.add('hidden');
document.getElementById('chatSend').onclick = sendChat;
document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const input = document.getElementById('chatInput') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !state.chatContext) return;
  state.socket?.emit(EVENTS.CHAT_SEND, { ...state.chatContext, text });
  input.value = '';
}
export function appendChatMessage(m: any) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'msg ' + (m.senderId === state.user?.id ? 'mine' : 'theirs');
  div.textContent = m.text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* ════════════════════════ ВЫХОД ════════════════════════ */
function logout() {
  localStorage.removeItem('yanpro_token');
  localStorage.removeItem('yanpro_user');
  location.reload();
}
document.getElementById('btnMenu').onclick = () => {
  const name = state.user?.name || state.user?.login || '';
  document.getElementById('menuUserInfo').textContent = name ? '👤 ' + name : '';
  document.getElementById('menuOverlay').classList.remove('hidden');
  document.getElementById('menuCard').classList.remove('hidden');
};
function closeMenu() {
  document.getElementById('menuOverlay').classList.add('hidden');
  document.getElementById('menuCard').classList.add('hidden');
}
document.getElementById('menuOverlay').onclick = closeMenu;
document.getElementById('menuClose').onclick = closeMenu;
document.getElementById('menuCloseBtn').onclick = closeMenu;
document.getElementById('menuLogout').onclick = () => {
  closeMenu();
  if (confirm('Выйти из аккаунта?')) logout();
};
