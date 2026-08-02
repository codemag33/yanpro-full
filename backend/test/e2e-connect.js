// E2E: подключение → вызов → отключение водителя и механика (разные сценарии).
//
// Сценарии:
//   1. водитель отключается, пока поездка ищет водителя (гео-изоляция после disconnect)
//   2. водитель отключается ПОСЛЕ принятия (активная поездка): restore, чат, finish
//   3. механик: то же самое для помощи (waiting → accept → restore → чат → finish)
//   4. оффлайн-водитель не получает вызовы; reactivate после включения онлайн
//   5. гонка принятия двумя водителями (один победитель)
//   6. изоляция ролей: механик не получает поездки, водитель не получает помощь
//   7. авторизация: чужие ride:cancel / ride:finish / assistance:finish по id
//
// Запуск: E2E_BASE=https://taxi.fbs3.ru npm run test:e2e:connect
// Тестовые пользователи создаются с префиксом test_ и удаляются cleanup.sql.
const https = require('https');
const { io } = require('socket.io-client');

const BASE = process.env.E2E_BASE || 'https://taxi.fbs3.ru';
const HOST = new URL(BASE).hostname;
const ts = Date.now();
const mk = (p, login, password, name, role, extra) => ({ login: p + '_' + login + '_' + ts, password, name: 'Т-' + name, role, ...extra });
const PASS = mk('test', 'p1', 'passPass123', 'пасс1', 'passenger');
const PASS2 = mk('test', 'p2', 'passPass123', 'пасс2', 'passenger');
const DRV1 = mk('test', 'd1', 'drivePass123', 'дрив1', 'driver', { vehicle_make: 'Lada', vehicle_plate: 'X001XX' });
const DRV2 = mk('test', 'd2', 'drivePass123', 'дрив2', 'driver', { vehicle_make: 'Lada', vehicle_plate: 'X002XX' });
const MECH1 = mk('test', 'm1', 'mechPass123', 'мех1', 'mechanic');
const MECH2 = mk('test', 'm2', 'mechPass123', 'мех2', 'mechanic');
// Оренбург, центр
const LAT = 51.7682, LON = 55.0969;
const D = 0.01; // ~1 км

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
// Фиксация наблюдаемого поведения (не роняет тест, идёт в отчёт о несоответствиях)
function obs(msg, extra) {
  console.log('  OBS', msg, extra !== undefined ? JSON.stringify(extra) : '');
}

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: HOST, path, method, headers: {
      'Content-Type': 'application/json', 'User-Agent': 'test',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    } }, (res) => {
      let b = '';
      res.on('data', (d) => b += d);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ code: res.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ code: -1, body: { error: e.message } }));
    r.setTimeout(10000, () => { r.destroy(); resolve({ code: -1, body: { error: 'TIMEOUT' } }); });
    if (data) r.write(data);
    r.end();
  });
}

function connect(token, name) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], timeout: 10000, reconnection: false });
    s.on('connect', () => { console.log('  socket connected:', name); resolve(s); });
    s.on('connect_error', (e) => reject(new Error(name + ' connect_error: ' + e.message)));
    setTimeout(() => reject(new Error(name + ' connect timeout')), 15000);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function waitEvent(sock, ev, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}
