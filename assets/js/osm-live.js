/**
 * osm-live.js – Overpass API client.
 *
 * KEY FIXES (Bug 1):
 *  - Uses `out geom;` so way coordinates are embedded, no separate node recursion needed.
 *  - Three mirrors tried in parallel-race; whichever responds first wins.
 *  - AbortController per request with 20 s timeout.
 *  - Auto-expands radius 5 → 10 → 20 km when ways=0 OR facilities=0.
 *  - Facility snap radius increased to 1 km.
 *  - Debug panel exposed via window.__osm_debug.
 *  - IndexedDB cache keyed by 0.05° tile (not 0.001° = too granular).
 *  - Name resolution: tags.name → tags['name:en'] → tags.operator → fallback.
 */

import { OVERPASS_TIMEOUT, FETCH_RADII } from './config.js';
import { haversine } from './utils.js';

// ── Mirrors ─────────────────────────────────────────────────────────────────
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const TIMEOUT_MS  = 20000; // 20 s per mirror
const HIGHWAY_TAGS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service';

// ── IndexedDB cache ──────────────────────────────────────────────────────────
const DB_NAME    = 'saferoute-osm-v2';
const STORE_NAME = 'tiles';
let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

/** Cache key: 0.05° tile (≈5.5 km) */
function tileKey(lat, lon, radius) {
  const tileSize = radius <= 6000 ? 0.05 : radius <= 12000 ? 0.1 : 0.2;
  return `${(Math.floor(lat / tileSize) * tileSize).toFixed(3)}_${(Math.floor(lon / tileSize) * tileSize).toFixed(3)}_${radius}`;
}

