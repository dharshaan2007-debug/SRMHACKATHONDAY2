/**
 * osm-live.js – Overpass API client with mirrors, timeouts, IndexedDB cache.
 */

import { OVERPASS_MIRRORS, OVERPASS_TIMEOUT, HIGHWAY_TYPES, FETCH_RADII } from './config.js';
import { fetchWithTimeout, haversine } from './utils.js';

const DB_NAME = 'hazard-router-osm';
const DB_VERSION = 1;
const STORE_NAME = 'tiles';

let db = null;
let demoCache = {};

/**
 * Open IndexedDB for caching.
 */
async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_NAME)) {
        d.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get cached data from IndexedDB.
 */
async function getCached(key) {
  try {
    const d = await openDB();
    return new Promise((resolve) => {
      const tx = d.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

/**
 * Store data in IndexedDB.
 */
async function setCache(key, value) {
  try {
    const d = await openDB();
    const tx = d.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
  } catch { /* ignore */ }
}

/**
 * Load demo cache files.
 */
export async function loadDemoCache() {
  const cities = ['chennai', 'coimbatore', 'madurai', 'udhagamandalam', 'cuddalore'];
  for (const city of cities) {
    try {
      const resp = await fetch(`data/demo_cache/${city}.json`);
      if (resp.ok) {
        demoCache[city] = await resp.json();
      }
    } catch { /* not available */ }
  }
  console.log(`Demo cache: ${Object.keys(demoCache).length} cities loaded`);
}

/**
 * Check if a demo cache covers the given point.
 */
function findDemoCache(lat, lon) {
  for (const [city, data] of Object.entries(demoCache)) {
    if (data.center) {
      const dist = haversine(lat, lon, data.center[0], data.center[1]);
      if (dist < data.radius_m * 0.8) {
        return data;
      }
    }
  }
  return null;
}

/**
 * Build Overpass QL query.
 */
function buildQuery(lat, lon, radiusM) {
  return `
[out:json][timeout:${OVERPASS_TIMEOUT}];
(
  way["highway"~"^(${HIGHWAY_TYPES})$"](around:${radiusM},${lat},${lon});
  node["amenity"="hospital"](around:${radiusM},${lat},${lon});
  way["amenity"="hospital"](around:${radiusM},${lat},${lon});
  node["amenity"~"^(shelter|community_centre|public_building)$"](around:${radiusM},${lat},${lon});
  node["emergency"~"^(assembly_point|shelter)$"](around:${radiusM},${lat},${lon});
  way["amenity"~"^(shelter|community_centre|public_building)$"](around:${radiusM},${lat},${lon});
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"](around:${radiusM},${lat},${lon});
);
out body;
>;
out skel qt;
`;
}

/**
 * Fetch from Overpass with mirror fallback.
 */
async function queryOverpass(query) {
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const resp = await fetchWithTimeout(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      }, OVERPASS_TIMEOUT * 1000 + 5000);

      if (!resp.ok) {
        console.warn(`Overpass ${new URL(mirror).hostname}: HTTP ${resp.status}`);
        continue;
      }
      return await resp.json();
    } catch (e) {
      console.warn(`Overpass ${new URL(mirror).hostname}: ${e.message}`);
    }
  }
  throw new Error('All Overpass mirrors failed');
}

/**
 * Parse Overpass response into structured data.
 */
function parseOverpass(data) {
  const nodes = {};
  const ways = [];
  const hospitals = [];
  const shelters = [];
  const settlements = [];

  for (const elem of data.elements || []) {
    if (elem.type === 'node') {
      nodes[elem.id] = [Math.round(elem.lat * 1e6) / 1e6, Math.round(elem.lon * 1e6) / 1e6];

      const tags = elem.tags || {};
      if (tags.amenity === 'hospital') {
        hospitals.push({
          id: elem.id,
          lat: Math.round(elem.lat * 1e6) / 1e6,
          lon: Math.round(elem.lon * 1e6) / 1e6,
          name: tags.name || 'Hospital',
        });
      } else if (['shelter', 'community_centre', 'public_building'].includes(tags.amenity) ||
        ['assembly_point', 'shelter'].includes(tags.emergency)) {
        shelters.push({
          id: elem.id,
          lat: Math.round(elem.lat * 1e6) / 1e6,
          lon: Math.round(elem.lon * 1e6) / 1e6,
          name: tags.name || 'Shelter',
        });
      } else if (tags.place) {
        settlements.push({
          id: elem.id,
          lat: Math.round(elem.lat * 1e6) / 1e6,
          lon: Math.round(elem.lon * 1e6) / 1e6,
          name: tags.name || tags.place,
          type: tags.place,
        });
      }
    } else if (elem.type === 'way') {
      const tags = elem.tags || {};
      if (tags.highway) {
        const coords = [];
        for (const nid of elem.nodes || []) {
          if (nodes[nid]) coords.push(nodes[nid]);
        }
        if (coords.length >= 2) {
          ways.push({
            id: elem.id,
            coords,
            highway: tags.highway,
            name: tags.name || '',
            oneway: tags.oneway || 'no',
          });
        }
      } else if (tags.amenity === 'hospital') {
        const wayNodes = elem.nodes || [];
        const lats = wayNodes.map(n => nodes[n]?.[0]).filter(Boolean);
        const lons = wayNodes.map(n => nodes[n]?.[1]).filter(Boolean);
        if (lats.length && lons.length) {
          hospitals.push({
            id: elem.id,
            lat: Math.round(lats.reduce((a, b) => a + b) / lats.length * 1e6) / 1e6,
            lon: Math.round(lons.reduce((a, b) => a + b) / lons.length * 1e6) / 1e6,
            name: tags.name || 'Hospital',
          });
        }
      } else if (['shelter', 'community_centre', 'public_building'].includes(tags.amenity)) {
        const wayNodes = elem.nodes || [];
        const lats = wayNodes.map(n => nodes[n]?.[0]).filter(Boolean);
        const lons = wayNodes.map(n => nodes[n]?.[1]).filter(Boolean);
        if (lats.length && lons.length) {
          shelters.push({
            id: elem.id,
            lat: Math.round(lats.reduce((a, b) => a + b) / lats.length * 1e6) / 1e6,
            lon: Math.round(lons.reduce((a, b) => a + b) / lons.length * 1e6) / 1e6,
            name: tags.name || 'Shelter',
          });
        }
      }
    }
  }

  return { ways, hospitals, shelters, settlements, node_count: Object.keys(nodes).length, way_count: ways.length };
}

/**
 * Fetch OSM data around a point with auto-expanding radius.
 * @param {number} lat
 * @param {number} lon
 * @param {function} onStatus - callback for status updates
 * @returns {Promise<object>} parsed OSM data
 */
export async function fetchLocalData(lat, lon, onStatus = () => {}) {
  const cacheKey = `${Math.round(lat * 1000)}_${Math.round(lon * 1000)}`;

  // Check IndexedDB cache
  const cached = await getCached(cacheKey);
  if (cached) {
    onStatus('Using cached road data');
    return cached;
  }

  // Try expanding radii
  for (let i = 0; i < FETCH_RADII.length; i++) {
    const radius = FETCH_RADII[i];
    onStatus(`Fetching roads, ${radius / 1000} km radius`);

    try {
      const query = buildQuery(lat, lon, radius);
      const raw = await queryOverpass(query);
      const parsed = parseOverpass(raw);

      // Check if we have any reachable facilities
      const hasFacilities = parsed.hospitals.length > 0 || parsed.shelters.length > 0;
      if (!hasFacilities && i < FETCH_RADII.length - 1) {
        onStatus(`No facilities found at ${radius / 1000} km, expanding`);
        continue;
      }

      // Cache result
      await setCache(cacheKey, parsed);
      return parsed;
    } catch (e) {
      console.warn(`Overpass fetch failed at ${radius}m: ${e.message}`);

      // Try demo cache as fallback
      const demo = findDemoCache(lat, lon);
      if (demo) {
        onStatus('Using pre-cached demo data');
        return demo;
      }

      if (i < FETCH_RADII.length - 1) {
        onStatus(`Fetch failed at ${radius / 1000} km, retrying larger area`);
        continue;
      }
    }
  }

  // Final fallback: demo cache
  const demo = findDemoCache(lat, lon);
  if (demo) {
    onStatus('Overpass unavailable, using demo data');
    return demo;
  }

  throw new Error('Could not fetch road data. Overpass API may be unavailable.');
}
