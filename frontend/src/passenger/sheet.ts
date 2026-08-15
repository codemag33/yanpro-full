// Нижний лист пассажира: состояния (выбор маршрута / поиск / активная поездка),
// торг ценой.
import { state } from './core';
import { EVENTS } from '../shared/protocol';
import { toast } from './ui';
import {
  orderRide,
  requestAssistance,
  cancelRide,
  cancelAssistance,
  openChat,
} from './index';

const sheet = document.getElementById('sheet');

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderSheetIdle() {
  if (state.activeRide || state.activeAssist) return; // не перерисовываем поверх активного состояния
  if (state.searchRideId || state.searchAssistId) return; // идёт поиск — показываем состояние поиска, не idle
  sheet.classList.remove('hidden');
  const searchInput = document.getElementById('searchInput') as HTMLInputElement;
  searchInput.placeholder = state.mode === 'assist' ? 'Где нужна помощь?' : 'Куда едем?';
  if (state.mode === 'assist' && state.destination) {
    // Точка Б не нужна в режиме помощи — убираем её и маркер
    state.destination = null;
    if (state.markers.dest) {
      state.markers.dest.remove();
      state.markers.dest = null;
    }
  }
  const pickupText = state.pickup?.address || (state.pickup ? 'Определяем адрес...' : 'Точка не выбрана — коснитесь карты');
  const destText = state.destination?.address || (state.destination ? 'Определяем адрес...' : 'Куда едем?');

  if (state.mode === 'ride') {
    sheet.innerHTML = `
      <div class="dragHandle"></div>
      <div class="modeTabs">
        <div class="modeTab active" id="tabRide">🚕 Поездка</div>
        <div class="modeTab" id="tabAssist">🔧 Помощь на дороге</div>
      </div>
      <div class="addrRow"><div class="dot pickup"></div><div class="addrText ${!state.pickup ? 'placeholder' : ''}">${pickupText}</div></div>
      <div class="addrRow"><div class="dot dest"></div><div class="addrText ${!state.destination ? 'placeholder' : ''}">${destText}</div></div>
      <div class="hint">Коснитесь карты, чтобы поставить точку А, затем точку Б. Точку можно перетащить пальцем — это надёжнее автоматической геолокации на старых устройствах.</div>
      <button class="primaryBtn" id="btnOrder" ${!state.pickup || !state.destination ? 'disabled' : ''}>Заказать</button>
    `;
    document.getElementById('btnOrder').onclick = orderRide;
  } else {
    sheet.innerHTML = `
      <div class="dragHandle"></div>
      <div class="modeTabs">
        <div class="modeTab" id="tabRide">🚕 Поездка</div>
        <div class="modeTab active" id="tabAssist">🔧 Помощь на дороге</div>
      </div>
      <div class="addrRow"><div class="dot pickup"></div><div class="addrText ${!state.pickup ? 'placeholder' : ''}">${pickupText}</div></div>
      <select id="breakdownType">
        <option value="battery">Не заводится / аккумулятор</option>
        <option value="tire">Прокол колеса</option>
        <option value="fuel">Закончилось топливо</option>
        <option value="lockout">Заблокирован в машине</option>
        <option value="other">Другое</option>
      </select>
      <input id="carMake" placeholder="Марка автомобиля">
      <input id="phoneField" type="tel" placeholder="Телефон для связи" value="${escapeHtml(state.user?.phone ? String(state.user.phone) : '')}">
      <textarea id="descField" placeholder="Опишите проблему"></textarea>
      <div class="hint">Телефон обязателен — мастер должен суметь с вами связаться.</div>
      <button class="primaryBtn" id="btnAssist" ${!state.pickup ? 'disabled' : ''}>Вызвать мастера</button>
    `;
    document.getElementById('btnAssist').onclick = requestAssistance;
  }
  document.getElementById('tabRide').onclick = () => {
    state.mode = 'ride';
    renderSheetIdle();
  };
  document.getElementById('tabAssist').onclick = () => {
    state.mode = 'assist';
    renderSheetIdle();
  };
}

export function renderSheetSearching(kind: 'ride' | 'assist') {
  sheet.innerHTML = `
    <div class="dragHandle"></div>
    <div class="statusCard">
      <div class="big">${kind === 'ride' ? 'Ищем водителя...' : 'Ищем мастера...'}</div>
      <div class="small">Обычно это занимает меньше минуты</div>
    </div>
    <div class="actionsRow"><button class="btnDanger" style="flex:1" id="btnCancelSearch2">Отменить</button></div>
  `;
  const cancel = () => (kind === 'ride' ? cancelRide('passenger_cancel') : cancelAssistance());
  document.getElementById('btnCancelSearch2').onclick = cancel;
}

