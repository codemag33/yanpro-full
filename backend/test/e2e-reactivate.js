// E2E: reactivate — клик по пропущенной/кружку на карте.
// 1) помощь: механик получил заявку с адресом (обратный геокодинг), пропустил,
//    потом assist:reactivate → снова получил → принял
// 2) поездка: водитель пропустил, потом ride:reactivate → снова получил → принял
// Запуск: E2E_BASE=https://taxi.fbs3.ru npm run test:e2e:reactivate
// Тестовые пользователи создаются с префиксом test_ и удаляются cleanup.sql.
const https = require('https');
const { io } = require('socket.io-client');

const BASE = process.env.E2E_BASE || 'https://taxi.fbs3.ru';
const HOST = new URL(BASE).hostname;
const ts = Date.now();
const PASS = { login: 'test_p_' + ts, password: 'passPass123', name: 'Тест-пасс', role: 'passenger' };
const DRIVER = { login: 'test_d_' + ts, password: 'drivePass123', name: 'Тест-дрив', role: 'driver', vehicle_make: 'Lada', vehicle_plate: 'X777XX' };
const MECH = { login: 'test_m_' + ts, password: 'mechPass123', name: 'Тест-мех', role: 'mechanic' };
// Оренбург, центр
const LAT = 51.7682, LON = 55.0969;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
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
    const s = io(BASE, { auth: { token }, transports: ['websocket'], timeout: 10000 });
    s.on('connect', () => { console.log('  socket connected:', name); resolve(s); });
    s.on('connect_error', (e) => reject(new Error(name + ' connect_error: ' + e.message)));
    setTimeout(() => reject(new Error(name + ' connect timeout')), 15000);
  });
}

function emit(sock, ev, data) {
  return new Promise((resolve) => sock.emit(ev, data, (ack) => resolve(ack)));
}
function waitEvent(sock, ev, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}

(async () => {
  console.log('== Регистрация ==');
  const rp = await req('POST', '/api/auth/register', PASS);
  const rd = await req('POST', '/api/auth/register', DRIVER);
  const rm = await req('POST', '/api/auth/register', MECH);
  if (rp.code !== 200 || rd.code !== 200 || rm.code !== 200) { console.log('register failed', rp.body, rd.body, rm.body); process.exit(1); }

  console.log('== Подключение сокетов ==');
  const ps = await connect(rp.body.token, 'passenger');
  const ds = await connect(rd.body.token, 'driver');
  const ms = await connect(rm.body.token, 'mechanic');

  console.log('== Водитель и механик онлайн ==');
  ds.emit('location:update', { lat: LAT, lon: LON });
  ds.emit('driver:status', { status: 'online' });
  ms.emit('location:update', { lat: LAT, lon: LON });
  ms.emit('driver:status', { status: 'online' });
  await new Promise(r => setTimeout(r, 800));

  console.log('== Поездка: скип → ride:reactivate → accept ==');
  const rideReqEvent = waitEvent(ds, 'ride:new_request', 15000);
  ps.emit('ride:request', {
    pickup: { lat: LAT + 0.001, lon: LON + 0.001 },
    pickupAddress: 'Оренбург, Советская 1',
    destination: { lat: LAT + 0.02, lon: LON + 0.02 },
    destinationAddress: 'Оренбург, Пролетарская 2',
  });
  const created = await waitEvent(ps, 'ride:created', 10000);
  ok('ride:created', !!created && !!created.rideId, created);
  if (!created) process.exit(1);
  const rideId = created.rideId;
  const rideReq = await rideReqEvent;
  ok('водитель получил ride:new_request', !!rideReq && rideReq.rideId === rideId && rideReq.pickupAddress === 'Оренбург, Советская 1', rideReq);

  ds.emit('ride:skip', { rideId });
  await new Promise(r => setTimeout(r, 500));

  const rideReq2P = waitEvent(ds, 'ride:new_request', 10000);
  const reAck = await emit(ds, 'ride:reactivate', { rideId });
  ok('ride:reactivate ack ok', reAck && reAck.ok === true, reAck);
  const rideReq2 = await rideReq2P;
  ok('повторный ride:new_request пришёл', !!rideReq2 && rideReq2.rideId === rideId, rideReq2);

  const rideAccEvent = waitEvent(ps, 'ride:accepted', 10000);
  ds.emit('ride:accept', { rideId });
  const rideAcc = await rideAccEvent;
  ok('поездка принята после reactivate', !!rideAcc && rideAcc.rideId === rideId, rideAcc);

  console.log('== Reactivate уже занятой поездки → taken ==');
  const takenAck = await emit(ds, 'ride:reactivate', { rideId });
  ok('повторный reactivate → taken', takenAck && takenAck.ok === false && takenAck.error === 'taken', takenAck);

  // завершаем, чтобы не мешать
  await emit(ds, 'ride:finish', { rideId, price: 400 });

  console.log('== Помощь: скип → assist:reactivate → accept (с адресом) ==');
  const assistReqEvent = waitEvent(ms, 'assistance:new_request', 20000);
  ps.emit('assistance:request', {
    pickup: { lat: LAT + 0.001, lon: LON + 0.001 },
    breakdownType: 'tire', carMake: 'Lada', phone: '+79990001122', description: 'Спустило колесо',
  });
  const aCreated = await waitEvent(ps, 'assistance:created', 10000);
  ok('assistance:created', !!aCreated && !!aCreated.assistId, aCreated);
  if (!aCreated) process.exit(1);
  const assistId = aCreated.assistId;
  const aReq = await assistReqEvent;
  ok('механик получил помощь с адресом', !!aReq && aReq.assistId === assistId && !!aReq.pickupAddress, aReq);
  ok('адрес похож на Оренбург', aReq && aReq.pickupAddress && aReq.pickupAddress.includes('Оренбург'), aReq && aReq.pickupAddress);

  ms.emit('assistance:skip', { assistId });
  await new Promise(r => setTimeout(r, 500));

  const aReq2P = waitEvent(ms, 'assistance:new_request', 10000);
  const reAckA = await emit(ms, 'assist:reactivate', { assistId });
  ok('assist:reactivate ack ok', reAckA && reAckA.ok === true, reAckA);
  const aReq2 = await aReq2P;
  ok('повторная помощь пришла', !!aReq2 && aReq2.assistId === assistId, aReq2);
  ok('адрес в повторной заявке есть', !!aReq2 && !!aReq2.pickupAddress, aReq2);

  const aAccEvent = waitEvent(ps, 'assistance:accepted', 10000);
  ms.emit('assistance:accept', { assistId });
  const aAcc = await aAccEvent;
  ok('помощь принята после reactivate', !!aAcc && aAcc.assistId === assistId, aAcc);

  const takenAckA = await emit(ms, 'assist:reactivate', { assistId });
  ok('повторный assist:reactivate → taken', takenAckA && takenAckA.ok === false && takenAckA.error === 'taken', takenAckA);

  await emit(ms, 'assistance:finish', { assistId, price: 1000 });

  console.log('== Проверка skipped API ==');
  const sk = await req('GET', '/api/driver/skipped', null, rd.body.token);
  ok('skipped список 200', sk.code === 200, sk.body);
  const hasRide = sk.body && sk.body.skips.find(s => s.request_type === 'ride' && s.request_id === rideId);
  ok('в skipped есть reactivated-поездка', !!hasRide && (hasRide.status === 'completed' || hasRide.status === 'in_progress'), hasRide);

  ps.close(); ds.close(); ms.close();
  console.log('== Итог: ' + pass + ' PASS / ' + fail + ' FAIL ==');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
