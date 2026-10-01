/**
 * app.js – SafeRoute TN – Google Maps-style emergency routing.
 *
 * BUGS FIXED:
 *  Bug 1: Proper Overpass fetch (delegated to osm-live.js). Snap up to 5 km.
 *         If no facility, retry with ignoreOneway. Auto-expand radius.
 *         Retry button on failure. Debug panel on ?debug=1.
 *  Bug 2: Named destinations everywhere. Reverse-geocode bare-coord origins/dests.
 *  Bug 4: Top progress bar, AbortController cancels in-flight requests.
 *  Bug 5: Layout – controls positioned cleanly, sidebar consistent padding.
 */

import { NOMINATIM_URL, DATA_PATH, DEFAULT_LAMBDA } from './config.js';
import { loadRegionRasters, createHazardCanvas, getBbox, sampleAt, compositeRisk, isLoaded } from './hazard-raster.js';
import { initWeightsFromMeta, getWeights } from './risk.js';
import { loadDemoCache, fetchLocalData } from './osm-live.js';
import { buildGraph, buildGraphIgnoreOneway, findNearest } from './graph.js';
import { dijkstra, shortestPath, routeToCoords, compareRoutes } from './router.js';
import { debounce, inBbox, classifyRisk, riskLabel, formatDist, formatRisk, fetchWithTimeout } from './utils.js';

// ─── Map styles ─────────────────────────────────────────────────────────────
const STYLE_STREET = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const STYLE_SAT = {
  version: 8,
  sources: {
    'esri-sat': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256, attribution: 'Tiles © Esri',
    },
    'carto-labels': {
      type: 'raster',
      tiles: ['https://tiles.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png'],
      tileSize: 256, attribution: '© CARTO',
    },
  },
  layers: [
    { id: 'sat', type: 'raster', source: 'esri-sat' },
    { id: 'labels', type: 'raster', source: 'carto-labels', paint: { 'raster-opacity': 0.85 } },
  ],
};

// ─── State ───────────────────────────────────────────────────────────────────
let map           = null;
let isSatellite   = false;
let selectedHazard = 'composite';
let destType      = 'either';
let lambda        = DEFAULT_LAMBDA;
let originPoint   = null;   // { lat, lon, label }
let destPoint     = null;   // { lat, lon, label } — null = nearest facility
let graph         = null;
let osmData       = null;
let isRouting     = false;
let routeAbortCtrl = null;

const DEBUG = new URLSearchParams(location.search).has('debug');

// ─── DOM ─────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const on = (el, ev, fn) => el?.addEventListener(ev, fn);

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, { spinner = false, error = false, dur = 0, retry = null } = {}) {
  const el = $('toast');
  $('t-msg').textContent = msg;
  $('t-spin').style.display = spinner ? 'block' : 'none';
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (dur > 0) toastTimer = setTimeout(() => el.classList.remove('show'), dur);
  const rb = $('t-retry');
  if (rb) {
    rb.style.display = retry ? 'inline-block' : 'none';
    rb.onclick = retry || null;
  }
}
function hideToast() { $('toast').classList.remove('show'); }

