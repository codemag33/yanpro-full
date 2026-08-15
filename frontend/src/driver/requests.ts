// Входящие заказы/заявки: карточка с таймером, reactivate (вернуть себе),
// правый клик по маркеру — взять сразу, общий accept.
import { state, type IncomingRequest } from './core';
import { EVENTS } from '../shared/protocol';
import { placeMarker, removeRouteLine } from './map';
import { toast, renderActiveRide, renderActiveAssist, drawRouteToPickup, drawRouteToAssist } from './ui';

export const REQUEST_TTL_MS = 30000;

// Безопасное отображение координат: сервер может прислать джанк/без pickup
function coordLabel(pickup: any): string {
  if (pickup && typeof pickup.lat === 'number' && typeof pickup.lon === 'number') {
    return pickup.lat.toFixed(5) + ', ' + pickup.lon.toFixed(5);
  }
  return '';
}
function addrLabel(address: string | undefined, pickup: any): string {
  return address || coordLabel(pickup) || 'Адрес неизвестен';
}

export function showIncomingRequest(kind: 'ride' | 'assist', data: any) {
  state.pendingRequest = { kind, ...data } as IncomingRequest;
  playBeep();
  const card = document.getElementById('requestCard');
  card.classList.remove('hidden');

  if (kind === 'ride') {
    card.innerHTML = `
      <div id="timerBar"><div id="timerFill"></div></div>
      <div class="reqBadge">НОВЫЙ ЗАКАЗ</div>
      <div class="reqName">${data.passengerName || 'Пассажир'}</div>
      <div class="addrRow"><div class="dot pickup"></div><div class="addrText">${addrLabel(data.pickupAddress, data.pickup)}</div></div>
      <div class="addrRow"><div class="dot dest"></div><div class="addrText">${data.destinationAddress || ''}</div></div>
      <div class="reqActions">
        <button class="btnDecline" id="btnDeclineReq">Пропустить</button>
        <button class="btnAccept" id="btnAcceptReq">Принять</button>
      </div>`;
  } else {
    const typeLabels: Record<string, string> = {
      battery: 'Не заводится / аккумулятор',
      tire: 'Прокол колеса',
      fuel: 'Нет топлива',
      lockout: 'Заблокирован в машине',
      other: 'Другое',
    };
    card.innerHTML = `
      <div id="timerBar"><div id="timerFill"></div></div>
      <div class="reqBadge" style="background:#3DCC6E;">ПОМОЩЬ НА ДОРОГЕ</div>
      <div class="reqName">${data.passengerName || 'Пассажир'}</div>
      <div class="reqMeta">${typeLabels[data.breakdownType] || data.breakdownType || ''}${data.carMake ? ' · ' + data.carMake : ''}</div>
      <div class="addrRow"><div class="dot pickup"></div><div class="addrText">${addrLabel(data.pickupAddress, data.pickup)}</div></div>
      <div class="reqActions">
        <button class="btnDecline" id="btnDeclineReq">Пропустить</button>
        <button class="btnAccept" id="btnAcceptReq">Принять</button>
      </div>`;
  }

  document.getElementById('btnAcceptReq').onclick = acceptIncomingRequest;
  document.getElementById('btnDeclineReq').onclick = () => dismissIncomingRequest(true);

  let remaining = REQUEST_TTL_MS;
  const fill = document.getElementById('timerFill');
  fill.style.transition = `width ${REQUEST_TTL_MS}ms linear`;
  requestAnimationFrame(() => {
    fill.style.width = '0%';
  });
  state.countdownTimer = setTimeout(() => dismissIncomingRequest(true), REQUEST_TTL_MS);
}

// recordSkip=true — пишем в журнал «пропущенных» (ручной пропуск/таймаут).
// false — карточку закрыла система (занял другой, закрылась для других) — журнал не засоряем.
export function dismissIncomingRequest(recordSkip = true) {
  clearTimeout(state.countdownTimer);
  if (state.pendingRequest) {
    const req = state.pendingRequest;
    if (recordSkip) {
      if (req.kind === 'ride') state.socket?.emit(EVENTS.RIDE_SKIP, { rideId: req.rideId });
      else state.socket?.emit(EVENTS.ASSIST_SKIP, { assistId: req.assistId });
    }
  }
  state.pendingRequest = null;
  removeRouteLine(); // убираем линию-превью заявки с карты
  document.getElementById('requestCard').classList.add('hidden');
  // Показать следующий из очереди
  if (state.requestQueue.length > 0 && !state.activeRide && !state.activeAssist) {
    const next = state.requestQueue.shift();
    setTimeout(() => showIncomingRequest(next.kind, next), 300);
  }
}

// Убирает заявку из очереди (занята/закрыта, пока ждала)

