// Точка входа PWA водителя: авторизация, socket.io (обработчики событий),
// заработки/история/пропущенные, меню, жизненный цикл страницы.
import { io } from 'socket.io-client';
import { state, type DriverUser } from './core';
import { EVENTS } from '../shared/protocol';
import { createApi } from '../shared/api';
import { initSheetCollapse } from '../shared/sheet-collapse';
import { toast } from './ui';
import { initMap, placeMarker, startLocationWatch, stopLocationWatch } from './map';
import {
  renderPendingMarkers,
  addPendingMarker,
  removePendingMarker,
} from './map';
import { drawRouteOnMap, drawDirectLineOnMap } from './map';
import {
  showIncomingRequest,
  dismissIncomingRequest,
  reactivateRequest,
} from './requests';
import {
  renderActiveRide,
  renderActiveAssist,
  resetRide,
  resetAssist,
  drawRouteToPickup,
  drawRouteToDestination,
  drawRouteToAssist,
  appendChatMessage,
  clearChatSeen,
  cancelCancelGuard,
} from './ui';

const api = createApi(state);

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
document.getElementById('roleDriverOpt').onclick = () => setRegRole('driver');
document.getElementById('roleMechanicOpt').onclick = () => setRegRole('mechanic');
function setRegRole(role: 'driver' | 'mechanic') {
  state.regRole = role;
  document.getElementById('roleDriverOpt').classList.toggle('active', role === 'driver');
  document.getElementById('roleMechanicOpt').classList.toggle('active', role === 'mechanic');
  document.getElementById('vehicleFields').classList.toggle('hidden', false); // и механику нужен авто для выезда
}
document.getElementById('btnServerSettings').onclick = () => {
  const url = prompt('Адрес сервера', state.serverUrl);
  if (url) {
    state.serverUrl = url.trim().replace(/\/$/, '');
    localStorage.setItem('yanpro_driver_server_url', state.serverUrl);
    toast('Сохранено');
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
    onAuthSuccess(await api('/api/auth/login', 'POST', { login, password }));
  } catch {
    authError.textContent = 'Неверный логин или пароль';
  }
};

document.getElementById('btnRegister').onclick = async () => {
  const name = (document.getElementById('regName') as HTMLInputElement).value.trim();
  const login = (document.getElementById('regLogin') as HTMLInputElement).value.trim();
  const phone = (document.getElementById('regPhone') as HTMLInputElement).value.trim();
  const password = (document.getElementById('regPass') as HTMLInputElement).value;
  const vehicle_make = (document.getElementById('regVehicleMake') as HTMLInputElement).value.trim();
  const vehicle_plate = (document.getElementById('regVehiclePlate') as HTMLInputElement).value.trim();
  if (!name || !login || password.length < 6) {
    authError.textContent = 'Проверьте поля (пароль от 6 символов)';
    return;
  }
  try {
    const data = await api('/api/auth/register', 'POST', {
      name,
      login,
      phone,
      password,
      role: state.regRole,
      vehicle_make,
      vehicle_plate,
    });
    onAuthSuccess(data);
  } catch (e: any) {
    authError.textContent = e.message === 'login_taken' ? 'Логин уже занят' : 'Ошибка регистрации';
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
// Enter в полях регистрации = регистрация без нажатия кнопки
for (const id of ['regName', 'regLogin', 'regPhone', 'regPass', 'regVehicleMake', 'regVehiclePlate']) {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (document.getElementById('btnRegister') as HTMLButtonElement).click();
    }
  });
}

function onAuthSuccess(data: any) {
  state.token = data.token;
  state.user = data.user as DriverUser;
  localStorage.setItem('yanpro_driver_token', state.token);
  localStorage.setItem('yanpro_driver_user', JSON.stringify(state.user));
  startApp();
}

/* ════════════════════════ СТАРТ ════════════════════════ */
function startApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('topBar').classList.remove('hidden');
  if (!state.map) initMap();
  connectSocket();
  (document.getElementById('earningsPill').firstChild as Text).textContent = '₽0';
  fetchEarnings();
}
if (state.token && state.user) startApp();

