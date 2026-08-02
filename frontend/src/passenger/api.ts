// REST API пассажира: fetch с таймаутом + reverse-geocode.
import { state } from './core';
import { createApi, fetchWithTimeout } from '../shared/api';

export const api = createApi(state);

export { fetchWithTimeout };

export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const data = await api(`/api/geocode/reverse?lat=${lat}&lon=${lon}`);
    return data.address;
  } catch {
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }
}