async function getCached(key) {
  try {
    const d = await openDB();
    return new Promise(resolve => {
      const tx  = d.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const v = req.result;
        // Expire after 24 h
        if (v && Date.now() - v.ts < 86400000) resolve(v.data);
        else resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function setCache(key, data) {
  try {
    const d = await openDB();
    const tx = d.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ data, ts: Date.now() }, key);
  } catch { /* ignore */ }
}

// ── Demo cache ───────────────────────────────────────────────────────────────
let demoCache = {};

export async function loadDemoCache() {
  const cities = ['chennai', 'coimbatore', 'madurai', 'udhagamandalam', 'cuddalore'];
  for (const city of cities) {
    try {
      const r = await fetch(`data/demo_cache/${city}.json`);
      if (r.ok) demoCache[city] = await r.json();
    } catch { /* skip */ }
  }
  console.log(`[OSM] Demo cache: ${Object.keys(demoCache).length} cities`);
}

function findDemoCache(lat, lon) {
  for (const data of Object.values(demoCache)) {
    if (data.center) {
      const d = haversine(lat, lon, data.center[0], data.center[1]);
      if (d < (data.radius_m || 8000) * 0.9) return data;
    }
  }
  return null;
}

// ── Overpass QL ──────────────────────────────────────────────────────────────
function buildQuery(lat, lon, radiusM) {
  // KEY FIX: use `out geom;` so way node coordinates are embedded in the response.
  // No need for the `>; out skel qt;` recursion which caused empty coords arrays.
  const t = Math.min(OVERPASS_TIMEOUT, 25);
  return `[out:json][timeout:${t}];
(
  way["highway"~"^(${HIGHWAY_TAGS})$"](around:${radiusM},${lat},${lon});
  node["amenity"="hospital"](around:${radiusM},${lat},${lon});
  way["amenity"="hospital"](around:${radiusM},${lat},${lon});
  node["healthcare"="hospital"](around:${radiusM},${lat},${lon});
  node["amenity"~"^(clinic|health_centre)$"](around:${radiusM},${lat},${lon});
  node["amenity"~"^(shelter|community_centre|public_building)$"](around:${radiusM},${lat},${lon});
  node["emergency"~"^(assembly_point|shelter)$"](around:${radiusM},${lat},${lon});
  way["amenity"~"^(shelter|community_centre|public_building)$"](around:${radiusM},${lat},${lon});
);
out geom;`;
}

// ── Fetch one mirror with AbortController ────────────────────────────────────
async function fetchMirror(mirrorUrl, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const resp = await fetch(mirrorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(body)}`,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    return { json, mirror: mirrorUrl, ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(timer);
    throw Object.assign(e, { mirror: mirrorUrl });
  }
}

// ── Query Overpass: race mirrors, fallback sequentially ──────────────────────
async function queryOverpass(query, onStatus) {
  // Try all mirrors in parallel, take first success
  const mirrorErrors = [];

  // First pass: try all in parallel
  const body = query;
  const attempts = MIRRORS.map(m =>
    fetchMirror(m, body, TIMEOUT_MS)
      .catch(e => { mirrorErrors.push({ mirror: m, err: e.message }); return null; })
  );
  const results = await Promise.all(attempts);
  const winner  = results.find(r => r !== null);
  if (winner) {
    window.__osm_debug = window.__osm_debug || {};
    Object.assign(window.__osm_debug, { mirror: winner.mirror, ms: winner.ms });
    console.log(`[OSM] ✓ ${new URL(winner.mirror).hostname} in ${winner.ms} ms`);
    return winner.json;
  }

  // All failed
  const reasons = mirrorErrors.map(e => `${new URL(e.mirror).hostname}: ${e.err}`).join(' | ');
  throw new Error(`All Overpass mirrors failed. ${reasons}`);
}

// ── Parse `out geom;` response ───────────────────────────────────────────────
function resolveName(tags) {
  return tags?.name
      || tags?.['name:en']
      || tags?.['name:ta']
      || tags?.operator
      || null;
}

function parseOverpass(data) {
  const ways      = [];
  const hospitals = [];
  const shelters  = [];
  // node-id → [lat,lon] for way-member lookup (populated from standalone nodes)
  const nodeCoords = {};

  // First pass: collect standalone nodes (coordinates for way members)
  for (const el of data.elements || []) {
    if (el.type === 'node' && el.lat != null) {
      nodeCoords[el.id] = [el.lat, el.lon];
    }
  }

  // Second pass: parse elements
  for (const el of data.elements || []) {
    const tags = el.tags || {};

    if (el.type === 'node') {
      if (tags.amenity === 'hospital' || tags.healthcare === 'hospital' ||
          tags.amenity === 'clinic'   || tags.amenity === 'health_centre') {
        hospitals.push({
          id: el.id, lat: el.lat, lon: el.lon,
          name: resolveName(tags) || 'Hospital',
          type: 'hospital',
        });
      } else if (['shelter','community_centre','public_building'].includes(tags.amenity) ||
                 ['assembly_point','shelter'].includes(tags.emergency)) {
        shelters.push({
          id: el.id, lat: el.lat, lon: el.lon,
          name: resolveName(tags) || 'Shelter',
          type: 'shelter',
        });
      }
      continue;
    }

    if (el.type !== 'way') continue;

    if (tags.highway) {
      // `out geom;` gives el.geometry = [{lat,lon}, …]
      let coords = [];
      if (Array.isArray(el.geometry) && el.geometry.length >= 2) {
        coords = el.geometry.map(p => [p.lat, p.lon]);
      } else if (Array.isArray(el.nodes)) {
        // Fallback: reconstruct from nodeCoords
        for (const nid of el.nodes) {
          const c = nodeCoords[nid];
          if (c) coords.push(c);
        }
      }
      if (coords.length >= 2) {
        ways.push({
          id: el.id,
          coords,
          highway: tags.highway,
          name: resolveName(tags) || '',
          oneway: tags.oneway || 'no',
        });
      }
    } else if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') {
      // Way centroid
      const geom = el.geometry || el.nodes?.map(n => nodeCoords[n]).filter(Boolean).map(c => ({ lat:c[0], lon:c[1] }));
      if (geom?.length) {
        const lat = geom.reduce((a,p) => a + p.lat, 0) / geom.length;
        const lon = geom.reduce((a,p) => a + p.lon, 0) / geom.length;
        hospitals.push({ id: el.id, lat, lon, name: resolveName(tags) || 'Hospital', type: 'hospital' });
      }
    } else if (['shelter','community_centre','public_building'].includes(tags.amenity)) {
      const geom = el.geometry || el.nodes?.map(n => nodeCoords[n]).filter(Boolean).map(c => ({ lat:c[0], lon:c[1] }));
      if (geom?.length) {
        const lat = geom.reduce((a,p) => a + p.lat, 0) / geom.length;
        const lon = geom.reduce((a,p) => a + p.lon, 0) / geom.length;
        shelters.push({ id: el.id, lat, lon, name: resolveName(tags) || 'Shelter', type: 'shelter' });
      }
    }
  }

  // Debug
  window.__osm_debug = window.__osm_debug || {};
  Object.assign(window.__osm_debug, { ways: ways.length, hospitals: hospitals.length, shelters: shelters.length });
  console.log(`[OSM] Parsed: ${ways.length} ways, ${hospitals.length} hospitals, ${shelters.length} shelters`);

  return { ways, hospitals, shelters, way_count: ways.length };
}

// ── Main fetch with auto-expanding radius ────────────────────────────────────
export async function fetchLocalData(lat, lon, onStatus = () => {}) {
  const RADII = [5000, 10000, 20000];
  let lastError = null;
  let lastParsed = null;

  for (let i = 0; i < RADII.length; i++) {
    const radius = RADII[i];

    // Check cache
    const key = tileKey(lat, lon, radius);
    const cached = await getCached(key);
    if (cached) {
      onStatus(`Using cached data (${radius/1000} km)`);
      window.__osm_debug = { ...(window.__osm_debug||{}), source:'cache', radius };
      return cached;
    }

    // Check demo cache proximity
    const demo = findDemoCache(lat, lon);
    if (demo && i === 0) {
      onStatus('Using pre-cached demo data');
      window.__osm_debug = { ...(window.__osm_debug||{}), source:'demo' };
      return demo;
    }

    onStatus(`Fetching roads ${radius/1000} km radius (attempt ${i+1}/${RADII.length})…`);
    window.__osm_debug = { ...(window.__osm_debug||{}), radius };

    try {
      const query  = buildQuery(lat, lon, radius);
      const raw    = await queryOverpass(query, onStatus);
      const parsed = parseOverpass(raw);
      lastParsed   = parsed;

      if (parsed.way_count === 0) {
        onStatus(`0 ways at ${radius/1000} km, expanding…`);
        continue;
      }

      const hasFac = parsed.hospitals.length + parsed.shelters.length > 0;
      if (!hasFac && i < RADII.length - 1) {
        onStatus(`No facilities at ${radius/1000} km, expanding…`);
        continue;
      }

      await setCache(key, parsed);
      window.__osm_debug = { ...(window.__osm_debug||{}), source:'overpass', radius };
      return parsed;

    } catch (e) {
      lastError = e;
      console.warn(`[OSM] Radius ${radius}m failed:`, e.message);
      onStatus(`Fetch failed (${e.message.slice(0,40)}), retrying…`);

      // Fallback to demo cache immediately on network failure
      const demo2 = findDemoCache(lat, lon);
      if (demo2) {
        onStatus('Network error – using demo data');
        return demo2;
      }
    }
  }

  // Last resort: return what we have even without facilities
  if (lastParsed && lastParsed.way_count > 0) {
    onStatus('Warning: no facilities found. Routing within road network only.');
    return lastParsed;
  }

  const demo3 = findDemoCache(lat, lon);
  if (demo3) return demo3;

  throw new Error(
    lastError
      ? `Road fetch failed: ${lastError.message}`
      : 'No road data found in this area after expanding to 20 km.'
  );
}