export function renderRideAccepted(driverName: string) {
  renderRideState('accepted', driverName);
}
export function renderAssistAccepted(mechanicName: string) {
  renderAssistState('accepted', mechanicName);
}

export function renderRideState(status: string, driverName?: string) {
  const label =
    ({ accepted: 'Водитель едет к вам', in_progress: 'В пути', searching: 'Ищем водителя...' } as Record<string, string>)[status] || status;
  sheet.innerHTML = `
    <div class="dragHandle"></div>
    <div class="statusCard"><div class="big">${label}</div></div>
    <div class="priceOfferBox hidden" id="priceOfferBox">
      <div>Водитель предлагает цену:</div>
      <div class="big priceOfferAmount" id="priceOfferAmount"></div>
      <div class="actionsRow">
        <button class="btnDanger" id="btnRejectPrice">Отклонить</button>
        <button class="btnYellow" id="btnAcceptPrice">Принять</button>
      </div>
    </div>
    <div class="driverRow">
      <div class="avatar">${(driverName || 'В')[0]}</div>
      <div class="driverInfo"><div class="name">${driverName || 'Водитель'}</div><div class="role">Водитель</div></div>
    </div>
    <div class="actionsRow">
      <button class="btnYellow" id="btnOpenChat">💬 Чат</button>
      <button class="btnDanger" id="btnCancelRide">Отменить</button>
    </div>
  `;
  document.getElementById('btnOpenChat').onclick = openChat;
  document.getElementById('btnCancelRide').onclick = () => cancelRide('passenger_cancel');
  document.getElementById('btnAcceptPrice').onclick = acceptPriceOffer;
  document.getElementById('btnRejectPrice').onclick = rejectPriceOffer;
}

// ─── Торг ценой: пассажир видит предложение водителя ────────────────────
function acceptPriceOffer() {
  const rideId = state.activeRide?.id;
  const price = state.activeRide?.priceOffer;
  if (!rideId) return;
  state.socket?.emit(EVENTS.RIDE_PRICE_OFFER_ACCEPT, { rideId });
  hidePriceOffer();
  if (price) toast(`Цена ${price} ₽ принята`);
}
function rejectPriceOffer() {
  const rideId = state.activeRide?.id;
  if (!rideId) return;
  state.socket?.emit(EVENTS.RIDE_PRICE_OFFER_REJECT, { rideId });
  hidePriceOffer();
  toast('Вы отклонили предложенную цену');
}
function showPriceOffer(price: number) {
  const box = document.getElementById('priceOfferBox');
  if (!box) return;
  document.getElementById('priceOfferAmount').textContent = `${price} ₽`;
  box.classList.remove('hidden');
  // Если пассажир не ответит за минуту — предложение снимается автоматически
  if (state.priceOfferTimer) clearTimeout(state.priceOfferTimer);
  state.priceOfferTimer = setTimeout(() => {
    rejectPriceOffer();
    toast('Предложение цены истекло');
  }, 60000);
}
function hidePriceOffer() {
  if (state.priceOfferTimer) {
    clearTimeout(state.priceOfferTimer);
    state.priceOfferTimer = null;
  }
  const box = document.getElementById('priceOfferBox');
  if (box) box.classList.add('hidden');
}

export function renderAssistState(status: string, mechanicName?: string) {
  const label =
    ({ accepted: 'Мастер выехал', in_progress: 'Мастер в пути', waiting: 'Ищем мастера...' } as Record<string, string>)[status] || status;
  sheet.innerHTML = `
    <div class="dragHandle"></div>
    <div class="statusCard"><div class="big">${label}</div></div>
    <div class="driverRow">
      <div class="avatar">${(mechanicName || 'М')[0]}</div>
      <div class="driverInfo"><div class="name">${mechanicName || 'Мастер'}</div><div class="role">Механик</div></div>
    </div>
    <div class="actionsRow">
      <button class="btnYellow" id="btnOpenChat">💬 Чат</button>
      <button class="btnDanger" id="btnCancelAssist">Отменить</button>
    </div>
  `;
  document.getElementById('btnOpenChat').onclick = openChat;
  document.getElementById('btnCancelAssist').onclick = cancelAssistance;
}

export { showPriceOffer };
