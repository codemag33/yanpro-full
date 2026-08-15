// UI-слой PWA водителя: тосты, нижний лист активного заказа, чат, модалка цены.
import { state, formatDistance, formatDuration } from './core';
import { EVENTS } from '../shared/protocol';
import { fetchRoute, drawRouteOnMap, removeRouteLine, getSelfPos } from './map';

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ─── Нижний лист активного заказа ──────────────────────────────────────── */
const sheet = document.getElementById('sheet');

export async function drawRouteToPickup() {
  const r = state.activeRide;
  if (!r) return;
  const selfPos = getSelfPos();
  if (!selfPos) return;
  const route = await fetchRoute(selfPos.lat, selfPos.lng, r.pickup.lat, r.pickup.lon);
  if (!route || !state.activeRide || state.activeRide.id !== r.id) return;
  r.routeToPickup = route;
  drawRouteOnMap(route.geometry);
  renderActiveRide();
}

export async function drawRouteToAssist() {
  const a = state.activeAssist;
  if (!a) return;
  const selfPos = getSelfPos();
  if (!selfPos) return;
  const route = await fetchRoute(selfPos.lat, selfPos.lng, a.pickup.lat, a.pickup.lon);
  if (!route || !state.activeAssist || state.activeAssist.id !== a.id) return;
  a.routeToPickup = route;
  drawRouteOnMap(route.geometry);
  renderActiveAssist();
}

export async function drawRouteToDestination() {
  const r = state.activeRide;
  if (!r || !r.destination) return;
  const selfPos = getSelfPos();
  if (!selfPos) return;
  const route = await fetchRoute(selfPos.lat, selfPos.lng, r.destination.lat, r.destination.lon);
  if (!route || !state.activeRide || state.activeRide.id !== r.id) return;
  r.routeToDest = route;
  drawRouteOnMap(route.geometry);
  renderActiveRide();
}

export function renderActiveRide() {
  const r = state.activeRide;
  if (!r) {
    sheet.classList.add('hidden');
    return;
  }
  sheet.classList.remove('hidden');
  const statusLabel =
    ({ accepted: 'Едем за пассажиром', in_progress: 'В поездке' } as Record<string, string>)[r.status] || r.status;
  const primaryBtn =
    r.status === 'accepted'
      ? `<button class="btnYellow" id="btnPrimary">Начать поездку</button>`
      : `<button class="btnYellow" id="btnPrimary">Завершить поездку</button>`;

  let routeInfo = '';
  if (r.status === 'accepted' && r.routeToPickup) {
    routeInfo = `<div class="sheetRoute">🚗 ${formatDistance(r.routeToPickup.distance)} · ${formatDuration(r.routeToPickup.duration)}</div>`;
  } else if (r.status === 'in_progress' && r.routeToDest) {
    routeInfo = `<div class="sheetRoute">🏁 ${formatDistance(r.routeToDest.distance)} · ${formatDuration(r.routeToDest.duration)}</div>`;
  }

  sheet.innerHTML = `
    <div class="dragHandle"></div>
    <div class="passRow">
      <div class="avatar">${(r.name || 'П')[0]}</div>
      <div class="passInfo"><div class="name">${r.name || 'Пассажир'}</div><div class="role">${statusLabel}</div></div>
    </div>
    <div class="sheetAddr">📍 ${r.pickup.address || ''}</div>
    <div class="sheetAddr">🏁 ${r.destination.address || ''}</div>
    ${routeInfo}
    <div class="actionsRow">
      <button class="btnGray" id="btnChat">💬 Чат</button>
      ${primaryBtn}
    </div>
    <div class="actionsRow">
      <button class="btnDanger" id="btnCancel" style="width:100%;">Отменить поездку</button>
    </div>
  `;
  document.getElementById('btnChat').onclick = openChat;
  document.getElementById('btnCancel').onclick = () => {
    // Отмена не fire-and-forget: без соединения предупреждаем, а не «тихо отменяем» локально
    if (!state.socket || !state.socket.connected) {
      toast('Нет соединения — отмена не отправлена');
      return;
    }
    state.cancellingRide = true; // собственное эхо ride:cancelled пропускаем
    state.cancelTimer = setTimeout(() => {
      state.cancellingRide = false;
      state.cancelTimer = null;
    }, 10000);
    state.socket.emit(EVENTS.RIDE_CANCEL, { rideId: r.id, reason: 'driver_cancel' });
    resetRide();
  };
  document.getElementById('btnPrimary').onclick = () => {
    if (r.status === 'accepted') {
      state.socket?.emit(EVENTS.RIDE_START, { rideId: r.id });
      state.activeRide.status = 'in_progress';
      renderActiveRide();
      drawRouteToDestination();
    } else {
      showPriceModal();
    }
  };
}