/* ─── Сворачивание нижнего листа свайпом вниз ─────────────────── */
// Потянул лист активного заказа вниз — карта открылась, внизу пилюля.
initSheetCollapse(
  document.getElementById('sheet'),
  document.getElementById('sheetCollapsedBar'),
  () => {
    const r = state.activeRide;
    const a = state.activeAssist;
    if (r) {
      const st = ({ accepted: 'Едем за пассажиром', in_progress: 'В поездке' } as Record<string, string>)[r.status] || r.status;
      return `▲ ${r.name || 'Пассажир'} — ${st}`;
    }
    if (a) return `▲ ${a.name || 'Пассажир'} — Выехали на помощь`;
    return '▲ Развернуть заказ';
  }
);

/* ─── Жизненный цикл страницы ──────────────────────────────── */
state.backgrounded = false;
state.bgRecoveryTimer = false;
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

/* ════════════════════════ ОНЛАЙН/ОФФЛАЙН ════════════════════════ */
document.getElementById('onlineSwitch').onclick = () => {
  state.isOnline = !state.isOnline;
  document.getElementById('switchTrack').classList.toggle('on', state.isOnline);
  document.getElementById('onlineLabel').textContent = state.isOnline ? 'На линии' : 'Оффлайн';
  state.socket?.emit(EVENTS.DRIVER_STATUS, { status: state.isOnline ? 'online' : 'offline' });
  if (state.isOnline) {
    startLocationWatch();
    toast('Вы на линии — принимаем заказы');
  } else {
    stopLocationWatch();
    toast('Вы оффлайн');
  }
};

/* ════════════════════════ ЗАРАБОТОК ════════════════════════ */
async function fetchEarnings() {
  try {
    const data = await api('/api/driver/stats/today');
    state.earnings.total = data.earningsToday;
    state.earnings.rides = data.ridesToday + data.assistsToday;
    renderEarnings();
  } catch {
    /* не критично — просто не обновляем бейдж */
  }
}
function renderEarnings() {
  const pill = document.getElementById('earningsPill');
  pill.innerHTML = `₽${Math.round(state.earnings.total)}<span class="count" id="ridesCount"> · ${state.earnings.rides}</span>`;
}

