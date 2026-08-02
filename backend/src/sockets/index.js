const { verifyToken } = require('../auth');
const { EVENTS } = require('../../shared/protocol');
const db = require('../db');
const geo = require('./geo');
const ridesDb = require('./rides');
const assistDb = require('./assistance');

// ─── Комнаты ────────────────────────────────────────────────────────────
// user_{id}   — персональная комната пользователя (не привязана к конкретному сокету/устройству)
// ride_{id}   — общая комната пассажира и водителя одной поездки — только они видят события друг друга
// assist_{id} — то же для заявки на помощь механика
const userRoom = (id) => `user_${id}`;
const rideRoom = (id) => `ride_${id}`;
const assistRoom = (id) => `assist_${id}`;

function setupSockets(io) {
  // ─── Хранилище уведомлённых водителей (per ride) ───────────────────
  const notifiedDriversMap = new Map();
  // ─── Сокеты, которым уже выслали отложенные заявки ────────────────
  // ─── Кэш проверки pending-заявок (сбрасывается через 5 минут) ───────
  // userId → timestamp последней проверки
  const pendingChecked = new Map();
  const PENDING_CHECK_TTL_MS = 5 * 60 * 1000;

  // ─── Истечение заявок: пассажир пропал или никто не принял ─────────────
  // Без этого "мёртвые" заявки в статусе searching/waiting висели на картах
  // водителей вечно (кружки, которые нельзя принять).
  const REQUEST_TTL_MIN = 10;
  const expiryTimer = setInterval(async () => {
    try {
      const rides = await db.query(
        `UPDATE rides SET status = 'cancelled', finished_at = now(), cancel_reason = 'timeout'
         WHERE status = 'searching' AND created_at < now() - interval '${REQUEST_TTL_MIN} minutes'
         RETURNING id`
      );
      for (const r of rides.rows) {
        io.to(rideRoom(r.id)).emit(EVENTS.RIDE_CANCELLED, { rideId: r.id, by: 'system', reason: 'timeout' });
        io.to('dispatch').emit(EVENTS.RIDE_CANCELLED, { rideId: r.id });
        io.emit(EVENTS.PENDING_RIDE_REMOVED, { rideId: r.id });
        io.socketsLeave(rideRoom(r.id));
        notifiedDriversMap.delete(r.id);
      }
      if (rides.rowCount) console.log(`[expiry] снято поездок: ${rides.rowCount}`);

      const assists = await db.query(
        `UPDATE assistance_requests SET status = 'cancelled', finished_at = now()
         WHERE status = 'waiting' AND created_at < now() - interval '${REQUEST_TTL_MIN} minutes'
         RETURNING id`
      );
      for (const a of assists.rows) {
        io.to(assistRoom(a.id)).emit(EVENTS.ASSIST_CANCELLED, { assistId: a.id, by: 'system' });
        io.to('dispatch').emit(EVENTS.ASSIST_CANCELLED, { assistId: a.id });
        io.emit(EVENTS.PENDING_ASSIST_REMOVED, { assistId: a.id });
        io.socketsLeave(assistRoom(a.id));
      }
      if (assists.rowCount) console.log(`[expiry] снято заявок: ${assists.rowCount}`);
    } catch (e) {
      console.error('[expiry]', e.message);
    }
  }, 60 * 1000).unref();
  // ─── Аутентификация на этапе handshake ──────────────────────────────
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('no_token'));
      socket.user = verifyToken(token); // { id, role, name, login }
      next();
    } catch {
      next(new Error('invalid_token'));
    }
  });

  io.on('connection', async (socket) => {
    const { id: userId, role, name } = socket.user;
    socket.join(userRoom(userId));
    if (role === 'admin') socket.join('dispatch');
    console.log(`[connect] ${name} (${role}) userId=${userId} socket=${socket.id}`);

    // Обновляем последнее время активности пользователя (для админ-панели)
    db.query('UPDATE users SET last_activity = now() WHERE id = $1', [userId]).catch(e => console.error('[last_activity update]', e));

    // ─── Восстановление сессии при реконнекте ──────────────────────────
    // Если у пользователя есть активная поездка/заявка — сразу подключаем его обратно
    // в нужную комнату и сообщаем клиенту текущее состояние.
    try {
      const activeRide = await ridesDb.findActiveRideForUser(userId);
      if (activeRide) {
        socket.join(rideRoom(activeRide.id));
        socket.emit(EVENTS.SESSION_RESTORE_RIDE, activeRide);
      }
      const activeAssist = await assistDb.findActiveAssistForUser(userId);
      if (activeAssist) {
        socket.join(assistRoom(activeAssist.id));
        socket.emit(EVENTS.SESSION_RESTORE_ASSIST, activeAssist);
      }
    } catch (err) {
      console.error('[session:restore] error', err);
    }

    // ─── Обновление геолокации (водитель/механик) ──────────────────────
    socket.on(EVENTS.LOCATION_UPDATE, async (data) => {
      if (typeof data?.lat !== 'number' || typeof data?.lon !== 'number') return;

      if (role === 'driver' || role === 'mechanic') {
        // Используем сохранённый статус, а не хардкодим 'online':
        // иначе офлайн-водитель (или отключившийся от гео) снова появлялся
        // в поиске при первом же location:update.
        const status = await geo.getStatus(role, userId);
        if (status === 'online') {
          await geo.setLocation(role, userId, data.lon, data.lat, { socketId: socket.id, name });
        } else {
          await geo.setLocation(role, userId, data.lon, data.lat, { socketId: socket.id, name });
        }
        // Шлём координаты только в комнату конкретной поездки, а не всем подряд.
        if (data.rideId) socket.to(rideRoom(data.rideId)).emit(EVENTS.RIDE_DRIVER_LOCATION, { lat: data.lat, lon: data.lon });
        if (data.assistId) socket.to(assistRoom(data.assistId)).emit(EVENTS.ASSIST_DRIVER_LOCATION, { lat: data.lat, lon: data.lon });
        // Диспетчерская: обновляем локацию водителя на карте в реальном времени
        socket.to('dispatch').emit(EVENTS.DRIVER_LOCATION_UPDATE, { userId, lat: data.lat, lon: data.lon, role, name });

        // Первое обновление локации — ищем отложенные заявки рядом.
        // Только если водитель онлайн и НЕ занят (busy) активной поездкой.
        const lastCheck = pendingChecked.get(userId) || 0;
        if (status === 'online' && Date.now() - lastCheck > PENDING_CHECK_TTL_MS) {
          pendingChecked.set(userId, Date.now());
          try {
            if (role === 'driver') {
              const pending = await db.query(
                `SELECT id, ST_Y(pickup::geometry) AS lat, ST_X(pickup::geometry) AS lon,
                        ST_Y(destination::geometry) AS dest_lat, ST_X(destination::geometry) AS dest_lon,
                        pickup_address, destination_address, passenger_id
                 FROM rides
                 WHERE status = 'searching'
                   AND ST_DWithin(pickup::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 15000)
                 ORDER BY created_at ASC LIMIT 3`,
                [data.lon, data.lat]
              );
              for (const r of pending.rows) {
                io.to(userRoom(userId)).emit(EVENTS.RIDE_NEW_REQUEST, {
                  rideId: r.id,
                  passengerName: 'Пассажир',
                  pickup: { lat: r.lat, lon: r.lon },
                  pickupAddress: r.pickup_address,
                  destination: { lat: r.dest_lat || 0, lon: r.dest_lon || 0 },
                  destinationAddress: r.destination_address,
                });
              }
            }
            if (role === 'mechanic') {
              const pending = await db.query(
                `SELECT id, ST_Y(pickup::geometry) AS lat, ST_X(pickup::geometry) AS lon,
                        car_make, phone, breakdown_type, description, passenger_id, pickup_address
                 FROM assistance_requests
                 WHERE status = 'waiting'
                   AND ST_DWithin(pickup::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 25000)
                 ORDER BY created_at ASC LIMIT 3`,
                [data.lon, data.lat]
              );
              for (const a of pending.rows) {
                io.to(userRoom(userId)).emit(EVENTS.ASSIST_NEW_REQUEST, {
                  assistId: a.id,
                  passengerName: 'Пассажир',
                  pickup: { lat: a.lat, lon: a.lon },
                  pickupAddress: a.pickup_address,
                  carMake: a.car_make,
                  phone: a.phone,
                  breakdownType: a.breakdown_type,
                  description: a.description,
                });
              }
            }
          } catch (e) { console.error('[pending check]', e.message); }
        }
        return;
      }

      // Пассажир тоже может слать своё местоположение — полезно водителю на подъезде к точке А.
      // Рассылаем только в комнату активной поездки, аналогично.
      if (role === 'passenger') {
        if (data.rideId) socket.to(rideRoom(data.rideId)).emit(EVENTS.RIDE_PASSENGER_LOCATION, { lat: data.lat, lon: data.lon });
        if (data.assistId) socket.to(assistRoom(data.assistId)).emit(EVENTS.ASSIST_PASSENGER_LOCATION, { lat: data.lat, lon: data.lon });
      }
    });

    socket.on(EVENTS.DRIVER_STATUS, async (data) => {
      if (role !== 'driver' && role !== 'mechanic') return;
      const status = data?.status === 'online' ? 'online' : 'offline';
      if (status === 'offline') {
        await geo.removeDriver(role, userId);
      } else {
        await geo.setStatus(role, userId, 'online');
      }
      // Синхронизируем статус в PostgreSQL для админ-панели
      try {
        await db.query(
          `UPDATE driver_profiles SET status = $1, updated_at = now() WHERE user_id = $2`,
          [status, userId]
        );
      } catch (e) { console.error('[driver:status db]', e.message); }
    });

    // ─── Список активных заказов на карту ──────────────────────────────────
    socket.on(EVENTS.PENDING_LIST, async () => {
      if (role !== 'driver' && role !== 'mechanic') return;
      try {
        const rides = await db.query(
          `SELECT id, ST_Y(pickup::geometry) AS lat, ST_X(pickup::geometry) AS lon
           FROM rides WHERE status = 'searching'
           ORDER BY created_at ASC LIMIT 50`
        );
        socket.emit(EVENTS.PENDING_RIDES, rides.rows);
        if (role === 'mechanic') {
          const assists = await db.query(
            `SELECT id, ST_Y(pickup::geometry) AS lat, ST_X(pickup::geometry) AS lon
             FROM assistance_requests WHERE status = 'waiting'
             ORDER BY created_at ASC LIMIT 50`
          );
          socket.emit(EVENTS.PENDING_ASSISTS, assists.rows);
        }
      } catch (e) { console.error('[pending:list]', e.message); }
    });

    // ─── Возобновить свободную заявку (клик по кружку на карте или по пропущенной) ──
    // Отправляет заявку в личный канал водителя/механика, если она ещё свободна.
    socket.on(EVENTS.RIDE_REACTIVATE, async (data, ack) => {
      if (role !== 'driver' || !data?.rideId) return;
      try {
        const r = await db.query(
          `SELECT r.id, r.pickup_address, r.destination_address, r.passenger_id,
                  ST_Y(r.pickup::geometry) AS lat, ST_X(r.pickup::geometry) AS lon,
                  ST_Y(r.destination::geometry) AS dest_lat, ST_X(r.destination::geometry) AS dest_lon,
                  u.name AS passenger_name
           FROM rides r LEFT JOIN users u ON u.id = r.passenger_id
           WHERE r.id = $1 AND r.status = 'searching'`,
          [data.rideId]
        );
        if (!r.rows.length) {
          if (typeof ack === 'function') ack({ ok: false, error: 'taken' });
          return;
        }
        const ride = r.rows[0];
        socket.emit(EVENTS.RIDE_NEW_REQUEST, {
          rideId: ride.id,
          passengerName: ride.passenger_name || 'Пассажир',
          pickup: { lat: ride.lat, lon: ride.lon },
          pickupAddress: ride.pickup_address,
          destination: { lat: ride.dest_lat || 0, lon: ride.dest_lon || 0 },
          destinationAddress: ride.destination_address,
        });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (e) {
        console.error('[ride:reactivate]', e.message);
        if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
      }
    });

    socket.on(EVENTS.ASSIST_REACTIVATE, async (data, ack) => {
      if (role !== 'mechanic' || !data?.assistId) return;
      try {
        const a = await db.query(
          `SELECT a.id, a.car_make, a.phone, a.breakdown_type, a.description, a.pickup_address, a.passenger_id,
                  ST_Y(a.pickup::geometry) AS lat, ST_X(a.pickup::geometry) AS lon,
                  u.name AS passenger_name
           FROM assistance_requests a LEFT JOIN users u ON u.id = a.passenger_id
           WHERE a.id = $1 AND a.status = 'waiting'`,
          [data.assistId]
        );
        if (!a.rows.length) {
          if (typeof ack === 'function') ack({ ok: false, error: 'taken' });
          return;
        }
        const assist = a.rows[0];
        socket.emit(EVENTS.ASSIST_NEW_REQUEST, {
          assistId: assist.id,
          passengerName: assist.passenger_name || 'Пассажир',
          pickup: { lat: assist.lat, lon: assist.lon },
          pickupAddress: assist.pickup_address,
          carMake: assist.car_make,
          phone: assist.phone,
          breakdownType: assist.breakdown_type,
          description: assist.description,
        });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (e) {
        console.error('[assist:reactivate]', e.message);
        if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
      }
    });

    // ─── Поездка: запрос от пассажира ───────────────────────────────────
    socket.on(EVENTS.RIDE_REQUEST, async (data) => {
      if (role !== 'passenger') return;
      if (!data?.pickup || !data?.destination) return;

      try {
        const ride = await ridesDb.createRide({
          passengerId: userId,
          pickup: data.pickup,
          pickupAddress: data.pickupAddress,
          destination: data.destination,
          destAddress: data.destinationAddress,
        });
        socket.join(rideRoom(ride.id));

        // Ищем ближайших свободных водителей через Redis GEO — не рассылаем всем подряд.
        const nearby = await geo.findNearby('driver', data.pickup.lon, data.pickup.lat, 15, 20);
        // Запоминаем кому отправили, чтобы потом закрыть только им
        const notifiedDriverIds = [];
        for (const d of nearby) {
          io.to(userRoom(d.userId)).emit(EVENTS.RIDE_NEW_REQUEST, {
            rideId: ride.id,
            passengerName: name,
            pickup: data.pickup,
            pickupAddress: data.pickupAddress,
            destination: data.destination,
            destinationAddress: data.destinationAddress,
          });
          notifiedDriverIds.push(d.userId);
        }
        // Сохраняем список уведомлённых в ride (для ride:closed_for_others)
        notifiedDriversMap.set(ride.id, notifiedDriverIds);
        socket.emit(EVENTS.RIDE_CREATED, { rideId: ride.id, driversNotified: nearby.length });
        io.to('dispatch').emit(EVENTS.RIDE_CREATED, { rideId: ride.id });
        // Показываем заказ на картах всех онлайн-водителей
        io.emit(EVENTS.PENDING_RIDE_CREATED, { id: ride.id, lat: data.pickup.lat, lon: data.pickup.lon });
      } catch (err) {
        console.error('[ride:request] error', err);
        socket.emit(EVENTS.ERROR_SERVER, { context: EVENTS.RIDE_REQUEST });
      }
    });

    // ─── Поездка: принятие водителем ────────────────────────────────────
    socket.on(EVENTS.RIDE_ACCEPT, async (data) => {
      if (role !== 'driver') return;
      if (!data?.rideId) return;

      const ride = await ridesDb.acceptRide(data.rideId, userId);
      if (!ride) {
        // Поездку уже забрал другой водитель раньше нас.
        socket.emit(EVENTS.RIDE_ALREADY_TAKEN, { rideId: data.rideId });
        return;
      }

      socket.join(rideRoom(ride.id));
      io.in(userRoom(ride.passenger_id)).socketsJoin(rideRoom(ride.id));

      // Водитель занят — новые заказы ему не шлём, пока не завершит поездку.
      await geo.setStatus('driver', userId, 'busy');

      io.to(rideRoom(ride.id)).emit(EVENTS.RIDE_ACCEPTED, {
        rideId: ride.id,
        driverId: userId,
        driverName: name,
      });
      io.to('dispatch').emit(EVENTS.RIDE_ACCEPTED, { rideId: ride.id });
      io.emit(EVENTS.PENDING_RIDE_REMOVED, { rideId: ride.id });

      // Уведомляем ТОЛЬКО тех водителей, которым отправляли заказ
      const notifiedIds = notifiedDriversMap.get(ride.id);
      if (notifiedIds) {
        for (const driverId of notifiedIds) {
          if (driverId !== userId) {
            io.to(userRoom(driverId)).emit(EVENTS.RIDE_CLOSED_FOR_OTHERS, { rideId: ride.id });
          }
        }
        notifiedDriversMap.delete(ride.id);
      } else {
        // Fallback: если список не сохранился (рестарт сервера) — broadcast
        socket.broadcast.emit(EVENTS.RIDE_CLOSED_FOR_OTHERS, { rideId: ride.id });
      }
    });

    socket.on(EVENTS.RIDE_START, async (data) => {
      if (role !== 'driver' || !data?.rideId) return;
      await ridesDb.startRide(data.rideId);
      io.to(rideRoom(data.rideId)).emit(EVENTS.RIDE_STARTED, { rideId: data.rideId });
    });

    socket.on(EVENTS.RIDE_FINISH, async (data, ack) => {
      if (role !== 'driver' || !data?.rideId) return;
      try {
        await ridesDb.finishRide(data.rideId, data.price);
        io.to(rideRoom(data.rideId)).emit(EVENTS.RIDE_FINISHED, { rideId: data.rideId, price: data.price });
        io.to('dispatch').emit(EVENTS.RIDE_FINISHED, { rideId: data.rideId });
        io.socketsLeave(rideRoom(data.rideId));
        await geo.setStatus('driver', userId, 'online'); // снова свободен
        if (typeof ack === 'function') ack({ ok: true, rideId: data.rideId });
      } catch (err) {
        console.error('[ride:finish] error', err);
        if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
      }
    });

    socket.on(EVENTS.RIDE_CANCEL, async (data) => {
      if (!data?.rideId) return;
      // Сбрасываем busy у водителя (кто бы ни отменил поездку — он снова свободен)
      try {
        const r = await db.query(`SELECT driver_id FROM rides WHERE id = $1`, [data.rideId]);
        if (r.rows[0]?.driver_id) await geo.setStatus('driver', r.rows[0].driver_id, 'online');
      } catch (e) { console.error('[ride:cancel status]', e.message); }
      await ridesDb.cancelRide(data.rideId, data.reason);
      io.to(rideRoom(data.rideId)).emit(EVENTS.RIDE_CANCELLED, { rideId: data.rideId, by: role });
      io.to('dispatch').emit(EVENTS.RIDE_CANCELLED, { rideId: data.rideId });
      io.emit(EVENTS.PENDING_RIDE_REMOVED, { rideId: data.rideId });
      io.socketsLeave(rideRoom(data.rideId));
    });

    // ─── Торг ценой ──────────────────────────────────────────────────────
    // Водитель предлагает цену поездки — пассажир видит её в своём интерфейсе.
    socket.on(EVENTS.RIDE_PRICE_OFFER, async (data) => {
      if (role !== 'driver' || !data?.rideId || !data?.price || data.price <= 0) return;
      await ridesDb.offerPrice(data.rideId, parseFloat(data.price));
      io.to(rideRoom(data.rideId)).emit(EVENTS.RIDE_PRICE_OFFERED, {
        rideId: data.rideId, price: parseFloat(data.price),
      });
    });
    // Пассажир принимает предложенную цену — она становится ценой поездки.
    socket.on(EVENTS.RIDE_PRICE_OFFER_ACCEPT, async (data) => {
      if (role !== 'passenger' || !data?.rideId) return;
      await ridesDb.acceptPriceOffer(data.rideId);
      io.to(rideRoom(data.rideId)).emit(EVENTS.RIDE_PRICE_ACCEPTED, { rideId: data.rideId });
    });
    // Пассажир отклоняет — предложение снимается.
    socket.on(EVENTS.RIDE_PRICE_OFFER_REJECT, async (data) => {
      if (role !== 'passenger' || !data?.rideId) return;
      await ridesDb.rejectPriceOffer(data.rideId);
      io.to(rideRoom(data.rideId)).emit(EVENTS.RIDE_PRICE_REJECTED, { rideId: data.rideId });
    });

    // ─── Пропуск заказа / заявки (сохранение в журнал) ──────────────────
    socket.on(EVENTS.RIDE_SKIP, async (data) => {
      if (!data?.rideId) return;
      try {
        await db.query(
          `INSERT INTO skipped_requests (user_id, request_type, request_id) VALUES ($1, 'ride', $2)`,
          [userId, data.rideId]
        );
      } catch (e) { console.error('[ride:skip]', e.message); }
    });
    socket.on(EVENTS.ASSIST_SKIP, async (data) => {
      if (!data?.assistId) return;
      try {
        await db.query(
          `INSERT INTO skipped_requests (user_id, request_type, request_id) VALUES ($1, 'assist', $2)`,
          [userId, data.assistId]
        );
      } catch (e) { console.error('[assistance:skip]', e.message); }
    });

    // ─── Заявка на помощь (механик) — та же логика, отдельные комнаты ──
    socket.on(EVENTS.ASSIST_REQUEST, async (data) => {
      if (role !== 'passenger') return;
      if (!data?.pickup) return;

      const assist = await assistDb.createAssist({
        passengerId: userId,
        pickup: data.pickup,
        pickupAddress: data.pickupAddress,
        carMake: data.carMake,
        phone: data.phone,
        breakdownType: data.breakdownType,
        description: data.description,
      });
      socket.join(assistRoom(assist.id));

      const nearby = await geo.findNearby('mechanic', data.pickup.lon, data.pickup.lat, 25, 20);
      for (const m of nearby) {
        io.to(userRoom(m.userId)).emit(EVENTS.ASSIST_NEW_REQUEST, {
          assistId: assist.id,
          passengerName: name,
          pickup: data.pickup,
          pickupAddress: assist.pickup_address,
          carMake: data.carMake,
          phone: data.phone,
          breakdownType: data.breakdownType,
          description: data.description,
        });
      }
      socket.emit(EVENTS.ASSIST_CREATED, { assistId: assist.id, mechanicsNotified: nearby.length });
      io.emit(EVENTS.PENDING_ASSIST_CREATED, { id: assist.id, lat: data.pickup.lat, lon: data.pickup.lon });
    });

    socket.on(EVENTS.ASSIST_ACCEPT, async (data) => {
      if (role !== 'mechanic' || !data?.assistId) return;
      const assist = await assistDb.acceptAssist(data.assistId, userId);
      if (!assist) {
        socket.emit(EVENTS.ASSIST_ALREADY_TAKEN, { assistId: data.assistId });
        return;
      }
      socket.join(assistRoom(assist.id));
      io.in(userRoom(assist.passenger_id)).socketsJoin(assistRoom(assist.id));
      await geo.setStatus('mechanic', userId, 'busy'); // мастер занят
      io.to(assistRoom(assist.id)).emit(EVENTS.ASSIST_ACCEPTED, {
        assistId: assist.id, mechanicId: userId, mechanicName: name,
      });
      socket.broadcast.emit(EVENTS.ASSIST_CLOSED_FOR_OTHERS, { assistId: assist.id });
      io.to('dispatch').emit(EVENTS.ASSIST_ACCEPTED, { assistId: assist.id });
      io.emit(EVENTS.PENDING_ASSIST_REMOVED, { assistId: assist.id });
    });

    socket.on(EVENTS.ASSIST_FINISH, async (data, ack) => {
      if (role !== 'mechanic' || !data?.assistId) return;
      try {
        await assistDb.finishAssist(data.assistId, data.price);
        io.to(assistRoom(data.assistId)).emit(EVENTS.ASSIST_FINISHED, { assistId: data.assistId, price: data.price });
        io.to('dispatch').emit(EVENTS.ASSIST_FINISHED, { assistId: data.assistId });
        io.socketsLeave(assistRoom(data.assistId));
        await geo.setStatus('mechanic', userId, 'online'); // снова свободен
        if (typeof ack === 'function') ack({ ok: true, assistId: data.assistId });
      } catch (err) {
        console.error('[assistance:finish] error', err);
        if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
      }
    });

    socket.on(EVENTS.ASSIST_CANCEL, async (data) => {
      if (!data?.assistId) return;
      // Сбрасываем busy у механика (кто бы ни отменил заявку — он снова свободен)
      try {
        const a = await db.query(`SELECT mechanic_id FROM assistance_requests WHERE id = $1`, [data.assistId]);
        if (a.rows[0]?.mechanic_id) await geo.setStatus('mechanic', a.rows[0].mechanic_id, 'online');
      } catch (e) { console.error('[assistance:cancel status]', e.message); }
      await assistDb.cancelAssist(data.assistId);
      io.to(assistRoom(data.assistId)).emit(EVENTS.ASSIST_CANCELLED, { assistId: data.assistId, by: role });
      io.to('dispatch').emit(EVENTS.ASSIST_CANCELLED, { assistId: data.assistId });
      io.emit(EVENTS.PENDING_ASSIST_REMOVED, { assistId: data.assistId });
      io.socketsLeave(assistRoom(data.assistId));
    });

    // ─── Чат — строго внутри комнаты контекста, никто посторонний не видит ─
    socket.on(EVENTS.CHAT_SEND, async (data) => {
      const { contextType, contextId, text } = data || {};
      if (!contextType || !contextId || !text) return;
      if (!['ride', 'assist'].includes(contextType)) return;
      if (text.length > 2000) return; // защита от флуда

      const room = contextType === 'ride' ? rideRoom(contextId) : assistRoom(contextId);
      // Отправляем, только если сокет реально состоит в этой комнате — иначе можно было бы
      // писать в чужой чат, просто угадав id.
      if (!socket.rooms.has(room)) {
        socket.emit(EVENTS.ERROR_SERVER, { context: EVENTS.CHAT_SEND, reason: 'not_in_room' });
        return;
      }

      const saved = await ridesDb.saveChatMessage({
        contextType, contextId, senderId: userId, senderRole: role, text,
      });

      io.to(room).emit(EVENTS.CHAT_MESSAGE, {
        contextType, contextId, senderId: userId, senderRole: role,
        text, createdAt: saved.created_at,
      });
    });

    socket.on(EVENTS.CHAT_HISTORY, async (data) => {
      const { contextType, contextId } = data || {};
      if (!contextType || !contextId) return;
      const room = contextType === 'ride' ? rideRoom(contextId) : assistRoom(contextId);
      if (!socket.rooms.has(room)) return;
      const history = await ridesDb.getChatHistory(contextType, contextId);
      socket.emit(EVENTS.CHAT_HISTORY, { contextType, contextId, messages: history });
    });

    // ─── Отключение ──────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      pendingChecked.delete(userId);
      if (role === 'driver' || role === 'mechanic') {
        await geo.removeDriver(role, userId);
      }
      console.log(`[disconnect] ${name} (${role}) userId=${userId}`);
    });
  });
}

module.exports = setupSockets;