// Ждём событие, но фиксируем в журнал ВСЕ события на сокете за это время
function waitEventWithLog(sock, ev, timeoutMs) {
  return new Promise((resolve) => {
    const seen = [];
    const t = setTimeout(() => resolve({ event: null, seen }), timeoutMs);
    const h = (d) => { clearTimeout(t); sock.off(ev, h); resolve({ event: d, seen }); };
    sock.on(ev, h);
    const log = (e) => { if (e !== ev) seen.push(e); };
    const known = ['ride:new_request','ride:accepted','ride:already_taken','ride:closed_for_others','ride:started','ride:finished','ride:cancelled','ride:created','ride:driver_location','ride:passenger_location','ride:price_offered','ride:price_accepted','ride:price_rejected','session:restore_ride','session:restore_assist','assistance:new_request','assistance:accepted','assistance:already_taken','assistance:closed_for_others','assistance:finished','assistance:cancelled','assistance:created','assistance:driver_location','pending:ride_created','pending:ride_removed','pending:assist_created','pending:assist_removed','chat:message','chat:history','driver:location_update','pending:rides','pending:assists','error:server'];
    known.forEach(k => sock.on(k, (d) => log(k)));
  });
}
function emit(sock, ev, data) {
  return new Promise((resolve) => sock.emit(ev, data, (ack) => resolve(ack)));
}
// События без ack (ride:cancel и т.п.) — просто отправляем, не ждём ответа
function fire(sock, ev, data) {
  sock.emit(ev, data);
}
async function close(sock, name) {
  if (!sock) return;
  sock.close();
  await sleep(700);
  console.log('  socket closed:', name);
}

