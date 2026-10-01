/**
 * geocode.js – Nominatim search (restricted to India), browser geolocation.
 */

import { NOMINATIM_URL } from './config.js';
import { debounce, fetchWithTimeout } from './utils.js';

/**
 * Search for a place name via Nominatim, restricted to India.
 * @param {string} query
 * @returns {Promise<Array>}
 */
export async function searchPlace(query) {
  if (!query || query.trim().length < 2) return [];

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    countrycodes: 'in',
    limit: '6',
    addressdetails: '1',
  });

  try {
    const resp = await fetchWithTimeout(
      `${NOMINATIM_URL}?${params}`,
      {
        headers: {
          'User-Agent': 'GeoImpathon-HazardRouter/1.0',
          'Accept-Language': 'en',
        },
      },
      8000
    );

    if (!resp.ok) return [];
    const data = await resp.json();

    return data.map(r => ({
      name: r.display_name.split(',').slice(0, 3).join(', '),
      fullName: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      type: r.type,
      importance: r.importance,
    }));
  } catch (e) {
    console.warn('Nominatim search failed:', e.message);
    return [];
  }
}

/**
 * Create a debounced search function.
 */
export function createDebouncedSearch(callback, delayMs = 400) {
  return debounce(async (query) => {
    const results = await searchPlace(query);
    callback(results);
  }, delayMs);
}

/**
 * Get current position via browser Geolocation API.
 * @returns {Promise<{lat, lon}>}
 */
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        });
      },
      (err) => {
        reject(new Error(`Geolocation: ${err.message}`));
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}