/* ════════════════════════ ИСТОРИЯ ════════════════════════ */
document.getElementById('btnHistory').onclick = openHistory;
document.getElementById('historyBack').onclick = () => document.getElementById('historyOverlay').classList.add('hidden');
async function openHistory() {
  document.getElementById('historyOverlay').classList.remove('hidden');
  const list = document.getElementById('historyList');
  list.innerHTML = '<div style="color:#777;text-align:center;padding:20px;">Загрузка...</div>';
  try {
    const data = await api('/api/driver/history');
    if (!data.rides.length) {
      list.innerHTML = '<div style="color:#777;text-align:center;padding:20px;">Пока пусто</div>';
      return;
    }
    list.innerHTML = '';
    data.rides.forEach((r: any) => {
      const div = document.createElement('div');
      div.className = 'histItem';
      const date = r.finished_at
        ? new Date(r.finished_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';
      const phoneLine = r.passenger_phone ? ` · 📞 ${r.passenger_phone}` : '';
      const typeLabel = r.type === 'assistance' ? '🔧 Помощь' : '';
      const from = r.pickup_address || '';
      const to = r.destination_address ? ' → ' + r.destination_address : '';
      const namePhone = [r.passenger_name, r.passenger_phone ? '📞 ' + r.passenger_phone : ''].filter(Boolean).join(' · ');
      div.innerHTML = `
        <div class="top"><span>${date} ${typeLabel}</span><span>${r.status === 'cancelled' ? '<span class="status-cancelled">Отменено</span>' : r.price ? '₽' + r.price : ''}</span></div>
        <div class="addr">${from}${to}</div>
        ${namePhone ? '<div style="font-size:12px;color:var(--muted);">' + namePhone + '</div>' : ''}
      `;
      list.appendChild(div);
    });
  } catch {
    list.innerHTML = '<div style="color:#777;text-align:center;padding:20px;">Не удалось загрузить</div>';
  }
}

/* ════════════════════════ ПРОПУЩЕННЫЕ ════════════════════════ */
document.getElementById('btnSkipped').onclick = openSkipped;
document.getElementById('skippedBack').onclick = () => document.getElementById('skippedOverlay').classList.add('hidden');
async function openSkipped() {
  document.getElementById('skippedOverlay').classList.remove('hidden');
  const list = document.getElementById('skippedList');
  list.innerHTML = '<div style="color:#777;text-align:center;padding:20px;">Загрузка...</div>';
  try {
    const data = await api('/api/driver/skipped');
    if (!data.skips.length) {
      list.innerHTML = '<div style="color:#777;text-align:center;padding:20px;">Пропущенных заявок нет</div>';
      return;
    }
    list.innerHTML = '';
    data.skips.forEach((s: any) => {
      const div = document.createElement('div');
      div.className = 'histItem';
      const isOpen = s.status === 'searching' || s.status === 'waiting';
      if (isOpen) div.style.cursor = 'pointer';
      const date = s.skipped_at
        ? new Date(s.skipped_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';
      const typeLabel = s.request_type === 'assist' ? '🔧 Помощь' : '🚕 Заказ';
      const statusLabel =
        { searching: '⏳ Ищет водителя', waiting: '⏳ Ищет мастера', accepted: '✅ Принят', in_progress: '🚗 В пути', completed: '✅ Выполнено', cancelled: '❌ Отменено' }[s.status] || s.status;
      const statusColor = s.status === 'completed' ? 'var(--green)' : s.status === 'cancelled' ? 'var(--danger)' : 'var(--yellow)';
      const from = s.pickup_address || '';
      const to = s.destination_address ? ' → ' + s.destination_address : '';
      const namePhone = [s.passenger_name, s.passenger_phone ? '📞 ' + s.passenger_phone : ''].filter(Boolean).join(' · ');
      div.innerHTML = `
        <div class="top"><span>${date} ${typeLabel}</span><span style="color:${statusColor};font-size:12px;font-weight:600;">${statusLabel}</span></div>
        <div class="addr">${from}${to}</div>
        ${namePhone ? '<div style="font-size:12px;color:var(--muted);">' + namePhone + '</div>' : ''}
        ${isOpen ? '<div style="font-size:12px;color:var(--yellow);font-weight:600;margin-top:4px;">↩ Нажмите, чтобы взять в работу</div>' : ''}
      `;
      if (isOpen) div.onclick = () => reactivateRequest(s.request_type, s.request_id);
      list.appendChild(div);
    });
  } catch {
    list.innerHTML = '<div style="color:#777;text-align:center;padding:20px;">Не удалось загрузить</div>';
  }
}

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
    if (err.message === 'invalid_token' || err.message === 'no_token') logout();
    else updateConn('connecting');
  });
  state.socket.on(EVENTS.CONNECT, () => {
    if (!state.backgrounded) toast('Подключено к серверу');
    updateConn('online');
    // Синхронизируем реальное состояние переключателя с сервером.
    // Без этого после перезагрузки страницы сервер хранил устаревший статус
    // online от прошлой сессии, а водитель не получал заказы.
    state.socket?.emit(EVENTS.DRIVER_STATUS, { status: state.isOnline ? 'online' : 'offline' });
    state.socket?.emit(EVENTS.PENDING_LIST);
  });
  state.socket.on(EVENTS.DISCONNECT, () => {
    if (!state.backgrounded) updateConn('offline');
  });

  state.socket.on(EVENTS.SESSION_RESTORE_RIDE, (ride: any) => {
    state.activeRide = {
      id: ride.id,
      status: ride.status,
      name: ride.passenger_name || 'Пассажир',
      pickup: { lat: ride.pickup_lat, lon: ride.pickup_lon, address: ride.pickup_address },
      destination: { lat: ride.destination_lat, lon: ride.destination_lon, address: ride.destination_address },
      routeToPickup: null,
      routeToDest: null,
    };
    state.chatContext = { contextType: 'ride', contextId: ride.id };
    placeMarker('passenger', ride.pickup_lat, ride.pickup_lon, '🧍');
    renderActiveRide();
    if (ride.status === 'accepted') drawRouteToPickup();
    else if (ride.status === 'in_progress') drawRouteToDestination();
  });
  state.socket.on(EVENTS.SESSION_RESTORE_ASSIST, (a: any) => {
    state.activeAssist = {
      id: a.id,
      status: a.status,
      carMake: a.car_make,
      breakdownType: a.breakdown_type,
      name: a.passenger_name,
      phone: a.phone,
      description: a.description,
      pickup: { lat: a.pickup_lat, lon: a.pickup_lon },
      pickupAddress: a.pickup_address,
      routeToPickup: null,
    };
    state.chatContext = { contextType: 'assist', contextId: a.id };
    if (typeof a.pickup_lat === 'number' && typeof a.pickup_lon === 'number') {
      placeMarker('passenger', a.pickup_lat, a.pickup_lon, '🧍');
    }
    renderActiveAssist();
    if (a.status === 'accepted') drawRouteToAssist();
  });

  // ─── Входящие заказы ────────────────────────────────────────────────
  state.socket.on(EVENTS.RIDE_NEW_REQUEST, (data: any) => {
    if (state.activeRide || state.activeAssist) return;
    if (state.directTake && state.directTake.id === data.rideId) return; // уже берём правой кнопкой
    if (state.pendingRequest) {
      state.requestQueue.push({ kind: 'ride', ...data });
      return;
    }
    showIncomingRequest('ride', data);
    // Рисуем маршрут если есть
    if (data.route && data.route.geometry) {
      drawRouteOnMap(data.route.geometry);
    } else if (data.pickup && data.destination) {
      drawDirectLineOnMap(data.pickup.lat, data.pickup.lon, data.destination.lat, data.destination.lon);
    }
  });
  state.socket.on(EVENTS.RIDE_ALREADY_TAKEN, (data: any) => {
    const had = state.pendingRequest?.rideId === data.rideId || state.requestQueue.some((q) => q.kind === 'ride' && q.rideId === data.rideId);
    if (state.pendingRequest?.rideId === data.rideId) dismissIncomingRequest(false);
    state.requestQueue = state.requestQueue.filter((q) => q.kind !== 'ride' || q.rideId !== data.rideId);
    if (had) toast('Заказ уже занят другим водителем');
  });
  state.socket.on(EVENTS.RIDE_CLOSED_FOR_OTHERS, (data: any) => {
    const had = state.pendingRequest?.rideId === data.rideId || state.requestQueue.some((q) => q.kind === 'ride' && q.rideId === data.rideId);
    if (state.pendingRequest?.rideId === data.rideId) dismissIncomingRequest(false);
    state.requestQueue = state.requestQueue.filter((q) => q.kind !== 'ride' || q.rideId !== data.rideId);
    if (had) toast('Заказ закрыт другим водителем');
  });
  state.socket.on(EVENTS.RIDE_ACCEPTED, (data: any) => {
    // Наш собственный accept подтверждён сервером
    if (state.activeRide) {
      state.activeRide.status = 'accepted';
      renderActiveRide();
    }
  });
  state.socket.on(EVENTS.RIDE_STARTED, () => {
    if (state.activeRide) {
      state.activeRide.status = 'in_progress';
      renderActiveRide();
      drawRouteToDestination();
    }
  });
  state.socket.on(EVENTS.RIDE_FINISHED, () => {
    toast('Поездка завершена');
    fetchEarnings();
    resetRide();
  });
  state.socket.on(EVENTS.RIDE_CANCELLED, (data: any) => {
    if (state.cancellingRide) {
      // эхо нашей собственной отмены — UI уже сброшен при клике
      cancelCancelGuard();
      return;
    }
    // Отменена именно наша активная поездка (таймаут поиска и т.п. нас не касается)
    if (!state.activeRide || state.activeRide.id !== data.rideId) return;
    toast(data.by === 'passenger' ? 'Пассажир отменил поездку' : 'Поездка отменена');
    resetRide();
  });
  state.socket.on(EVENTS.RIDE_PASSENGER_LOCATION, (data: any) => placeMarker('passenger', data.lat, data.lon, '🧍'));

  // ─── Входящие заявки на помощь ──────────────────────────────────────
  state.socket.on(EVENTS.ASSIST_NEW_REQUEST, (data: any) => {
    if (state.activeRide || state.activeAssist) return;
    if (state.directTake && state.directTake.id === data.assistId) return; // уже берём правой кнопкой
    if (state.pendingRequest) {
      state.requestQueue.push({ kind: 'assist', ...data });
      return;
    }
    showIncomingRequest('assist', data);
  });
  state.socket.on(EVENTS.ASSIST_ALREADY_TAKEN, (data: any) => {
    const had = state.pendingRequest?.assistId === data.assistId || state.requestQueue.some((q) => q.kind === 'assist' && q.assistId === data.assistId);
    if (state.pendingRequest?.assistId === data.assistId) dismissIncomingRequest(false);
    state.requestQueue = state.requestQueue.filter((q) => q.kind !== 'assist' || q.assistId !== data.assistId);
    if (had) toast('Заявку уже принял другой мастер');
  });
  state.socket.on(EVENTS.ASSIST_CLOSED_FOR_OTHERS, (data: any) => {
    const had = state.pendingRequest?.assistId === data.assistId || state.requestQueue.some((q) => q.kind === 'assist' && q.assistId === data.assistId);
    if (state.pendingRequest?.assistId === data.assistId) dismissIncomingRequest(false);
    state.requestQueue = state.requestQueue.filter((q) => q.kind !== 'assist' || q.assistId !== data.assistId);
    if (had) toast('Заявку закрыл другой мастер');
  });
  state.socket.on(EVENTS.ASSIST_ACCEPTED, () => {
    if (state.activeAssist) {
      state.activeAssist.status = 'accepted';
      renderActiveAssist();
    }
  });
  state.socket.on(EVENTS.ASSIST_FINISHED, () => {
    toast('Заявка завершена');
    fetchEarnings();
    resetAssist();
  });
  state.socket.on(EVENTS.ASSIST_CANCELLED, (data: any) => {
    if (state.cancellingAssist) {
      cancelCancelGuard();
      return;
    }
    if (!state.activeAssist || state.activeAssist.id !== data.assistId) return;
    toast(data.by === 'passenger' ? 'Пассажир отменил заявку' : 'Заявка отменена');
    resetAssist();
  });
  state.socket.on(EVENTS.ASSIST_PASSENGER_LOCATION, (data: any) => placeMarker('passenger', data.lat, data.lon, '🧍'));

  // ─── Чат ─────────────────────────────────────────────────────────────
  state.socket.on(EVENTS.CHAT_MESSAGE, (m: any) => appendChatMessage(m));
  state.socket.on(EVENTS.CHAT_HISTORY, (data: any) => {
    document.getElementById('chatMessages').innerHTML = '';
    clearChatSeen();
    data.messages.forEach(appendChatMessage);
  });

  // ─── Pending-заказы на карте ──────────────────────────────────────────
  state.socket.on(EVENTS.PENDING_RIDES, (rides: any) => renderPendingMarkers('ride', rides));
  state.socket.on(EVENTS.PENDING_ASSISTS, (assists: any) => renderPendingMarkers('assist', assists));
  state.socket.on(EVENTS.PENDING_RIDE_CREATED, (data: any) => addPendingMarker('ride', data));
  state.socket.on(EVENTS.PENDING_ASSIST_CREATED, (data: any) => addPendingMarker('assist', data));
  state.socket.on(EVENTS.PENDING_RIDE_REMOVED, (data: any) => removePendingMarker('ride', data.rideId));
  state.socket.on(EVENTS.PENDING_ASSIST_REMOVED, (data: any) => removePendingMarker('assist', data.assistId));
}

/* ════════════════════════ МЕНЮ / ВЫХОД ════════════════════════ */
function logout() {
  if (state.socket && state.socket.connected) {
    state.socket.emit(EVENTS.DRIVER_STATUS, { status: 'offline' });
    state.socket.disconnect();
  }
  localStorage.removeItem('yanpro_driver_token');
  localStorage.removeItem('yanpro_driver_user');
  location.reload();
}
document.getElementById('btnMenu').onclick = () => {
  document.getElementById('menuOverlay').classList.remove('hidden');
  document.getElementById('menuCard').classList.remove('hidden');
};
document.getElementById('menuClose').onclick = () => {
  document.getElementById('menuOverlay').classList.add('hidden');
  document.getElementById('menuCard').classList.add('hidden');
};
document.getElementById('menuLogout').onclick = () => {
  document.getElementById('menuOverlay').classList.add('hidden');
  document.getElementById('menuCard').classList.add('hidden');
  if (confirm('Выйти из аккаунта?')) logout();
};
