// Типы сокет-протокола для фронтенда.
// Имена событий — единый источник правды: shared/protocol.js (бэкенд + фронтенд).
import { EVENTS } from '../../../shared/protocol';

export { EVENTS };

// ─── Базовые типы ────────────────────────────────────────────────────────
export interface GeoPoint { lat: number; lon: number }

export interface RouteInfo {
  distance: number; // метры
  duration: number; // секунды
  geometry: any;
}

// ─── Полезные нагрузки событий ───────────────────────────────────────────
export interface RideRequestData {
  rideId: string;
  passengerName: string;
  pickup: GeoPoint;
  pickupAddress?: string;
  destination: GeoPoint;
  destinationAddress?: string;
  route?: { geometry: any };
}

export interface AssistRequestData {
  assistId: string;
  passengerName: string;
  pickup: GeoPoint;
  pickupAddress?: string;
  carMake?: string;
  phone?: string;
  breakdownType?: string;
  description?: string;
}

export type AckResponse = { ok: true } | { ok: false; error: 'taken' | 'server_error' | string };

export interface PendingItem { id: string; lat: number; lon: number }
export interface PendingCreated { id: string; lat: number; lon: number }
export interface PendingRemoved { rideId?: string; assistId?: string }

export interface ChatContext { contextType: 'ride' | 'assist'; contextId: string }
export interface ChatMessage {
  contextType: 'ride' | 'assist';
  contextId: string;
  senderId: string;
  senderRole: string;
  text: string;
  createdAt: string;
}

export interface RestoreRide {
  id: string; status: string;
  pickup_lat: number; pickup_lon: number; pickup_address?: string;
  destination_lat: number; destination_lon: number; destination_address?: string;
  passenger_name?: string;
}

export interface RestoreAssist {
  id: string; status: string;
  pickup_lat: number; pickup_lon: number; pickup_address?: string;
  car_make?: string; phone?: string; description?: string; breakdown_type?: string;
  passenger_name?: string;
}

// ─── Типы активных заявок (локальное состояние) ──────────────────────────
export interface ActiveRide {
  id: string; status: string; name: string;
  pickup: GeoPoint & { address?: string };
  destination?: GeoPoint & { address?: string };
  routeToPickup: RouteInfo | null;
  routeToDest: RouteInfo | null;
}

export interface ActiveAssist {
  id: string; status: string; name?: string;
  carMake?: string; breakdownType?: string; phone?: string; description?: string;
  pickup: GeoPoint;
  pickupAddress?: string;
  routeToPickup: RouteInfo | null;
}