// ─── Progress bar ─────────────────────────────────────────────────────────────
function loadProg(pct, msg) {
  const bar = $('load-bar'); if (bar) bar.style.width = pct + '%';
  const txt = $('load-text'); if (txt) txt.textContent = msg;
}
function dismissLoader() {
  const el = $('loading');
  if (!el) return;
  el.classList.add('out');
  setTimeout(() => el.style.display = 'none', 500);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  loadProg(15, 'Initializing map…');

  map = new maplibregl.Map({
    container: 'map',
    style: STYLE_STREET,
    center: [78.6, 11.0],
    zoom: 7,
    pitch: 0, bearing: 0,
    attributionControl: true,
  });

  const nav = new maplibregl.NavigationControl({ showCompass: true, showZoom: true });
  map.addControl(nav, 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  // Move controls to custom containers
  setTimeout(() => {
    const navEl = document.querySelector('.maplibregl-ctrl-top-right .maplibregl-ctrl-group');
    if (navEl) document.querySelector('.mc-top').prepend(navEl);
    
    const attrEl = document.querySelector('.maplibregl-ctrl-attrib');
    if (attrEl) $('custom-attrib-container').appendChild(attrEl);
  }, 100);

  await new Promise(r => map.on('load', r));

  map.addSource('terrain-dem', {
    type: 'raster-dem',
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    encoding: 'terrarium', tileSize: 256, maxzoom: 15,
  });

  loadProg(40, 'Loading hazard rasters…');
  let meta = null;
  try {
    meta = await loadRegionRasters('tamil_nadu', DATA_PATH);
    initWeightsFromMeta(meta);
    loadProg(65, 'Rendering hazard overlay…');
    updateHazardOverlay();
    $('legend').classList.add('visible');
  } catch (e) { console.warn('[Boot] Hazard rasters:', e); }

  loadProg(75, 'Loading districts…');
  // Lazy: don't block boot on districts
  loadDistrictsLazy();

  loadDemoCache();
  if (meta) fillMeth(meta);

  loadProg(90, 'Locating you…');
  wireUI();

  if (DEBUG) mountDebugPanel();

  // Auto-geolocate
  try {
    const pos = await getGPS();
    originPoint = { lat: pos.lat, lon: pos.lon, label: 'Your location' };
    $('origin-input').value = 'Your location';
    setHasValue($('origin-row'), true);
    map.flyTo({ center: [pos.lon, pos.lat], zoom: 13, duration: 1500 });
    addOriginMarker(pos.lat, pos.lon);
    updateRiskReadout(pos.lat, pos.lon);
    // Reverse geocode the GPS point
    reverseGeocode(pos.lat, pos.lon).then(name => {
      if (name) { originPoint.label = name; $('origin-input').value = name; }
    });
    loadProg(100, 'Ready!');
    dismissLoader();
    showInstruction('Choose a hazard and tap map or search for destination');
  } catch {
    loadProg(100, 'Ready!');
    dismissLoader();
    showInstruction('Tap your location on the map or search a place');
  }
}

// ─── GPS ─────────────────────────────────────────────────────────────────────
function getGPS() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      rej,
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// ─── Instruction flash ────────────────────────────────────────────────────────
let instrTimer;
function showInstruction(msg, dur = 4000) {
  const el = $('map-instruction');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(instrTimer);
  if (dur > 0) instrTimer = setTimeout(() => el.classList.remove('show'), dur);
}

// ─── Hazard overlay ──────────────────────────────────────────────────────────
const _debHazard = debounce(_renderHazard, 60);
function updateHazardOverlay(mode) {
  selectedHazard = mode || selectedHazard;
  _debHazard();
}
function _renderHazard() {
  if (!isLoaded() || !map.isStyleLoaded()) return;
  const canvas = createHazardCanvas(selectedHazard, getWeights());
  const bbox   = getBbox();
  if (!canvas || !bbox) return;
  if (map.getLayer('hazard-layer')) map.removeLayer('hazard-layer');
  if (map.getSource('hazard-src'))  map.removeSource('hazard-src');
  map.addSource('hazard-src', {
    type: 'image',
    url: canvas.toDataURL('image/png'),
    coordinates: [[bbox[0],bbox[3]],[bbox[2],bbox[3]],[bbox[2],bbox[1]],[bbox[0],bbox[1]]],
  });
  map.addLayer({ id:'hazard-layer', type:'raster', source:'hazard-src',
    paint: { 'raster-opacity': 0.5, 'raster-fade-duration': 300 }
  }, getFirstLabelLayer());
}

function getFirstLabelLayer() {
  if (!map?.isStyleLoaded()) return undefined;
  for (const l of map.getStyle().layers)
    if (l.type === 'symbol' && l.layout?.['text-field']) return l.id;
}

// ─── Districts (lazy) ─────────────────────────────────────────────────────────
function loadDistrictsLazy() {
  requestAnimationFrame(async () => {
    try {
      const r = await fetch(`${DATA_PATH}/tamil_nadu/districts.geojson`);
      if (r.ok) addDistrictLayer(await r.json());
    } catch (e) { console.warn('[Boot] Districts:', e); }
  });
}

function addDistrictLayer(geojson) {
  if (!map?.isStyleLoaded()) return;
  ['d3d','d-line'].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
  if (map.getSource('districts')) map.removeSource('districts');
  map.addSource('districts', { type: 'geojson', data: geojson });
  map.addLayer({ id:'d3d', type:'fill-extrusion', source:'districts', maxzoom:9,
    paint: {
      'fill-extrusion-color': ['match',['get','risk_class'],
        'very_low','#0d9f63','low','#34a853','moderate','#f9ab00','high','#ea4335','very_high','#c5221f','#ccc'],
      'fill-extrusion-height': ['*',['get','composite_risk'],50000],
      'fill-extrusion-opacity': ['interpolate',['linear'],['zoom'],6,0.45,9,0],
    }
  });
  map.addLayer({ id:'d-line', type:'line', source:'districts', maxzoom:10,
    paint: { 'line-color':'#aaa','line-width':0.6,
      'line-opacity':['interpolate',['linear'],['zoom'],6,0.5,10,0] }
  });
  map.on('click','d3d', e => {
    if (!e.features?.length) return;
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset:8 })
      .setHTML(`<b>${p.name}</b><br>Risk: ${(p.composite_risk*100).toFixed(1)}% · ${(p.risk_class||'').replace(/_/g,' ')}`)
      .setLngLat(e.lngLat).addTo(map);
  });
  map.on('mouseenter','d3d', () => { map.getCanvas().style.cursor='pointer'; });
  map.on('mouseleave','d3d', () => { map.getCanvas().style.cursor=''; });
}

// ─── Markers ─────────────────────────────────────────────────────────────────
let _originMarker = null;
let _destMarkers  = [];
let _allPopups    = [];

