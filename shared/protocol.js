// ════════════════════════════════════════════════════════════════════════
// ЕДИНЫЙ КОНТРАКТ СОКЕТ-ПРОТОКОЛА Yan.Pro
//
// Один источник правды для имён событий и форм полезных нагрузок.
// Используется:
//   - бэкендом:   const { EVENTS } = require('../../shared/protocol');
//   - фронтендом: import { EVENTS } from '../shared/protocol';
//
// Модуль чисто декларативный (константы + JSDoc-типы) — без поведения,
// чтобы бэкенд и клиент никогда не расходились в именах событий.
// ════════════════════════════════════════════════════════════════════════

// ─── Имена событий ──────────────────────────────────────────────────────
const EVENTS = {
  // Клиент → сервер
  LOCATION_UPDATE: 'location:update',
  DRIVER_STATUS: 'driver:status',
  PENDING_LIST: 'pending:list',

  // Поездки: клиент → сервер
  RIDE_REQUEST: 'ride:request',
  RIDE_ACCEPT: 'ride:accept',
  RIDE_START: 'ride:start',
  RIDE_FINISH: 'ride:finish',
  RIDE_CANCEL: 'ride:cancel',
  RIDE_SKIP: 'ride:skip',
  RIDE_REACTIVATE: 'ride:reactivate',
  RIDE_PRICE_OFFER: 'ride:price_offer',
  RIDE_PRICE_OFFER_ACCEPT: 'ride:price_offer_accept',
  RIDE_PRICE_OFFER_REJECT: 'ride:price_offer_reject',

  // Поездки: сервер → клиент
  RIDE_CREATED: 'ride:created',
  RIDE_NEW_REQUEST: 'ride:new_request',
  RIDE_ACCEPTED: 'ride:accepted',
  RIDE_ALREADY_TAKEN: 'ride:already_taken',
  RIDE_CLOSED_FOR_OTHERS: 'ride:closed_for_others',
  RIDE_STARTED: 'ride:started',
  RIDE_FINISHED: 'ride:finished',
  RIDE_CANCELLED: 'ride:cancelled',
  RIDE_DRIVER_LOCATION: 'ride:driver_location',
  RIDE_PASSENGER_LOCATION: 'ride:passenger_location',
  RIDE_PRICE_OFFERED: 'ride:price_offered',
  RIDE_PRICE_ACCEPTED: 'ride:price_accepted',
  RIDE_PRICE_REJECTED: 'ride:price_rejected',

  // Помощь на дороге: клиент → сервер
  ASSIST_REQUEST: 'assistance:request',
  ASSIST_ACCEPT: 'assistance:accept',
  ASSIST_FINISH: 'assistance:finish',
  ASSIST_CANCEL: 'assistance:cancel',
  ASSIST_SKIP: 'assistance:skip',
  ASSIST_REACTIVATE: 'assist:reactivate',

  // Помощь на дороге: сервер → клиент
  ASSIST_CREATED: 'assistance:created',
  ASSIST_NEW_REQUEST: 'assistance:new_request',
  ASSIST_ACCEPTED: 'assistance:accepted',
  ASSIST_ALREADY_TAKEN: 'assistance:already_taken',
  ASSIST_CLOSED_FOR_OTHERS: 'assistance:closed_for_others',
  ASSIST_FINISHED: 'assistance:finished',
  ASSIST_CANCELLED: 'assistance:cancelled',
  ASSIST_DRIVER_LOCATION: 'assistance:driver_location',
  ASSIST_PASSENGER_LOCATION: 'assistance:passenger_location',

  // Заявки на карте (pending)
  PENDING_RIDES: 'pending:rides',
  PENDING_ASSISTS: 'pending:assists',
  PENDING_RIDE_CREATED: 'pending:ride_created',
  PENDING_ASSIST_CREATED: 'pending:assist_created',
  PENDING_RIDE_REMOVED: 'pending:ride_removed',
  PENDING_ASSIST_REMOVED: 'pending:assist_removed',

  // Сессия
  SESSION_RESTORE_RIDE: 'session:restore_ride',
  SESSION_RESTORE_ASSIST: 'session:restore_assist',

  // Чат
  CHAT_SEND: 'chat:send',
  CHAT_HISTORY: 'chat:history',
  CHAT_MESSAGE: 'chat:message',

  // Общие
  CONNECT: 'connect',
  CONNECT_ERROR: 'connect_error',
  DISCONNECT: 'disconnect',
  ERROR_SERVER: 'error:server',

  // Диспетчерская
  DRIVER_LOCATION_UPDATE: 'driver:location_update',
};

// ─── Формы полезных нагрузок (JSDoc-типы для фронтенда и бэкенда) ───────

/**
 * Точка на карте (широта/долгота)
 * @typedef {{ lat: number, lon: number }} GeoPoint
 */

/**
 * @typedef {{ rideId: string, passengerName: string, pickup: GeoPoint,
 *             pickupAddress?: string, destination: GeoPoint, destinationAddress?: string,
 *             route?: { geometry: Object } }} RideRequestPayload
 */

/**
 * @typedef {{ assistId: string, passengerName: string, pickup: GeoPoint,
 *             pickupAddress?: string, carMake?: string, phone?: string,
 *             breakdownType?: string, description?: string }} AssistRequestPayload
 */

/**
 * Ответ на ack-события (reactivate и т.п.)
 * @typedef {{ ok: true } | { ok: false, error: 'taken' | 'server_error' | string }} AckPayload
 */

/**
 * @typedef {{ rideId: string, status?: string }} RideIdPayload
 * @typedef {{ assistId: string, status?: string }} AssistIdPayload
 * @typedef {{ userId: string, lat: number, lon: number, role?: string, name?: string }} LocationPayload
 */

/**
 * @typedef {{ contextType: 'ride' | 'assist', contextId: string, text: string }} ChatSendPayload
 * @typedef {{ contextType: 'ride' | 'assist', contextId: string,
 *             senderId: string, senderRole: string, text: string, createdAt: string }} ChatMessagePayload
 */

module.exports = { EVENTS };