function acceptIncomingRequest() {
  const req = state.pendingRequest;
  if (!req) return;
  clearTimeout(state.countdownTimer);
  document.getElementById('requestCard').classList.add('hidden');
  acceptRequestData(req);
  state.pendingRequest = null;
}

function playBeep() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    o.start();
    o.stop(ctx.currentTime + 0.25);
  } catch {
    /* noop */
  }
}

// Клик по кружку на карте или по пропущенной заявке — заявка снова
// приходит лично водителю/механику, если её ещё никто не взял.
export function reactivateRequest(kind: 'ride' | 'assist', id: string) {
  if (!state.socket) return;
  if (state.activeRide || state.activeAssist) {
    toast('Сначала завершите текущую заявку');
    return;
  }
  const ev = kind === 'assist' ? EVENTS.ASSIST_REACTIVATE : EVENTS.RIDE_REACTIVATE;
  const payload = kind === 'assist' ? { assistId: id } : { rideId: id };
  state.socket.emit(ev, payload, (res: any) => {
    if (res && res.ok === false) {
      toast(res.error === 'taken' ? 'Заявку уже взяли' : 'Не удалось активировать заявку');
    } else {
      toast('Заявка снова у вас — примите решение');
    }
  });
}

// Правая кнопка мыши по заявке — сразу принять, без карточки.
// Активируем заявку (если ещё свободна) и принимаем её, как только она придёт.
export function takeRequestDirect(kind: 'ride' | 'assist', id: string) {
  if (!state.socket) return;
  if (state.activeRide || state.activeAssist) {
    toast('Сначала завершите текущую заявку');
    return;
  }
  const ev = kind === 'assist' ? EVENTS.ASSIST_REACTIVATE : EVENTS.RIDE_REACTIVATE;
  const payload = kind === 'assist' ? { assistId: id } : { rideId: id };
  const reqEventName = kind === 'assist' ? EVENTS.ASSIST_NEW_REQUEST : EVENTS.RIDE_NEW_REQUEST;
  state.directTake = { kind, id };

  // Один раз слушаем ответ; onReq/финиш — единственный владелец листенера,
  // чтобы не копить socket.once (старый обработчик мог сработать повторно
  // по той же заявке, если та успела вернуться).
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    state.directTake = null;
    state.socket.off(reqEventName, onReq);
  };
  const onReq = (data: any) => {
    if ((kind === 'assist' ? data.assistId : data.rideId) !== id) return;
    finish();
    acceptRequestData({ kind, ...data });
  };
  state.socket.on(reqEventName, onReq);
  state.socket.emit(ev, payload, (res: any) => {
    if (!res || res.ok === false) {
      if (done) return;
      toast(res?.error === 'taken' ? 'Заявку уже взяли' : 'Не удалось взять заявку');
      finish();
    }
  });
  // Страховка: если сервер вообще не ответил — освобождаем подписку
  setTimeout(finish, 15000);
}

// Принятие заявки (общее для карточки и правой кнопки мыши)
export function acceptRequestData(req: IncomingRequest) {
  // Убираем из очереди только принятую заявку — остальные живые предложения не теряем
  state.requestQueue = state.requestQueue.filter((q) => !(q.rideId && q.rideId === req.rideId) && !(q.assistId && q.assistId === req.assistId));
  if (req.kind === 'ride') {
    state.socket?.emit(EVENTS.RIDE_ACCEPT, { rideId: req.rideId });
    state.activeRide = {
      id: req.rideId,
      status: 'accepted',
      name: req.passengerName,
      pickup: { ...req.pickup, address: req.pickupAddress },
      destination: { ...req.destination, address: req.destinationAddress },
      routeToPickup: null,
      routeToDest: null,
    };
    state.chatContext = { contextType: 'ride', contextId: req.rideId };
    if (req.pickup) {
      placeMarker('passenger', req.pickup.lat, req.pickup.lon, '🧍');
      state.map?.flyTo({ center: [req.pickup.lon, req.pickup.lat], zoom: 15 });
    }
    renderActiveRide();
    drawRouteToPickup();
  } else {
    state.socket?.emit(EVENTS.ASSIST_ACCEPT, { assistId: req.assistId });
    state.activeAssist = {
      id: req.assistId,
      status: 'accepted',
      name: req.passengerName,
      carMake: req.carMake,
      breakdownType: req.breakdownType,
      phone: req.phone,
      description: req.description,
      pickup: req.pickup,
      pickupAddress: req.pickupAddress,
      routeToPickup: null,
    };
    state.chatContext = { contextType: 'assist', contextId: req.assistId };
    if (req.pickup) {
      placeMarker('passenger', req.pickup.lat, req.pickup.lon, '🧍');
      state.map?.flyTo({ center: [req.pickup.lon, req.pickup.lat], zoom: 15 });
    }
    renderActiveAssist();
    drawRouteToAssist();
  }
}
