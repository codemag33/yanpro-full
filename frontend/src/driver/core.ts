// Ядро PWA водителя: синглтон-состояние + общие утилиты.
// Модуль без DOM-логики, чтобы его могли импортировать все остальные модули.
import type { Socket } from 'socket.io-client';
import type maplibregl from 'maplibre-gl';
import type { GeoPoint, ChatContext, ActiveRide, ActiveAssist } from '../shared/protocol';

export const ORENBURG = { lat: 51.7727, lon: 55.0988 };

export interface DriverUser {
  id: string;
  role: 'driver' | 'mechanic';
  name?: string;
  [k: string]: unknown;
}

export interface PendingMarkerEntry {
  id: string;
  kind: 'ride' | 'assist';
  marker: maplibregl.Marker;
}

export interface IncomingRequest {
  kind: 'ride' | 'assist';
  rideId?: string;
  assistId?: string;
  passengerName: string;
  pickup?: GeoPoint & { address?: string };
  pickupAddress?: string;
  destination?: GeoPoint;
  destinationAddress?: string;
  carMake?: string;
  phone?: string;
  breakdownType?: string;
  description?: string;
  route?: { geometry: unknown };
  [k: string]: unknown;
}

export interface DriverState {
  serverUrl: string;
  token: string | null;
  user: DriverUser | null;
  regRole: 'driver' | 'mechanic';
  socket: Socket | null;
  map: maplibregl.Map | null;
  markers: { self: maplibregl.Marker | null; passenger: maplibregl.Marker | null };
  pendingMarkers: PendingMarkerEntry[];
  isOnline: boolean;
  lastPos: GeoPoint | null; // последние известные координаты (GPS или тап) — для маршрута
  pendingRequest: IncomingRequest | null; // входящий заказ/заявка, ждущая решения
  requestQueue: IncomingRequest[]; // очередь ожидающих заявок (когда показывается текущая)
  countdownTimer: ReturnType<typeof setTimeout> | null;
  activeRide: ActiveRide | null;
  activeAssist: ActiveAssist | null;
  chatContext: ChatContext | null;
  directTake: { kind: 'ride' | 'assist'; id: string } | null;
  finishKind: 'ride' | 'assist' | null;
  earnings: { total: number; rides: number };
  backgrounded: boolean;
  bgRecoveryTimer: boolean;
}

export const state: DriverState = {
  serverUrl: localStorage.getItem('yanpro_driver_server_url') || window.location.origin,
  token: localStorage.getItem('yanpro_driver_token') || null,
  user: JSON.parse(localStorage.getItem('yanpro_driver_user') || 'null'),
  regRole: 'driver',
  socket: null,
  map: null,
  markers: { self: null, passenger: null },
  pendingMarkers: [],
  isOnline: false,
  lastPos: null,
  pendingRequest: null,
  requestQueue: [],
  countdownTimer: null,
  activeRide: null,
  activeAssist: null,
  chatContext: null,
  directTake: null,
  finishKind: null,
  earnings: { total: 0, rides: 0 },
  backgrounded: false,
  bgRecoveryTimer: false,
};

export function isMechanic() {
  return state.user?.role === 'mechanic';
}

export function getOSRMUrl() {
  return state.serverUrl.replace(/\/$/, '') + '/api/routing/route';
}

export function formatDistance(meters: number) {
  return meters >= 1000 ? (meters / 1000).toFixed(1) + ' км' : Math.round(meters) + ' м';
}

export function formatDuration(seconds: number) {
  const m = Math.round(seconds / 60);
  return m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин';
}