function addOriginMarker(lat, lon) {
  _originMarker?.remove();
  const el = document.createElement('div');
  el.className = 'm-origin';
  _originMarker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([lon, lat]).addTo(map);
  _originMarker.on('dragend', () => {
    const ll = _originMarker.getLngLat();
    originPoint = { lat: ll.lat, lon: ll.lng, label: 'Custom location' };
    $('origin-input').value = 'Custom location';
    updateRiskReadout(ll.lat, ll.lng);
    reverseGeocode(ll.lat, ll.lng).then(name => {
      if (name) { originPoint.label = name; $('origin-input').value = name; }
    });
    if (destPoint || graph) autoRoute();
  });
}

function clearMarkers() {
  _destMarkers.forEach(m => m.remove());
  _destMarkers = [];
  _allPopups.forEach(p => p.remove());
  _allPopups = [];
}

function addDestMarker(lat, lon, name, type) {
  const el = document.createElement('div');
  el.className = `m-dest m-dest--${type || 'hospital'}`;
  el.title = name;
  const marker = new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat]).addTo(map);
  const popup = new maplibregl.Popup({ offset: 20, closeButton: false, maxWidth: '220px' })
    .setHTML(`<b style="font-size:13px">${name}</b><br><small style="color:#5f6368">${(type||'facility').replace('_',' ')}</small>`)
    .setLngLat([lon, lat]).addTo(map);
  _destMarkers.push(marker);
  _allPopups.push(popup);
}

// ─── Risk readout ─────────────────────────────────────────────────────────────
function updateRiskReadout(lat, lon) {
  if (!isLoaded()) return;
  const weights = getWeights();
  const sample  = sampleAt(lat, lon);
  if (!sample || !sample.landMask) return;
  const comp = compositeRisk(sample, weights);
  if (comp === null) return;

  const cls = classifyRisk(comp);
  const colorMap = { very_low:'#0d9f63', low:'#34a853', moderate:'#f9ab00', high:'#ea4335', very_high:'#c5221f' };
  const col = colorMap[cls] || '#999';

  const rp = $('risk-pill');
  if (!rp) return;
  rp.style.display = 'block';

  $('rp-composite').textContent = `${(comp*100).toFixed(1)}%`;
  $('rp-composite').style.color = col;
  $('rp-label').textContent = riskLabel(cls) + ' risk';
  $('rp-label').style.color = col;

  const layers = [
    { label:'Flood',     val: sample.flood },
    { label:'Landslide', val: sample.landslide },
    { label:'Slope',     val: sample.slope },
    { label:'Exposure',  val: sample.exposure },
  ];
  $('rp-bars').innerHTML = layers.map(l => {
    const lc = colorMap[classifyRisk(l.val)] || '#999';
    return `<div class="risk-bar-row">
      <span class="risk-bar-lbl">${l.label}</span>
      <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${l.val*100}%;background:${lc}"></div></div>
      <span class="risk-bar-val">${(l.val*100).toFixed(0)}%</span>
    </div>`;
  }).join('');
}

// ─── Reverse geocode (Bug 2 fix: named origin/dest) ───────────────────────────
const _revCache = new Map();
let _lastRevTime = 0;
async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (_revCache.has(key)) return _revCache.get(key);

  // Rate-limit to 1 req/s
  const now = Date.now();
  if (now - _lastRevTime < 1000) await new Promise(r => setTimeout(r, 1000 - (now - _lastRevTime)));
  _lastRevTime = Date.now();

  try {
    const r = await fetchWithTimeout(
      `${NOMINATIM_URL}?format=json&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`,
      { headers: { 'User-Agent': 'SafeRoute-TN/1.0' } }, 6000
    );
    if (!r.ok) return null;
    const d = await r.json();
    const a = d.address || {};
    const name = d.name
      || a.road || a.suburb || a.neighbourhood
      || a.village || a.town || a.city
      || null;
    if (name) _revCache.set(key, name);
    return name;
  } catch { return null; }
}

// ─── Facility name enrichment (Bug 2) ────────────────────────────────────────
async function enrichFacilityName(lat, lon, existingName, type) {
  if (existingName && existingName !== 'Hospital' && existingName !== 'Shelter') return existingName;
  const geoName = await reverseGeocode(lat, lon);
  if (geoName) return `${type === 'hospital' ? 'Hospital' : 'Shelter'} near ${geoName}`;
  return existingName || `${type === 'hospital' ? 'Hospital' : 'Shelter'}`;
}

