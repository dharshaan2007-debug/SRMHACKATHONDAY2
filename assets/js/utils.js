/**
 * utils.js – Shared utility functions.
 */

/** Haversine distance in meters */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Debounce a function */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Throttle via requestAnimationFrame */
export function rafThrottle(fn) {
  let pending = false;
  return (...args) => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      fn(...args);
      pending = false;
    });
  };
}

/** Format distance */
export function formatDist(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Format risk value 0-1 as percentage */
export function formatRisk(v) {
  return `${(v * 100).toFixed(1)}%`;
}

/** Classify risk value 0-1 */
export function classifyRisk(v) {
  if (v < 0.2) return 'very_low';
  if (v < 0.4) return 'low';
  if (v < 0.6) return 'moderate';
  if (v < 0.8) return 'high';
  return 'very_high';
}

/** Risk class to human label */
export function riskLabel(cls) {
  return cls.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Risk class to CSS modifier */
export function riskMod(cls) {
  return cls.replace(/_/g, '-');
}

/** Clamp value */
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/** Linear interpolation */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Check if point is inside bbox [west, south, east, north] */
export function inBbox(lat, lon, bbox) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/** Round to n decimals */
export function round(v, n = 2) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

/** Generate unique ID */
let _idCounter = 0;
export function uid(prefix = 'id') {
  return `${prefix}_${++_idCounter}`;
}

/** Simple fetch with timeout */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

/** Sleep for ms */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
