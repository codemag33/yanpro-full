// Ядро PWA пассажира: синглтон-состояние + утилиты.
import type { Socket } from 'socket.io-client';
import type maplibregl from 'maplibre-gl';
import type { GeoPoint, ChatContext } from '../shared/protocol';

export const ORENBURG = { lat: 51.7727, lon: 55.0988 };

export interface PassengerUser {
  id: string;
  role: 'passenger';
  name?: string;
  login?: string;
  [k: string]: unknown;
}

export interface PointSelection extends GeoPoint {
  address: string | null;
}

export interface PassengerState {
  serverUrl: string;
  token: string | null;
  user: PassengerUser | null;
  socket: Socket | null;
  map: maplibregl.Map | null;
  markers: Record<string, maplibregl.Marker | null>;
  pickup: PointSelection | null; // {lat, lon, address}
  destination: PointSelection | null; // {lat, lon, address}
  mode: 'ride' | 'assist';
  activeRide: any;
  activeAssist: any;
  chatContext: ChatContext | null;
  geoWatchId: number | null;
  backgrounded: boolean;
  bgRecoveryTimer: boolean;
}

export const state: PassengerState = {
  serverUrl: localStorage.getItem('yanpro_server_url') || window.location.origin,
  token: localStorage.getItem('yanpro_token') || null,
  user: JSON.parse(localStorage.getItem('yanpro_user') || 'null'),
  socket: null,
  map: null,
  markers: { pickup: null, dest: null, driver: null },
  pickup: null,
  destination: null,
  mode: 'ride',
  activeRide: null,
  activeAssist: null,
  chatContext: null,
  geoWatchId: null,
  backgrounded: false,
  bgRecoveryTimer: false,
};