// ─── Targeted Dijkstra (origin → specific node) ───────────────────────────────
function dijkstraToTarget(nodes, startKey, targetKey, lam = 3) {
  const dist = new Map();
  const prev = new Map();
  const prevEdge = new Map();
  const visited = new Set();
  const heap = [{ key: startKey, cost: 0 }];
  const push = item => { heap.push(item); heap.sort((a,b) => a.cost - b.cost); };

  dist.set(startKey, 0);

  while (heap.length) {
    const { key, cost } = heap.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    if (key === targetKey) break;

    const node = nodes.get(key);
    if (!node) continue;
    for (const edge of node.edges) {
      if (visited.has(edge.to)) continue;
      const nc = cost + edge.dist * (1 + lam * edge.risk);
      if (!dist.has(edge.to) || nc < dist.get(edge.to)) {
        dist.set(edge.to, nc);
        prev.set(edge.to, key);
        prevEdge.set(edge.to, edge);
        push({ key: edge.to, cost: nc });
      }
    }
  }

  if (!dist.has(targetKey)) return null;

  const path = [], pathEdges = [];
  let cur = targetKey;
  while (cur && cur !== undefined) {
    path.unshift(cur);
    const e = prevEdge.get(cur);
    if (e) pathEdges.unshift(e);
    cur = prev.get(cur);
    if (!cur || cur === path[0]) break;
  }

  let td = 0, tr = 0, maxR = 0, vhc = 0;
  for (const e of pathEdges) {
    td += e.dist; tr += e.risk * e.dist;
    if (e.risk > maxR) maxR = e.risk;
    if (classifyRisk(e.risk) === 'very_high') vhc++;
  }
  const meanRisk = td > 0 ? tr / td : 0;
  const targetNode = nodes.get(targetKey);

  return { path, edges: pathEdges, dest: targetNode,
    stats: { distance: td, meanRisk, maxRisk: maxR, veryHighSegments: vhc, segmentCount: pathEdges.length } };
}

// ─── Main routing ─────────────────────────────────────────────────────────────
async function autoRoute() {
  if (!originPoint) return;
  if (isRouting) {
    routeAbortCtrl?.abort();
    await new Promise(r => setTimeout(r, 100));
  }
  isRouting = true;
  routeAbortCtrl = new AbortController();

  clearRoutes();
  clearMarkers();
  $('route-result').classList.remove('visible');
  $('route-cards-container').innerHTML = '';

  addOriginMarker(originPoint.lat, originPoint.lon);

  if (destPoint) {
    const sw = [Math.min(originPoint.lon,destPoint.lon)-0.02, Math.min(originPoint.lat,destPoint.lat)-0.02];
    const ne = [Math.max(originPoint.lon,destPoint.lon)+0.02, Math.max(originPoint.lat,destPoint.lat)+0.02];
    map.fitBounds([sw,ne], { padding:{ top:80, bottom:80, left:440, right:80 }, duration:1000 });
  } else {
    map.flyTo({ center:[originPoint.lon,originPoint.lat], zoom:13, duration:1000 });
  }

  try {
    toast('Fetching road network…', { spinner:true });

    osmData = await fetchLocalData(originPoint.lat, originPoint.lon, s => toast(s, { spinner:true }));
    if (!osmData?.way_count) {
      toast('No roads found', { error:true, dur:0, retry: autoRoute });
      return;
    }

    toast(`Building graph (${osmData.way_count} roads)…`, { spinner:true });
    const weights = getWeights();
    graph = buildGraph(osmData, weights);

    if (DEBUG) updateDebugPanel();

    addFacilityDots(osmData.hospitals || [], osmData.shelters || []);

    toast('Finding safest route…', { spinner:true });

    // Snap start — expand up to 5 km
    let startNode = findNearest(graph.nodeIndex, graph.nodes, originPoint.lat, originPoint.lon, 2000);
    if (!startNode) startNode = findNearest(graph.nodeIndex, graph.nodes, originPoint.lat, originPoint.lon, 5000);
    if (!startNode) {
      toast('No road within 5 km of your location.', { error:true, dur:8000, retry: autoRoute });
      return;
    }

    let safest, shortest;

    if (destPoint) {
      let endNode = findNearest(graph.nodeIndex, graph.nodes, destPoint.lat, destPoint.lon, 3000);
      if (!endNode) endNode = findNearest(graph.nodeIndex, graph.nodes, destPoint.lat, destPoint.lon, 5000);
      if (!endNode) { toast('No road near destination (5 km search).', { error:true, dur:8000 }); return; }

      safest  = dijkstraToTarget(graph.nodes, startNode.key, endNode.key, lambda);
      shortest = dijkstraToTarget(graph.nodes, startNode.key, endNode.key, 0);

      const destName = destPoint.label?.includes(',')
        ? destPoint.label.split(',').slice(0,2).join(', ')
        : destPoint.label || 'Destination';

      const destInfo = { lat: endNode.lat, lon: endNode.lon, facilityName: destName, facilityType: 'custom_dest' };
      if (safest) safest.dest = destInfo;
      if (shortest) shortest.dest = destInfo;

    } else {
      safest  = dijkstra(graph.nodes, startNode.key, lambda, false, destType);
      shortest = shortestPath(graph.nodes, startNode.key, destType);

      // If no facility reachable, try ignoring oneway restrictions
      if (!safest) {
        toast('No facility reachable with oneway rules, retrying…', { spinner:true });
        const g2 = buildGraphIgnoreOneway(osmData, weights);
        const s2 = findNearest(g2.nodeIndex, g2.nodes, originPoint.lat, originPoint.lon, 5000);
        if (s2) {
          safest   = dijkstra(g2.nodes, s2.key, lambda, false, destType);
          shortest = shortestPath(g2.nodes, s2.key, destType);
          if (safest) graph = g2; // use the relaxed graph
          toast('Note: some one-way restrictions ignored to find route.', { dur:5000 });
        }
      }
    }

    if (!safest) {
      toast(`No ${destType==='either'?'hospital or shelter':destType} reachable. Try larger area?`, {
        error:true, dur:0, retry: autoRoute
      });
      return;
    }

    // Bug 2: Enrich facility name
    if (safest.dest && (safest.dest.facilityName === 'Hospital' || safest.dest.facilityName === 'Shelter' || !safest.dest.facilityName)) {
      safest.dest.facilityName = await enrichFacilityName(
        safest.dest.lat, safest.dest.lon,
        safest.dest.facilityName, safest.dest.facilityType
      );
    }

    // Draw routes
    const safeCoords  = routeToCoords(safest.path, graph.nodes);
    const altCoords   = shortest ? routeToCoords(shortest.path, graph.nodes) : null;
    drawRoutes(safeCoords, altCoords);

    // Dest marker + dest field
    const dest = safest.dest;
    if (dest) {
      addDestMarker(dest.lat, dest.lon, dest.facilityName, dest.facilityType);
      if (!destPoint) {
        $('dest-input').value = dest.facilityName;
        setHasValue($('dest-row'), true);
      }
    }

    showRouteCards(safest, shortest);
    hideToast();

  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('[Route]', e);
    toast(e.message || 'Routing failed.', { error:true, dur:0, retry: autoRoute });
  } finally {
    isRouting = false;
  }
}