export function renderActiveAssist() {
  const a = state.activeAssist;
  if (!a) {
    sheet.classList.add('hidden');
    return;
  }
  sheet.classList.remove('hidden');
  const routeInfo = a.routeToPickup
    ? `<div class="sheetRoute">🚗 ${formatDistance(a.routeToPickup.distance)} · ${formatDuration(a.routeToPickup.duration)}</div>`
    : '';
  sheet.innerHTML = `
    <div class="dragHandle"></div>
    <div class="passRow">
      <div class="avatar">${(a.name || 'П')[0]}</div>
      <div class="passInfo"><div class="name">${a.name || 'Пассажир'}</div><div class="role">Выехали на помощь</div></div>
    </div>
    <div class="sheetAddr">🚗 ${a.carMake || ''} ${a.phone ? '· 📞 ' + a.phone : ''}</div>
    ${a.pickupAddress ? `<div class="sheetAddr">📍 ${a.pickupAddress}</div>` : ''}
    ${routeInfo}
    <div class="sheetAddr">${a.description || ''}</div>
    <div class="actionsRow">
      <button class="btnGray" id="btnChat">💬 Чат</button>
      <button class="btnYellow" id="btnPrimary">Завершить</button>
    </div>
    <div class="actionsRow">
      <button class="btnDanger" id="btnCancel" style="width:100%;">Отменить</button>
    </div>
  `;
  document.getElementById('btnChat').onclick = openChat;
  document.getElementById('btnCancel').onclick = () => {
    if (!state.socket || !state.socket.connected) {
      toast('Нет соединения — отмена не отправлена');
      return;
    }
    state.cancellingAssist = true;
    state.cancelTimer = setTimeout(() => {
      state.cancellingAssist = false;
      state.cancelTimer = null;
    }, 10000);
    state.socket.emit(EVENTS.ASSIST_CANCEL, { assistId: a.id });
    resetAssist();
  };
  document.getElementById('btnPrimary').onclick = () => showPriceModal('assist');
}

export function resetRide() {
  state.activeRide = null;
  state.chatContext = null;
  // Убираем только маркер пассажира — свой маркер остаётся на месте
  if (state.markers.passenger) {
    state.markers.passenger.remove();
    state.markers.passenger = null;
  }
  if (state.cancelTimer) {
    clearTimeout(state.cancelTimer);
    state.cancelTimer = null;
  }
  removeRouteLine();
  renderActiveRide();
}

export function resetAssist() {
  state.activeAssist = null;
  state.chatContext = null;
  if (state.markers.passenger) {
    state.markers.passenger.remove();
    state.markers.passenger = null;
  }
  if (state.cancelTimer) {
    clearTimeout(state.cancelTimer);
    state.cancelTimer = null;
  }
  removeRouteLine();
  renderActiveAssist();
}