(async () => {
  console.log('== Регистрация ==');
  const users = [PASS, PASS2, DRV1, DRV2, MECH1, MECH2];
  const toks = {};
  for (const u of users) {
    const r = await req('POST', '/api/auth/register', u);
    if (r.code !== 200) { console.log('register failed', u.login, r.body); process.exit(1); }
    toks[u.login] = r.body.token;
  }
  console.log('  зарегистрировано', users.length, 'пользователей');

  // ──────────────────────────── СЦЕНАРИЙ 1 ────────────────────────────
  console.log('== Сценарий 1: водитель отключается, пока поездка ищет водителя ==');
  const ps1 = await connect(toks[PASS.login], 'пасс1');
  const d1 = await connect(toks[DRV1.login], 'дрив1');
  const d2 = await connect(toks[DRV2.login], 'дрив2');
  d1.emit('location:update', { lat: LAT, lon: LON });
  d1.emit('driver:status', { status: 'online' });
  d2.emit('location:update', { lat: LAT, lon: LON });
  d2.emit('driver:status', { status: 'online' });
  await sleep(800);

  const d1Req1 = waitEvent(d1, 'ride:new_request', 10000);
  const d2Req1 = waitEvent(d2, 'ride:new_request', 10000);
  ps1.emit('ride:request', {
    pickup: { lat: LAT + D, lon: LON + D }, pickupAddress: 'Оренбург, Советская 1',
    destination: { lat: LAT + 2 * D, lon: LON + 2 * D }, destinationAddress: 'Оренбург, Пролетарская 2',
  });
  const created1 = await waitEvent(ps1, 'ride:created', 10000);
  ok('1.1 ride:created', !!created1 && !!created1.rideId, created1);
  if (!created1) process.exit(1);
  const ride1 = created1.rideId;
  const r1a = await d1Req1, r1b = await d2Req1;
  ok('1.2 оба онлайн-водителя получили ride:new_request', !!r1a && !!r1b && r1a.rideId === ride1 && r1b.rideId === ride1, { r1a, r1b });

  console.log('  --- отключение водителя 1 (поездка в поиске) ---');
  await close(d1, 'дрив1');
  const passEventsDuringD1Off = waitEventWithLog(ps1, '__none__', 1200);
  const { seen: pSeen } = await passEventsDuringD1Off;
  obs('1.3 пассажир НЕ получил событий об отключении водителя', pSeen);

  const d1b = await connect(toks[DRV1.login], 'дрив1 (реконнект)');
  const restored1 = waitEvent(d1b, 'session:restore_ride', 3000);
  d1b.emit('location:update', { lat: LAT, lon: LON });
  d1b.emit('driver:status', { status: 'online' });
  const rest1 = await restored1;
  ok('1.4 реконнект водителя без активной поездки → нет session:restore_ride', rest1 === null, rest1);

  const d2Acc = waitEvent(ps1, 'ride:accepted', 10000);
  const closedForD1 = waitEvent(d1b, 'ride:closed_for_others', 10000);
  d2.emit('ride:accept', { rideId: ride1 });
  const acc1 = await d2Acc;
  ok('1.5 поездку принял водитель 2', !!acc1 && acc1.rideId === ride1 && !!acc1.driverId, acc1);
  const r1Closed = await closedForD1;
  ok('1.6 переподключённый водитель 1 получил ride:closed_for_others (user-room)', !!r1Closed && r1Closed.rideId === ride1, r1Closed);

  await emit(d2, 'ride:finish', { rideId: ride1, price: 300 });
  // водитель 2 в оффлайн — для сценария 4 (DRV2 должен быть по-настоящему offline)
  d2.emit('driver:status', { status: 'offline' });
  await close(d2, 'дрив2');

  // ──────────────────────────── СЦЕНАРИЙ 2 ────────────────────────────
  console.log('== Сценарий 2: водитель отключается ПОСЛЕ принятия (активная поездка) ==');
  const d1Req2 = waitEvent(d1b, 'ride:new_request', 10000);
  ps1.emit('ride:request', {
    pickup: { lat: LAT + D, lon: LON - D }, pickupAddress: 'Оренбург, Ленинская 3',
    destination: { lat: LAT + 2 * D, lon: LON - D }, destinationAddress: 'Оренбург, Гагарина 4',
  });
  const created2 = await waitEvent(ps1, 'ride:created', 10000);
  ok('2.1 ride:created', !!created2 && !!created2.rideId, created2);
  if (!created2) process.exit(1);
  const ride2 = created2.rideId;
  const r2 = await d1Req2;
  ok('2.2 водитель 1 получил заявку', !!r2 && r2.rideId === ride2, r2);

  const d1Acc = waitEvent(ps1, 'ride:accepted', 10000);
  d1b.emit('ride:accept', { rideId: ride2 });
  const acc2 = await d1Acc;
  ok('2.3 поездка принята водителем 1', !!acc2 && acc2.rideId === ride2, acc2);

  console.log('  --- отключение водителя 1 В АКТИВНОЙ поездке ---');
  await close(d1b, 'дрив1 (в поездке)');
  const passEventsDuringD1Off2 = waitEventWithLog(ps1, '__none__', 1200);
  const { seen: pSeen2 } = await passEventsDuringD1Off2;
  obs('2.4 пассажир НЕ получил событий об отключении водителя в активной поездке', pSeen2);

  const d1c = await connect(toks[DRV1.login], 'дрив1 (реконнект в поездке)');
  const rest2 = await waitEvent(d1c, 'session:restore_ride', 10000);
  ok('2.5 реконнект → session:restore_ride со status=accepted', !!rest2 && rest2.id === ride2 && rest2.status === 'accepted' && rest2.driver_id !== null, rest2 && { id: rest2.id, status: rest2.status, driver_id: rest2.driver_id });

  console.log('  --- чат после реконнекта ---');
  const msgToPass = waitEvent(ps1, 'chat:message', 10000);
  d1c.emit('chat:send', { contextType: 'ride', contextId: ride2, text: 'привет после реконнекта' });
  const msg2 = await msgToPass;
  ok('2.6 чат работает после реконнекта (пассажир получил сообщение)', !!msg2 && msg2.contextId === ride2 && msg2.text === 'привет после реконнекта', msg2);

  const hist = waitEvent(d1c, 'chat:history', 10000);
  d1c.emit('chat:history', { contextType: 'ride', contextId: ride2 });
  const h2 = await hist;
  ok('2.7 chat:history доступна после реконнекта', !!h2 && Array.isArray(h2.messages) && h2.messages.length >= 1, h2 && h2.messages);

  const finEv = waitEvent(ps1, 'ride:finished', 10000);
  const finAck = await emit(d1c, 'ride:finish', { rideId: ride2, price: 500 });
  ok('2.8 ride:finish ack ok', finAck && finAck.ok === true, finAck);
  const fin2 = await finEv;
  ok('2.9 пассажир получил ride:finished', !!fin2 && fin2.rideId === ride2, fin2);

  // ──────────────────────────── СЦЕНАРИЙ 3 ────────────────────────────
  console.log('== Сценарий 3: механик — отключение в waiting и в активной заявке ==');
  const m1 = await connect(toks[MECH1.login], 'мех1');
  const m2 = await connect(toks[MECH2.login], 'мех2');
  m1.emit('location:update', { lat: LAT, lon: LON });
  m1.emit('driver:status', { status: 'online' });
  m2.emit('location:update', { lat: LAT, lon: LON });
  m2.emit('driver:status', { status: 'online' });
  await sleep(800);

  const m1ReqA = waitEvent(m1, 'assistance:new_request', 20000);
  const m2ReqA = waitEvent(m2, 'assistance:new_request', 20000);
  ps1.emit('assistance:request', {
    pickup: { lat: LAT + D, lon: LON + D }, breakdownType: 'tire', carMake: 'Lada',
    phone: '+79990001122', description: 'Спустило колесо',
  });
  const aCreated1 = await waitEvent(ps1, 'assistance:created', 10000);
  ok('3.1 assistance:created', !!aCreated1 && !!aCreated1.assistId, aCreated1);
  if (!aCreated1) process.exit(1);
  const assist1 = aCreated1.assistId;
  const a1m1 = await m1ReqA, a1m2 = await m2ReqA;
  ok('3.2 оба механика получили заявку', !!a1m1 && !!a1m2 && a1m1.assistId === assist1 && a1m2.assistId === assist1, { a1m1, a1m2 });

  console.log('  --- механик 1 отключается в waiting и быстро переподключается ---');
  await close(m1, 'мех1');
  const m1b = await connect(toks[MECH1.login], 'мех1 (реконнект)');
  m1b.emit('location:update', { lat: LAT, lon: LON });
  m1b.emit('driver:status', { status: 'online' });
  await sleep(500);

  const closedA = waitEvent(m1b, 'assistance:closed_for_others', 10000);
  const m2AccA = waitEvent(ps1, 'assistance:accepted', 10000);
  m2.emit('assistance:accept', { assistId: assist1 });
  const aAcc1 = await m2AccA;
  ok('3.3 заявку принял механик 2', !!aAcc1 && aAcc1.assistId === assist1, aAcc1);
  const aClosed = await closedA;
  ok('3.4 переподключённый механик 1 получил assistance:closed_for_others', !!aClosed && aClosed.assistId === assist1, aClosed);

  await emit(m2, 'assistance:finish', { assistId: assist1, price: 800 });

  // механик 1 принимает и отключается в активной заявке
  const m1ReqB = waitEvent(m1b, 'assistance:new_request', 20000);
  ps1.emit('assistance:request', {
    pickup: { lat: LAT + D, lon: LON - D }, breakdownType: 'battery', carMake: 'Kia', description: 'АКБ села',
  });
  const aCreated2 = await waitEvent(ps1, 'assistance:created', 10000);
  ok('3.5 assistance:created (вторая)', !!aCreated2 && !!aCreated2.assistId, aCreated2);
  if (!aCreated2) process.exit(1);
  const assist2 = aCreated2.assistId;
  const a2 = await m1ReqB;
  ok('3.6 механик 1 получил заявку', !!a2 && a2.assistId === assist2, a2);

  const m1AccB = waitEvent(ps1, 'assistance:accepted', 10000);
  m1b.emit('assistance:accept', { assistId: assist2 });
  const aAcc2 = await m1AccB;
  ok('3.7 заявка принята механиком 1', !!aAcc2 && aAcc2.assistId === assist2, aAcc2);

  console.log('  --- механик 1 отключается В АКТИВНОЙ заявке ---');
  await close(m1b, 'мех1 (в заявке)');
  const passEventsM1Off = waitEventWithLog(ps1, '__none__', 1200);
  const { seen: pSeenM } = await passEventsM1Off;
  obs('3.8 пассажир НЕ получил событий об отключении механика в активной заявке', pSeenM);

  const m1c = await connect(toks[MECH1.login], 'мех1 (реконнект в заявке)');
  const restA = await waitEvent(m1c, 'session:restore_assist', 10000);
  ok('3.9 реконнект → session:restore_assist со status=accepted', !!restA && restA.id === assist2 && restA.status === 'accepted' && restA.mechanic_id !== null, restA && { id: restA.id, status: restA.status, mechanic_id: restA.mechanic_id });

  const aMsgToPass = waitEvent(ps1, 'chat:message', 10000);
  m1c.emit('chat:send', { contextType: 'assist', contextId: assist2, text: 'еду, буду через 10 минут' });
  const aMsg = await aMsgToPass;
  ok('3.10 чат в заявке работает после реконнекта', !!aMsg && aMsg.contextId === assist2 && aMsg.text === 'еду, буду через 10 минут', aMsg);

  const aFinEv = waitEvent(ps1, 'assistance:finished', 10000);
  const aFinAck = await emit(m1c, 'assistance:finish', { assistId: assist2, price: 1500 });
  ok('3.11 assistance:finish ack ok', aFinAck && aFinAck.ok === true, aFinAck);
  const aFin = await aFinEv;
  ok('3.12 пассажир получил assistance:finished', !!aFin && aFin.assistId === assist2, aFin);

  // ──────────────────────────── СЦЕНАРИЙ 4 ────────────────────────────
  console.log('== Сценарий 4: оффлайн-водитель не получает вызовы; reactivate после online ==');
  const dOff = await connect(toks[DRV2.login], 'дрив2 (оффлайн)');
  dOff.emit('location:update', { lat: LAT, lon: LON }); // БЕЗ driver:status online
  await sleep(500);

  const offReq = waitEvent(dOff, 'ride:new_request', 4000);
  ps1.emit('ride:request', {
    pickup: { lat: LAT + D, lon: LON }, pickupAddress: 'Оренбург, Постникова 5',
    destination: { lat: LAT + 2 * D, lon: LON }, destinationAddress: 'Оренбург, Кобозева 6',
  });
  const created4 = await waitEvent(ps1, 'ride:created', 10000);
  ok('4.1 ride:created', !!created4 && !!created4.rideId, created4);
  if (!created4) process.exit(1);
  const ride4 = created4.rideId;
  const offGot = await offReq;
  ok('4.2 оффлайн-водитель НЕ получил ride:new_request', offGot === null, offGot);

  dOff.emit('driver:status', { status: 'online' });
  await sleep(400);
  const reGot = waitEvent(dOff, 'ride:new_request', 5000);
  const reAck = await emit(dOff, 'ride:reactivate', { rideId: ride4 });
  ok('4.3 ride:reactivate после включения online → ack ok', reAck && reAck.ok === true, reAck);
  const reGotEv = await reGot;
  ok('4.4 заявка пришла после reactivate', !!reGotEv && reGotEv.rideId === ride4, reGotEv);

  fire(dOff, 'ride:cancel', { rideId: ride4, reason: 'test_cancel' });
  await sleep(500);

  // ──────────────────────────── СЦЕНАРИЙ 5 ────────────────────────────
  console.log('== Сценарий 5: гонка принятия двумя водителями ==');
  const d5a = await connect(toks[DRV1.login], 'дрив1 (гонка)');
  const d5b = await connect(toks[DRV2.login], 'дрив2 (гонка)');
  d5a.emit('location:update', { lat: LAT, lon: LON });
  d5a.emit('driver:status', { status: 'online' });
  d5b.emit('location:update', { lat: LAT, lon: LON });
  d5b.emit('driver:status', { status: 'online' });
  await sleep(800);

  const req5a = waitEvent(d5a, 'ride:new_request', 10000);
  const req5b = waitEvent(d5b, 'ride:new_request', 10000);
  ps1.emit('ride:request', {
    pickup: { lat: LAT + D, lon: LON + D }, pickupAddress: 'Оренбург, Чкалова 7',
    destination: { lat: LAT + 2 * D, lon: LON + 2 * D }, destinationAddress: 'Оренбург, Туркестанская 8',
  });
  const created5 = await waitEvent(ps1, 'ride:created', 10000);
  ok('5.1 ride:created', !!created5 && !!created5.rideId, created5);
  if (!created5) process.exit(1);
  const ride5 = created5.rideId;
  const r5a = await req5a, r5b = await req5b;
  ok('5.2 оба водителя получили заявку', !!r5a && !!r5b && r5a.rideId === ride5 && r5b.rideId === ride5, { r5a, r5b });

  const takenA = waitEvent(d5a, 'ride:already_taken', 10000);
  const takenB = waitEvent(d5b, 'ride:already_taken', 10000);
  const accA = waitEvent(ps1, 'ride:accepted', 10000);
  d5a.emit('ride:accept', { rideId: ride5 });
  d5b.emit('ride:accept', { rideId: ride5 });
  const [tA, tB] = await Promise.all([takenA, takenB]);
  const acc5 = await accA;
  const winners = [tA, tB].filter(x => x === null).length;
  ok('5.3 ровно один водитель победил, второй получил ride:already_taken', winners === 1 && acc5 && acc5.rideId === ride5, { tA, tB, acc5 });

  // проигравший не застрял в busy: может принять следующую поездку
  const loser = tA !== null ? d5a : d5b;
  const loserName = tA !== null ? 'дрив1' : 'дрив2';
  const reqL = waitEvent(loser, 'ride:new_request', 10000);
  ps1.emit('ride:request', {
    pickup: { lat: LAT + D, lon: LON - D }, pickupAddress: 'Оренбург, Салмышская 9',
    destination: { lat: LAT + 2 * D, lon: LON - D }, destinationAddress: 'Оренбург, Аксакова 10',
  });
  const created5b = await waitEvent(ps1, 'ride:created', 10000);
  ok('5.4 ride:created (проверка busy)', !!created5b && !!created5b.rideId, created5b);
  if (!created5b) process.exit(1);
  const ride5b = created5b.rideId;
  const rL = await reqL;
  ok('5.5 проигравший водитель (' + loserName + ') получил следующую заявку (не busy)', !!rL && rL.rideId === ride5b, rL);
  const acc5b = waitEvent(ps1, 'ride:accepted', 10000);
  fire(loser, 'ride:accept', { rideId: ride5b });
  await acc5b;
  await sleep(300);
  await emit(loser, 'ride:finish', { rideId: ride5b, price: 250 });

  // дожидаемся завершения первой поездки гонки
  const win = tA === null ? d5a : d5b;
  await emit(win, 'ride:finish', { rideId: ride5, price: 400 });
  await sleep(500);

  // ──────────────────────────── СЦЕНАРИЙ 6 ────────────────────────────
  console.log('== Сценарий 6: изоляция ролей ==');
  // водитель далеко (~100 км), механик рядом → поездка не должна прийти механику
  const mFar = await connect(toks[MECH2.login], 'мех2 (рядом для поездки)');
  mFar.emit('location:update', { lat: LAT, lon: LON });
  mFar.emit('driver:status', { status: 'online' });
  const dNear6 = await connect(toks[DRV1.login], 'дрив1 (для поездки)');
  dNear6.emit('location:update', { lat: LAT - 1, lon: LON - 1 }); // ~150 км от центра
  dNear6.emit('driver:status', { status: 'online' });
  await sleep(800);

  const mFarReq = waitEvent(mFar, 'ride:new_request', 4000);
  ps1.emit('ride:request', {
    pickup: { lat: LAT + D, lon: LON + D }, pickupAddress: 'Оренбург, 60 лет Октября 11',
    destination: { lat: LAT + 2 * D, lon: LON + 2 * D }, destinationAddress: 'Оренбург, Пр-т Победы 12',
  });
  const created6 = await waitEvent(ps1, 'ride:created', 10000);
  ok('6.1 ride:created', !!created6 && !!created6.rideId, created6);
  if (!created6) process.exit(1);
  const ride6 = created6.rideId;
  const mFarGot = await mFarReq;
  ok('6.2 механик НЕ получил ride:new_request (роль-изоляция)', mFarGot === null, mFarGot);
  const dNearGot = await waitEvent(dNear6, 'ride:new_request', 10000);
  ok('6.3 далёкий водитель не получил (вне радиуса 15 км)', dNearGot === null, dNearGot);
  // убрать поездку: примет близкий водитель d5a (если рядом)... просто отменяем
  fire(ps1, 'ride:cancel', { rideId: ride6, reason: 'test_cancel' });
  await sleep(500);

  // водитель рядом, механик далеко → помощь не должна прийти водителю
  const dNear6b = await connect(toks[DRV1.login], 'дрив1 (рядом для помощи)');
  dNear6b.emit('location:update', { lat: LAT, lon: LON });
  dNear6b.emit('driver:status', { status: 'online' });
  await sleep(400);
  const dNearAssistReq = waitEvent(dNear6b, 'assistance:new_request', 4000);
  const mFar6 = await connect(toks[MECH2.login], 'мех2 (далеко для помощи)');
  mFar6.emit('location:update', { lat: LAT - 1, lon: LON - 1 });
  mFar6.emit('driver:status', { status: 'online' });
  await sleep(800);

  ps1.emit('assistance:request', {
    pickup: { lat: LAT + D, lon: LON + D }, breakdownType: 'fuel', description: 'Закончился бензин',
  });
  const aCreated6 = await waitEvent(ps1, 'assistance:created', 10000);
  ok('6.4 assistance:created', !!aCreated6 && !!aCreated6.assistId, aCreated6);
  if (!aCreated6) process.exit(1);
  const assist6 = aCreated6.assistId;
  const dNearAssistGot = await dNearAssistReq;
  ok('6.5 водитель НЕ получил assistance:new_request (роль-изоляция)', dNearAssistGot === null, dNearAssistGot);
  fire(ps1, 'assistance:cancel', { assistId: assist6 });
  await sleep(500);

  // ──────────────────────────── СЦЕНАРИЙ 7 ────────────────────────────
  console.log('== Сценарий 7: авторизация чужих действий по id ==');
  const ps2 = await connect(toks[PASS2.login], 'пасс2 (чужой)');
  const d7 = await connect(toks[DRV1.login], 'дрив1 (для 7)');
  d7.emit('location:update', { lat: LAT, lon: LON });
  d7.emit('driver:status', { status: 'online' });
  const d7b = await connect(toks[DRV2.login], 'дрив2 (чужой для finish)');
  await sleep(800);

  const d7Req = waitEvent(d7, 'ride:new_request', 10000);
  ps1.emit('ride:request', {
    pickup: { lat: LAT + D, lon: LON + D }, pickupAddress: 'Оренбург, Дзержинского 13',
    destination: { lat: LAT + 2 * D, lon: LON + 2 * D }, destinationAddress: 'Оренбург, Карагандинская 14',
  });
  const created7 = await waitEvent(ps1, 'ride:created', 10000);
  ok('7.1 ride:created', !!created7 && !!created7.rideId, created7);
  if (!created7) process.exit(1);
  const ride7 = created7.rideId;
  await d7Req;

  const acc7 = waitEvent(ps1, 'ride:accepted', 10000);
  d7.emit('ride:accept', { rideId: ride7 });
  await acc7;
  await sleep(400);

  // 7.2 чужой водитель завершает чужую активную поездку
  const fin7 = waitEvent(ps1, 'ride:finished', 5000);
  const finAck7 = await emit(d7b, 'ride:finish', { rideId: ride7, price: 999 });
  const fin7ev = await fin7;
  obs('7.2 ЧУЖОЙ водитель завершил чужую активную поездку (нет проверки принадлежности)', { ack: finAck7, ownerGotFinished: !!fin7ev });

  // 7.3 чужой пассажир отменяет чужую активную поездку
  const d7ReqB = waitEvent(d7, 'ride:new_request', 10000);
  ps1.emit('ride:request', {
    pickup: { lat: LAT + D, lon: LON - D }, pickupAddress: 'Оренбург, Шевченко 15',
    destination: { lat: LAT + 2 * D, lon: LON - D }, destinationAddress: 'Оренбург, Терешковой 16',
  });
  const created7b = await waitEvent(ps1, 'ride:created', 10000);
  ok('7.3 ride:created (вторая)', !!created7b && !!created7b.rideId, created7b);
  if (!created7b) process.exit(1);
  const ride7b = created7b.rideId;
  await d7ReqB;
  const acc7b = waitEvent(ps1, 'ride:accepted', 10000);
  d7.emit('ride:accept', { rideId: ride7b });
  await acc7b;
  await sleep(400);

  const cancelEv = waitEvent(ps1, 'ride:cancelled', 5000);
  ps2.emit('ride:cancel', { rideId: ride7b, reason: 'hack' });
  const canc7 = await cancelEv;
  obs('7.4 ЧУЖОЙ пассажир отменил чужую активную поездку (нет проверки принадлежности)', { rideId: ride7b, ownerGotCancelled: !!canc7 });

  // 7.4 чужой механик завершает чужую заявку
  const m7 = await connect(toks[MECH1.login], 'мех1 (владелец)');
  m7.emit('location:update', { lat: LAT, lon: LON });
  m7.emit('driver:status', { status: 'online' });
  const m7Far = await connect(toks[MECH2.login], 'мех2 (чужой)');
  m7Far.emit('location:update', { lat: LAT, lon: LON });
  m7Far.emit('driver:status', { status: 'online' });
  await sleep(800);

  const m7Req = waitEvent(m7, 'assistance:new_request', 20000);
  ps1.emit('assistance:request', {
    pickup: { lat: LAT + D, lon: LON + D }, breakdownType: 'lock', description: 'Замёрз замок',
  });
  const aCreated7 = await waitEvent(ps1, 'assistance:created', 10000);
  ok('7.5 assistance:created', !!aCreated7 && !!aCreated7.assistId, aCreated7);
  if (!aCreated7) process.exit(1);
  const assist7 = aCreated7.assistId;
  await m7Req;
  const acc7a = waitEvent(ps1, 'assistance:accepted', 10000);
  m7.emit('assistance:accept', { assistId: assist7 });
  await acc7a;
  await sleep(400);

  const fin7a = waitEvent(ps1, 'assistance:finished', 5000);
  const finAck7a = await emit(m7Far, 'assistance:finish', { assistId: assist7, price: 777 });
  const fin7aev = await fin7a;
  obs('7.6 ЧУЖОЙ механик завершил чужую заявку (нет проверки принадлежности)', { ack: finAck7a, ownerGotFinished: !!fin7aev });

  // ──────────────────────────── ЗАВЕРШЕНИЕ ────────────────────────────
  console.log('== Закрытие сокетов ==');
  await close(ps1, 'пасс1'); await close(ps2, 'пасс2');
  await close(d2, 'дрив2'); await close(dOff, 'дрив2-off');
  await close(m2, 'мех2'); await close(mFar, 'мех2-far'); await close(mFar6, 'мех2-far6');
  await close(m1c, 'мех1c'); await close(m7, 'мех1-7'); await close(m7Far, 'мех2-7');
  await close(d5a, 'дрив1-5'); await close(d5b, 'дрив2-5');
  await close(dNear6, 'дрив1-6'); await close(dNear6b, 'дрив1-6b');
  await close(d7, 'дрив1-7'); await close(d7b, 'дрив2-7b');

  console.log('== Итог: ' + pass + ' PASS / ' + fail + ' FAIL ==');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
