const db = require('../db');
const { reverseGeocode } = require('../geocode-help');

async function createAssist({ passengerId, pickup, pickupAddress, carMake, phone, breakdownType, description }) {
  // У пассажира нет адреса — узнаём его на сервере, чтобы механик видел
  // не координаты, а читаемый адрес точки.
  if (!pickupAddress) {
    pickupAddress = await reverseGeocode(pickup.lat, pickup.lon);
  }
  const result = await db.query(
    `INSERT INTO assistance_requests (passenger_id, pickup, pickup_address, car_make, phone, breakdown_type, description)
     VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6, $7, $8)
     RETURNING id, status, created_at, pickup_address`,
    [passengerId, pickup.lon, pickup.lat, pickupAddress || null, carMake || null, phone || null, breakdownType || null, description || null]
  );
  return result.rows[0];
}

async function acceptAssist(assistId, mechanicId) {
  const result = await db.query(
    `UPDATE assistance_requests SET mechanic_id = $2, status = 'accepted', accepted_at = now()
     WHERE id = $1 AND status = 'waiting'
     RETURNING id, passenger_id, mechanic_id, status`,
    [assistId, mechanicId]
  );
  return result.rows[0] || null;
}

async function finishAssist(assistId, price) {
  await db.query(
    `UPDATE assistance_requests SET status = 'completed', finished_at = now(), price = COALESCE($2, price) WHERE id = $1`,
    [assistId, price || null]
  );
}

async function cancelAssist(assistId) {
  await db.query(`UPDATE assistance_requests SET status = 'cancelled', finished_at = now() WHERE id = $1`, [assistId]);
}

const ASSIST_SELECT = `
  SELECT a.id, a.passenger_id, a.mechanic_id, a.status, a.car_make, a.phone, a.breakdown_type, a.description, a.pickup_address,
         ST_Y(a.pickup::geometry) AS pickup_lat, ST_X(a.pickup::geometry) AS pickup_lon,
         a.created_at, a.accepted_at, a.finished_at,
         u.name AS passenger_name
  FROM assistance_requests a LEFT JOIN users u ON u.id = a.passenger_id`;

async function getAssist(assistId) {
  const result = await db.query(`${ASSIST_SELECT} WHERE a.id = $1`, [assistId]);
  return result.rows[0] || null;
}

async function findActiveAssistForUser(userId) {
  const result = await db.query(
    `${ASSIST_SELECT}
     WHERE (a.passenger_id = $1 OR a.mechanic_id = $1)
       AND a.status IN ('waiting', 'accepted', 'in_progress')
     ORDER BY a.created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

module.exports = { createAssist, acceptAssist, finishAssist, cancelAssist, getAssist, findActiveAssistForUser };