// Управление флагом «мы сами отменяли»:
// после эха с сервера сбрасываем флаг и таймер, чтобы водитель,
// отменивший поездку сам, не считал эхо «неожиданной отменой» и не сбрасывал UI дважды.
export function cancelCancelGuard() {
  if (state.cancelTimer) {
    clearTimeout(state.cancelTimer);
    state.cancelTimer = null;
  }
  state.cancellingRide = false;
  state.cancellingAssist = false;
}

/* ─── Чат ───────────────────────────────────────────────────────────────── */
// Дедупликация сообщений: live-CHAT_MESSAGE может прийти одновременно
// с историей и без id в протоколе — ключ = время+отправитель+текст.
const chatSeen = new Set<string>();
export function clearChatSeen() {
  chatSeen.clear();
}
export function openChat() {
  document.getElementById('chatOverlay').classList.remove('hidden');
  document.getElementById('chatMessages').innerHTML = '';
  chatSeen.clear();
  document.getElementById('chatPeerName').textContent = state.activeRide?.name || state.activeAssist?.name || 'Пассажир';
  if (state.chatContext) state.socket?.emit(EVENTS.CHAT_HISTORY, state.chatContext);
}

export function sendChat() {
  const input = document.getElementById('chatInput') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !state.chatContext) return;
  state.socket?.emit(EVENTS.CHAT_SEND, { ...state.chatContext, text });
  input.value = '';
}

export function appendChatMessage(m: any) {
  const box = document.getElementById('chatMessages');
  const key = `${m.createdAt ?? ''}|${m.senderId ?? ''}|${m.text ?? ''}`;
  if (chatSeen.has(key)) return;
  chatSeen.add(key);
  const div = document.createElement('div');
  div.className = 'msg ' + (m.senderId === state.user?.id ? 'mine' : 'theirs');
  div.textContent = m.text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

document.getElementById('chatBack').onclick = () => document.getElementById('chatOverlay').classList.add('hidden');
document.getElementById('chatSend').onclick = sendChat;
document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

/* ─── Модалка цены ──────────────────────────────────────────────────────── */
// kind: 'ride' (по маршруту до точки Б) или 'assist' (по маршруту до клиента)
export function showPriceModal(kind: 'ride' | 'assist' = 'ride') {
  const r: any = kind === 'assist' ? state.activeAssist : state.activeRide;
  if (!r) return;
  state.finishKind = kind;
  const overlay = document.getElementById('priceOverlay');
  overlay.classList.remove('hidden');
  document.querySelector('#priceCard h3').textContent = kind === 'assist' ? 'Сумма за помощь' : 'Стоимость поездки';
  const info = document.getElementById('priceRouteInfo');
  const hint = document.getElementById('priceHint');
  const route = kind === 'assist' ? r.routeToPickup : r.routeToDest;
  const input = document.getElementById('priceInput') as HTMLInputElement;
  if (route) {
    info.textContent = `${formatDistance(route.distance)} · ${formatDuration(route.duration)}`;
    const km = route.distance / 1000;
    const suggested = Math.round(50 + km * 20 + (route.duration / 60) * 1.5);
    hint.textContent = `≈ ${suggested} ₽ (базовая тарифация)`;
    input.value = String(suggested);
  } else {
    info.textContent = '';
    hint.textContent = '';
    input.value = '';
  }
  input.focus();
}

document.getElementById('priceConfirm').onclick = () => {
  const price = parseFloat((document.getElementById('priceInput') as HTMLInputElement).value);
  document.getElementById('priceOverlay').classList.add('hidden');
  if (state.finishKind === 'assist') {
    state.socket?.emit(EVENTS.ASSIST_FINISH, { assistId: state.activeAssist?.id, price: price || undefined });
  } else {
    state.socket?.emit(EVENTS.RIDE_FINISH, { rideId: state.activeRide?.id, price: price || undefined });
  }
  state.finishKind = null;
};

document.getElementById('priceCancel').onclick = () => {
  document.getElementById('priceOverlay').classList.add('hidden');
};
