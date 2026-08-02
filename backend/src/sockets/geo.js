const redis = require('../redis');

// Отдельный geo-набор на роль — водители и механики не мешают друг другу в поиске.
const geoKey = (role) => `geo:${role}`; // geo:driver | geo:mechanic

// Также храним socketId и статус online отдельно (Redis GEO не хранит доп. поля).
const metaKey = (role, userId) => `driver_meta:${role}:${userId}`;
// Персистентный статус online/offline — НЕ удаляется при removeDriver,
// иначе следующий location:update молча вернул бы водителя в гео-поиск.
const statusKey = (role, userId) => `driver_status:${role}:${userId}`;

async function setLocation(role, userId, lon, lat, meta) {
  await redis.geoadd(geoKey(role), lon, lat, userId);
  // ВАЖНО: поле status НЕ трогаем — его владелец только setStatus().
  // Иначе гонка: location:update, пришедший до driver:status online, затирал
  // актуальный статус и водитель пропадал из гео-поиска.
  await redis.hset(metaKey(role, userId), {
    socketId: meta.socketId,
    name: meta.name,
    updatedAt: Date.now(),
  });
  await redis.expire(metaKey(role, userId), 60 * 10); // авто-очистка "мёртвых" записей
}

async function removeDriver(role, userId) {
  await redis.zrem(geoKey(role), userId);
  await redis.del(metaKey(role, userId));
}

async function setStatus(role, userId, status) {
  await redis.set(statusKey(role, userId), status, 'EX', 60 * 60 * 24 * 7);
  await redis.hset(metaKey(role, userId), 'status', status);
}

async function getStatus(role, userId) {
  const status = await redis.get(statusKey(role, userId));
  return status || 'offline'; // по умолчанию offline — пока водитель не включил онлайн
}

// Ищем ближайших N доступных (status=online) в радиусе radiusKm
async function findNearby(role, lon, lat, radiusKm = 15, count = 20) {
  const results = await redis.geosearch(
    geoKey(role),
    'FROMLONLAT', lon, lat,
    'BYRADIUS', radiusKm, 'km',
    'ASC',
    'COUNT', count,
    'WITHCOORD'
  );
  // results: [[userId, [lon, lat]], ...]
  const out = [];
  for (const [userId, [rlon, rlat]] of results) {
    const meta = await redis.hgetall(metaKey(role, userId));
    if (meta.status === 'online') {
      out.push({ userId, lon: parseFloat(rlon), lat: parseFloat(rlat), ...meta });
    }
  }
  return out;
}

async function getLocation(role, userId) {
  const pos = await redis.geopos(geoKey(role), userId);
  if (!pos || !pos[0]) return null;
  const [lon, lat] = pos[0];
  return { lon: parseFloat(lon), lat: parseFloat(lat) };
}

module.exports = { setLocation, removeDriver, setStatus, getStatus, findNearby, getLocation };