// ─── Route cards (Bug 2: named) ───────────────────────────────────────────────
function showRouteCards(safest, shortest) {
  const s = safest.stats;
  const colorMap = { very_low:'#0d9f63', low:'#34a853', moderate:'#f9ab00', high:'#ea4335', very_high:'#c5221f' };
  const riskCol  = v => colorMap[classifyRisk(v)] || '#999';
  const dest     = safest.dest || {};
  const destName = dest.facilityName || 'Destination';
  const destT    = dest.facilityType || 'hospital';
  const destIcon = destT === 'hospital' ? '🏥' : (destT === 'custom_dest' ? '📍' : '🏛');

  const haversineKm = (a, b) => {
    const [la,loa,lb,lob] = [a.lat, a.lon, b?.lat||a.lat, b?.lon||a.lon];
    const R=6371, dLat=(lb-la)*Math.PI/180, dLon=(lob-loa)*Math.PI/180;
    const x = Math.sin(dLat/2)**2 + Math.cos(la*Math.PI/180)*Math.cos(lb*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  };
  const straightKm = originPoint && dest.lat ? haversineKm(originPoint, dest) : 0;
  const eta = m => `${Math.max(1, Math.round(m / 1000 * 1.8))} min`;

  let html = `<div style="padding:12px 16px 0;font-size:12px;color:#5f6368;font-weight:600;text-transform:uppercase;letter-spacing:.4px">Route Results</div>`;

  // Safest card
  html += `<div class="route-card route-card--active" style="margin:8px 16px 0">
    <div class="route-card-header">
      <span class="route-badge route-badge--safe">✅ Safest Route</span>
      ${straightKm > 0 ? `<span style="font-size:11px;color:#5f6368">${straightKm.toFixed(1)} km straight</span>` : ''}
    </div>
    <div class="route-dest-name">${destIcon} ${destName}</div>
    <div class="route-dest-type">${destT.replace('_',' ')} · ${formatDist(s.distance)} by road</div>
    <div class="route-stats">
      <div class="route-stat"><span class="route-stat-val">${formatDist(s.distance)}</span><span class="route-stat-lbl">Distance</span></div>
      <div class="route-stat"><span class="route-stat-val" style="color:${riskCol(s.meanRisk)}">${formatRisk(s.meanRisk)}</span><span class="route-stat-lbl">Avg Risk</span></div>
      <div class="route-stat"><span class="route-stat-val">${eta(s.distance)}</span><span class="route-stat-lbl">Est. time</span></div>
    </div>
  </div>`;

  if (shortest?.stats) {
    const sh = shortest.stats;
    const shDest = shortest.dest || dest;
    html += `<div class="route-card" style="margin:8px 16px 0">
      <div class="route-card-header">
        <span class="route-badge route-badge--alt">Shortest Route</span>
      </div>
      <div class="route-dest-name">${destIcon} ${shDest.facilityName || destName}</div>
      <div class="route-dest-type">Alternative · ${formatDist(sh.distance)} by road</div>
      <div class="route-stats">
        <div class="route-stat"><span class="route-stat-val">${formatDist(sh.distance)}</span><span class="route-stat-lbl">Distance</span></div>
        <div class="route-stat"><span class="route-stat-val" style="color:${riskCol(sh.meanRisk)}">${formatRisk(sh.meanRisk)}</span><span class="route-stat-lbl">Avg Risk</span></div>
        <div class="route-stat"><span class="route-stat-val">${eta(sh.distance)}</span><span class="route-stat-lbl">Est. time</span></div>
      </div>
    </div>`;
  }

  const rec = compareRoutes(safest, shortest);
  if (rec) html += `<div class="route-rec" style="margin:8px 16px 12px">💡 ${rec}</div>`;

  $('route-cards-container').innerHTML = html;
  $('route-result').classList.add('visible');
}

// ─── Map route drawing ─────────────────────────────────────────────────────────
function clearRoutes() {
  ['r-alt','r-safe-glow','r-safe'].forEach(id => {
    if (map?.getLayer(id)) map.removeLayer(id);
    if (map?.getSource(id)) map.removeSource(id);
  });
}

function drawRoutes(safeCoords, altCoords) {
  clearRoutes();
  const addLine = (id, coords, color, width, dash, blur=0, opacity=1) => {
    if (!coords?.length) return;
    const data = { type:'Feature', geometry:{ type:'LineString', coordinates:coords }};
    if (map.getSource(id)) map.getSource(id).setData(data);
    else map.addSource(id, { type:'geojson', data });
    const paint = { 'line-color':color, 'line-width':width, 'line-opacity':opacity };
    if (dash) paint['line-dasharray'] = dash;
    if (blur) paint['line-blur'] = blur;
    if (!map.getLayer(id)) map.addLayer({ id, type:'line', source:id, layout:{'line-cap':'round','line-join':'round'}, paint }, getFirstLabelLayer());
    else Object.entries(paint).forEach(([k,v]) => map.setPaintProperty(id,k,v));
  };
  addLine('r-alt',       altCoords,  '#9aa0a6', 4, [6,4], 0, 0.55);
  addLine('r-safe-glow', safeCoords, '#1a73e8', 14, null, 10, 0.18);
  addLine('r-safe',      safeCoords, '#1a73e8', 5,  null, 0,  0.95);
}

// ─── Facility dots ─────────────────────────────────────────────────────────────
function addFacilityDots(hospitals, shelters) {
  ['hospitals-layer','shelters-layer'].forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  });
  const addDots = (id, items, color) => {
    if (!items.length) return;
    map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection',
      features: items.map(f => ({ type:'Feature',
        geometry:{ type:'Point', coordinates:[f.lon,f.lat] },
        properties:{ name:f.name } }))
    }});
    map.addLayer({ id:`${id}-layer`, type:'circle', source:id,
      paint:{ 'circle-radius':6,'circle-color':color,'circle-stroke-width':2,'circle-stroke-color':'#fff','circle-opacity':.9 }
    });
    // Popup on click
    map.on('click',`${id}-layer`, e => {
      if (!e.features?.length) return;
      new maplibregl.Popup({ offset:8 })
        .setHTML(`<b>${e.features[0].properties.name}</b>`)
        .setLngLat(e.lngLat).addTo(map);
    });
    map.on('mouseenter',`${id}-layer`, () => { map.getCanvas().style.cursor='pointer'; });
    map.on('mouseleave',`${id}-layer`, () => { map.getCanvas().style.cursor=''; });
  };
  addDots('hospitals', hospitals, '#ea4335');
  addDots('shelters',  shelters,  '#1a73e8');
}

