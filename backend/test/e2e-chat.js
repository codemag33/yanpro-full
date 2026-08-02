// E2E: чат пассажир ↔ водитель после принятия поездки.
// Запуск: E2E_BASE=https://taxi.fbs3.ru npm run test:e2e:chat
// Тестовые пользователи создаются с префиксом tchat_ и удаляются cleanup.sql.
const https = require('https');
const { io } = require('socket.io-client');

const BASE = process.env.E2E_BASE || 'https://taxi.fbs3.ru';
const HOST = new URL(BASE).hostname;
const ts = Date.now();
const PASS = { login: 'tchat_p_' + ts, password: 'passPass123', name: 'Чат-пасс', role: 'passenger' };
const DRIVER = { login: 'tchat_d_' + ts, password: 'drivePass123', name: 'Чат-дрив', role: 'driver', vehicle_make: 'Lada', vehicle_plate: 'X777XX' };
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
  if (rp.code !== 200 || rd.code !== 200) { console.log('register failed', rp.body, rd.body); process.exit(1); }

  const ps = await connect(rp.body.token, 'passenger');
  const ds = await connect(rd.body.token, 'driver');
  ds.emit('location:update', { lat: LAT, lon: LON });
  ds.emit('driver:status', { status: 'online' });
  await new Promise(r => setTimeout(r, 800));

  console.log('== Поездка → принятие ==');
  ps.emit('ride:request', {
    pickup: { lat: LAT + 0.001, lon: LON + 0.001 }, pickupAddress: 'Оренбург, Советская 1',
    destination: { lat: LAT + 0.02, lon: LON + 0.02 }, destinationAddress: 'Оренбург, Пролетарская 2',
  });
  const created = await waitEvent(ps, 'ride:created', 10000);
  ok('ride:created', !!created, created);
  if (!created) process.exit(1);
  await waitEvent(ds, 'ride:new_request', 10000);
  ds.emit('ride:accept', { rideId: created.rideId });
  await waitEvent(ps, 'ride:accepted', 10000);
  ok('поездка принята', true);
  await new Promise(r => setTimeout(r, 500));

  console.log('== Чат: история и сообщения ==');
  const ctx = { contextType: 'ride', contextId: created.rideId };

  const histP = waitEvent(ps, 'chat:history', 8000);
  ps.emit('chat:history', ctx);
  const hP = await histP;
  ok('пассажир получил chat:history (пустой — ок)', !!hP && Array.isArray(hP.messages), hP);

  const histD = waitEvent(ds, 'chat:history', 8000);
  ds.emit('chat:history', ctx);
  const hD = await histD;
  ok('водитель получил chat:history', !!hD && Array.isArray(hD.messages), hD);

  const msgP = waitEvent(ps, 'chat:message', 8000);
  const msgD = waitEvent(ds, 'chat:message', 8000);
  ds.emit('chat:send', { ...ctx, text: 'Здравствуйте, я подъеду через 5 минут' });
  const mD = await msgP;
  const mD2 = await msgD;
  ok('пассажир получил chat:message', !!mD && mD.text.includes('подъеду'), mD);
  ok('водитель получил свой chat:message', !!mD2, mD2);

  const msgP2 = waitEvent(ps, 'chat:message', 8000);
  const msgD3 = waitEvent(ds, 'chat:message', 8000);
  ps.emit('chat:send', { ...ctx, text: 'Спасибо, жду вас' });
  const mP2 = await msgP2;
  const mD4 = await msgD3;
  ok('пассажир видит своё сообщение', !!mP2 && mP2.text.includes('Спасибо'), mP2);
  ok('водитель получил ответ пассажира', !!mD4 && mD4.text.includes('Спасибо'), mD4);

  const histP2 = waitEvent(ps, 'chat:history', 8000);
  ps.emit('chat:history', ctx);
  const hP2 = await histP2;
  ok('история после сообщений: 2 шт', !!hP2 && hP2.messages.length === 2, hP2 && hP2.messages);

  await emit(ds, 'ride:finish', { rideId: created.rideId, price: 300 });
  ps.close(); ds.close();
  console.log('== Итог: ' + pass + ' PASS / ' + fail + ' FAIL ==');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