// ─── Satellite toggle ──────────────────────────────────────────────────────────
async function setSatellite(sat) {
  isSatellite = sat;
  $('btn-street').classList.toggle('active', !sat);
  $('btn-sat').classList.toggle('active', sat);
  map.setStyle(sat ? STYLE_SAT : STYLE_STREET);
  await new Promise(r => map.once('styledata', r));
  await new Promise(r => setTimeout(r, 400));
  // Re-add terrain
  if (!map.getSource('terrain-dem')) {
    map.addSource('terrain-dem', { type:'raster-dem',
      tiles:['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding:'terrarium', tileSize:256, maxzoom:15 });
  }
  updateHazardOverlay();
  loadDistrictsLazy();
  if (osmData) addFacilityDots(osmData.hospitals||[], osmData.shelters||[]);
}

// ─── Search ────────────────────────────────────────────────────────────────────
async function searchNominatim(q) {
  if (!q || q.length < 2) return [];
  const params = new URLSearchParams({ q, format:'json', countrycodes:'in', limit:'6', addressdetails:'1',
    viewbox:'76.2,8.0,80.4,13.5', bounded:'0' });
  try {
    const r = await fetchWithTimeout(`${NOMINATIM_URL}?${params}`,
      { headers:{ 'User-Agent':'SafeRoute-TN/1.0' } }, 8000);
    if (!r.ok) return [];
    return (await r.json()).map(x => ({
      name: x.display_name.split(',').slice(0,3).join(', '),
      lat: +x.lat, lon: +x.lon,
    }));
  } catch { return []; }
}

function showDropdown(ddEl, items, onSelect) {
  if (!items.length) { ddEl.classList.remove('open'); return; }
  ddEl.innerHTML = items.map((r,i) => `
    <div class="search-drop-item" data-i="${i}">
      <svg class="search-drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
      </svg>${r.name}
    </div>`).join('');
  ddEl.classList.add('open');
  ddEl.querySelectorAll('.search-drop-item').forEach(el =>
    el.addEventListener('click', () => { ddEl.classList.remove('open'); onSelect(items[+el.dataset.i]); })
  );
}

function setHasValue(rowEl, has) { rowEl?.classList.toggle('has-value', !!has); }

// ─── Debug panel ──────────────────────────────────────────────────────────────
function mountDebugPanel() {
  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.style.cssText = 'position:fixed;bottom:8px;left:420px;z-index:500;background:rgba(0,0,0,.75);color:#0f0;font:11px/1.6 monospace;padding:8px 12px;border-radius:6px;pointer-events:none;';
  document.body.appendChild(panel);
}
function updateDebugPanel() {
  const p = $('debug-panel');
  if (!p) return;
  const d = window.__osm_debug || {};
  p.innerHTML = `mirror: ${d.mirror ? new URL(d.mirror).hostname : '—'}<br>
ms: ${d.ms||'—'} · source: ${d.source||'—'} · radius: ${d.radius||'—'} m<br>
ways: ${d.ways||0} · nodes: ${d.nodes||0} · edges: ${d.edges||0}<br>
hospitals: ${d.hospitals||0} · shelters: ${d.shelters||0}`;
}

// ─── Methodology ──────────────────────────────────────────────────────────────
function openMeth() {
  $('meth-overlay').style.cssText = 'display:block;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:600;';
  const dr = $('meth-drawer');
  dr.style.cssText = 'display:block;position:fixed;top:0;right:0;bottom:0;width:min(520px,90vw);background:#fff;z-index:601;overflow-y:auto;padding:24px;box-shadow:0 0 40px rgba(0,0,0,.2);transform:translateX(0)';
}
window.closeMeth = function() {
  $('meth-overlay').style.display = 'none';
  $('meth-drawer').style.display = 'none';
};

function fillMeth(meta) {
  const ahp = meta?.ahp;
  let html = `<h3 style="font-size:15px;font-weight:600;margin:0 0 8px">Data Pipeline</h3>
<p style="font-size:13px;color:#5f6368;line-height:1.7;margin-bottom:16px">
Sentinel-1 SAR, Sentinel-2, SRTM DEM, WorldCover, GHSL Population, MODIS NDVI processed in Google Earth Engine.
</p>
<h3 style="font-size:15px;font-weight:600;margin:0 0 8px">AHP Weights</h3>
<p style="font-size:13px;color:#5f6368;margin-bottom:8px">`;
  if (ahp?.weights) {
    for (const [k,v] of Object.entries(ahp.weights)) html += `<b>${k}</b>: ${(v*100).toFixed(1)}%&emsp;`;
    html += `<br>CR = ${ahp.cr?.toFixed(4)||'N/A'} (< 0.10 ✓)`;
  }
  html += `</p>
<h3 style="font-size:15px;font-weight:600;margin:12px 0 8px">Risk Index</h3>
<code style="font-size:12px;background:#f1f3f4;padding:6px 10px;border-radius:6px;display:block;margin-bottom:12px">R(x,y) = Σ wᵢ · Hazardᵢ(x,y)</code>
<h3 style="font-size:15px;font-weight:600;margin:0 0 8px">Routing</h3>
<p style="font-size:13px;color:#5f6368;line-height:1.7">
OSM road network via Overpass API. Edge cost: <code style="background:#f1f3f4;padding:2px 6px;border-radius:4px">C = dist × (1 + λ × R)</code>.
Dijkstra min-heap finds safest path to nearest hospital/shelter.
</p>`;
  $('meth-content').innerHTML = html;
}

// ─── Wire UI ──────────────────────────────────────────────────────────────────
function wireUI() {
  const originDrop = $('origin-dropdown');
  const destDrop   = $('dest-dropdown');

  // Map click: first click = origin, second = destination
  map.on('click', async e => {
    const feats = map.queryRenderedFeatures(e.point, { layers:['d3d','hospitals-layer','shelters-layer'] });
    if (feats.length) return;

    const { lat, lng: lon } = e.lngLat;

    if (!originPoint) {
      originPoint = { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
      $('origin-input').value = originPoint.label;
      setHasValue($('origin-row'), true);
      addOriginMarker(lat, lon);
      updateRiskReadout(lat, lon);
      // Background reverse-geocode
      reverseGeocode(lat, lon).then(name => {
        if (name) { originPoint.label = name; $('origin-input').value = name; }
      });
      toast('Tap map to set destination, or choose "Route to Nearest"', { dur:4000 });
      return;
    }

    destPoint = { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
    $('dest-input').value = destPoint.label;
    setHasValue($('dest-row'), true);
    updateRiskReadout(lat, lon);
    reverseGeocode(lat, lon).then(name => {
      if (name) { destPoint.label = name; $('dest-input').value = name; }
    });
    autoRoute();
  });

  // Hazard chips
  document.querySelectorAll('.hchip').forEach(chip =>
    chip.addEventListener('click', () => {
      document.querySelectorAll('.hchip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      updateHazardOverlay(chip.dataset.hazard);
      if (originPoint) autoRoute();
    })
  );

  // Dest-type chips
  document.querySelectorAll('.dchip').forEach(chip =>
    chip.addEventListener('click', () => {
      document.querySelectorAll('.dchip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      destType = chip.dataset.dest;
      if (originPoint && !destPoint) autoRoute();
    })
  );

  // Origin input
  const originSearch = debounce(async v => {
    if (v.length < 2) { originDrop.classList.remove('open'); return; }
    showDropdown(originDrop, await searchNominatim(v), r => {
      originPoint = { lat: r.lat, lon: r.lon, label: r.name };
      $('origin-input').value = r.name;
      setHasValue($('origin-row'), true);
      addOriginMarker(r.lat, r.lon);
      map.flyTo({ center:[r.lon,r.lat], zoom:13, duration:900 });
      updateRiskReadout(r.lat, r.lon);
      if (destPoint || graph) autoRoute();
    });
  }, 350);
  on($('origin-input'), 'input', e => { setHasValue($('origin-row'), !!e.target.value); originSearch(e.target.value); });
  on($('origin-clear'), 'click', () => {
    $('origin-input').value = ''; originPoint = null;
    _originMarker?.remove(); _originMarker = null;
    originDrop.classList.remove('open');
    setHasValue($('origin-row'), false);
    $('risk-pill').style.display = 'none';
  });

  // Dest input
  const destSearch = debounce(async v => {
    if (v.length < 2) { destDrop.classList.remove('open'); return; }
    showDropdown(destDrop, await searchNominatim(v), r => {
      destPoint = { lat: r.lat, lon: r.lon, label: r.name };
      $('dest-input').value = r.name;
      setHasValue($('dest-row'), true);
      autoRoute();
    });
  }, 350);
  on($('dest-input'), 'input', e => { setHasValue($('dest-row'), !!e.target.value); destSearch(e.target.value); });
  on($('dest-clear'), 'click', () => {
    $('dest-input').value = ''; destPoint = null;
    _destMarkers.forEach(m => m.remove()); _destMarkers = [];
    destDrop.classList.remove('open');
    setHasValue($('dest-row'), false);
    clearRoutes();
    $('route-result').classList.remove('visible');
  });

  // Swap
  on($('btn-swap'), 'click', () => {
    const oVal = $('origin-input').value, dVal = $('dest-input').value;
    $('origin-input').value = dVal; $('dest-input').value = oVal;
    const tmp = originPoint;
    originPoint = destPoint ? { ...destPoint } : null;
    destPoint   = tmp ? { ...tmp } : null;
    setHasValue($('origin-row'), !!originPoint);
    setHasValue($('dest-row'), !!destPoint);
    if (originPoint) addOriginMarker(originPoint.lat, originPoint.lon);
    if (originPoint && destPoint) autoRoute();
  });

  // GPS
  on($('btn-gps'), 'click', async () => {
    try {
      toast('Getting your location…', { spinner:true });
      const pos = await getGPS();
      originPoint = { lat:pos.lat, lon:pos.lon, label:'Your location' };
      $('origin-input').value = 'Your location';
      setHasValue($('origin-row'), true);
      addOriginMarker(pos.lat, pos.lon);
      map.flyTo({ center:[pos.lon,pos.lat], zoom:14, duration:1200 });
      updateRiskReadout(pos.lat, pos.lon);
      reverseGeocode(pos.lat, pos.lon).then(name => { if (name) { originPoint.label=name; $('origin-input').value=name; } });
      hideToast();
      if (destPoint) autoRoute();
    } catch { toast('Location access denied', { error:true, dur:4000 }); }
  });

  // Satellite
  on($('btn-street'), 'click', () => setSatellite(false));
  on($('btn-sat'),    'click', () => setSatellite(true));

  // Info
  on($('btn-info'), 'click', openMeth);
  on($('meth-overlay'), 'click', closeMeth);

  // Sidebar collapse
  on($('sb-toggle'), 'click', () => {
    const sb = $('sidebar');
    sb.classList.toggle('collapsed');
    $('sb-toggle').textContent = sb.classList.contains('collapsed') ? '›' : '‹';
  });

  // Close dropdowns on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#origin-row')) originDrop?.classList.remove('open');
    if (!e.target.closest('#dest-row'))   destDrop?.classList.remove('open');
  });
}

// ─── Entry ────────────────────────────────────────────────────────────────────
boot().catch(e => {
  console.error('Boot failed:', e);
  dismissLoader();
  toast('Initialization failed. Please refresh.', { error:true, dur:0 });
});
