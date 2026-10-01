/**
 * app.js – SafeRoute TN – Google Maps-style emergency routing.
 *
 * UX Flow:
 *  1. Load → auto-geolocate → fly to user location
 *  2. Sidebar: origin (default = GPS) + destination (type or click map)
 *  3. Select hazard (All / Flood / Landslide / Slope) → overlay updates
 *  4. Route computes automatically when both origin+dest are set
 *     OR when origin is set and "Route To Nearest" is picked
 *  5. Result: safest (blue) + shortest (grey dashed) routes shown
 */

import { OVERPASS_MIRRORS, OVERPASS_TIMEOUT, HIGHWAY_TYPES, FETCH_RADII, NOMINATIM_URL, DATA_PATH, REGIONS_FILE, DEFAULT_WEIGHTS, DEFAULT_LAMBDA } from './config.js';
import { loadRegionRasters, createHazardCanvas, getBbox, getMeta, sampleAt, compositeRisk, isLoaded } from './hazard-raster.js';
import { initWeightsFromMeta, getWeights } from './risk.js';
import { loadDemoCache, fetchLocalData } from './osm-live.js';
import { buildGraph, findNearest, recomputeEdgeRisks } from './graph.js';
import { dijkstra, shortestPath, routeToCoords, compareRoutes } from './router.js';
import { debounce, inBbox, classifyRisk, riskLabel, formatDist, formatRisk, fetchWithTimeout, haversine } from './utils.js';

// ─── Map styles ───────────────────────────────────────────────
const STYLE_STREET = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const STYLE_SAT    = 'https://demotiles.maplibre.org/satellite-style/style.json';
// Fallback hybrid: OpenStreetMap raster over satellite
const STYLE_SAT_FB = {
  version: 8,
  sources: {
    'esri-sat': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256, attribution: 'ESRI World Imagery'
    },
    'osm-labels': {
      type: 'raster',
      tiles: ['https://tiles.stadiamaps.com/tiles/stamen_toner_labels/{z}/{x}/{y}.png?api_key='],
      tileSize: 256, attribution: '© OpenStreetMap'
    }
  },
  layers: [
    { id: 'sat-bg', type: 'raster', source: 'esri-sat' },
    { id: 'osm-lbl', type: 'raster', source: 'osm-labels', paint: { 'raster-opacity': 0.6 } }
  ]
};

// ─── Application state ───────────────────────────────────────
let map = null;
let isSatellite = false;
let selectedHazard = 'composite';
let destType = 'either';
let lambda = DEFAULT_LAMBDA;
let originPoint = null;   // { lat, lon, label }
let destPoint = null;     // { lat, lon, label } — null = route to nearest facility
let graph = null;
let osmData = null;
let isRouting = false;
let clickMode = null;     // 'dest' = next map click sets destination
let pendingRoute = false;

// ─── DOM helpers ─────────────────────────────────────────────
const $  = id => document.getElementById(id);
const on = (el, ev, fn) => el?.addEventListener(ev, fn);

// ─── Toast ───────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, { spinner = false, error = false, dur = 0 } = {}) {
  const el = $('toast');
  $('t-msg').textContent = msg;
  $('t-spin').style.display = spinner ? 'block' : 'none';
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (dur > 0) toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}
function hideToast() { $('toast').classList.remove('show'); }

// ─── Loading progress ─────────────────────────────────────────
function loadProg(pct, msg) {
  $('load-bar').style.width = pct + '%';
  $('load-text').textContent = msg;
}
function dismissLoader() {
  const el = $('loading');
  el.classList.add('out');
  setTimeout(() => el.style.display = 'none', 500);
}

// ─── Boot ────────────────────────────────────────────────────
async function boot() {
  loadProg(15, 'Initializing map…');

  // Init map
  map = new maplibregl.Map({
    container: 'map',
    style: STYLE_STREET,
    center: [78.6, 11.0],
    zoom: 7,
    pitch: 0,
    bearing: 0,
    attributionControl: true,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  loadProg(30, 'Loading hazard data…');

  // Wait for map ready
  await new Promise(resolve => map.on('load', resolve));

  // Add terrain source (for optional 3D)
  map.addSource('terrain-dem', {
    type: 'raster-dem',
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    encoding: 'terrarium', tileSize: 256, maxzoom: 15,
  });

  loadProg(50, 'Loading hazard rasters…');

  // Load hazard data
  let meta = null;
  try {
    meta = await loadRegionRasters('tamil_nadu', DATA_PATH);
    initWeightsFromMeta(meta);
    loadProg(70, 'Processing hazard overlay…');
    updateHazardOverlay();
    $('legend').classList.add('visible');
  } catch (e) {
    console.warn('Hazard rasters failed:', e);
  }

  // Load districts
  loadProg(80, 'Loading district data…');
  try {
    const dr = await fetch(`${DATA_PATH}/tamil_nadu/districts.geojson`);
    if (dr.ok) {
      const districts = await dr.json();
      addDistrictLayer(districts);
    }
  } catch (e) { console.warn('Districts:', e); }

  // Load OSM demo cache
  loadDemoCache();

  // Fill methodology
  if (meta) fillMeth(meta);

  loadProg(90, 'Getting your location…');

  // Wire UI
  wireUI();

  // Auto-geolocate
  try {
    const pos = await getGPS();
    originPoint = { lat: pos.lat, lon: pos.lon, label: 'Your location' };
    $('origin-input').value = 'Your location';
    setHasValue($('origin-row'), true);
    map.flyTo({ center: [pos.lon, pos.lat], zoom: 13, duration: 1500 });
    addOriginMarker(pos.lat, pos.lon);
    updateRiskReadout(pos.lat, pos.lon);
    loadProg(100, 'Ready!');
    dismissLoader();
    showInstruction('Select a hazard, then tap map or search destination');
  } catch (e) {
    // GPS denied – just show Tamil Nadu
    loadProg(100, 'Ready!');
    dismissLoader();
    showInstruction('Set your origin or tap a location on the map');
  }
}

// ─── GPS ─────────────────────────────────────────────────────
function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      e => reject(e),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// ─── Instruction overlay ─────────────────────────────────────
let instrTimer;
function showInstruction(msg, dur = 4000) {
  const el = $('map-instruction');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(instrTimer);
  if (dur > 0) instrTimer = setTimeout(() => el.classList.remove('show'), dur);
}

// ─── Hazard overlay ──────────────────────────────────────────
function updateHazardOverlay(mode) {
  if (!isLoaded()) return;
  mode = mode || selectedHazard;
  const weights = getWeights();
  const canvas = createHazardCanvas(mode, weights);
  const bbox = getBbox();
  if (!canvas || !bbox) return;

  if (map.getLayer('hazard-layer')) map.removeLayer('hazard-layer');
  if (map.getSource('hazard-src')) map.removeSource('hazard-src');

  map.addSource('hazard-src', {
    type: 'image',
    url: canvas.toDataURL('image/png'),
    coordinates: [[bbox[0],bbox[3]],[bbox[2],bbox[3]],[bbox[2],bbox[1]],[bbox[0],bbox[1]]],
  });
  map.addLayer({ id: 'hazard-layer', type: 'raster', source: 'hazard-src',
    paint: { 'raster-opacity': 0.5, 'raster-fade-duration': 300 }
  }, getFirstLabelLayer());
}

function getFirstLabelLayer() {
  if (!map) return undefined;
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && l.layout?.['text-field']) return l.id;
  }
}

// ─── Districts ───────────────────────────────────────────────
function addDistrictLayer(geojson) {
  if (map.getLayer('d3d')) map.removeLayer('d3d');
  if (map.getLayer('d-line')) map.removeLayer('d-line');
  if (map.getSource('districts')) map.removeSource('districts');

  map.addSource('districts', { type: 'geojson', data: geojson });

  map.addLayer({ id: 'd3d', type: 'fill-extrusion', source: 'districts', maxzoom: 9,
    paint: {
      'fill-extrusion-color': ['match',['get','risk_class'],
        'very_low','#0d9f63','low','#34a853','moderate','#f9ab00','high','#ea4335','very_high','#c5221f','#ccc'],
      'fill-extrusion-height': ['*',['get','composite_risk'],50000],
      'fill-extrusion-opacity': ['interpolate',['linear'],['zoom'],6,0.5,9,0],
    }
  });
  map.addLayer({ id: 'd-line', type: 'line', source: 'districts', maxzoom: 10,
    paint: { 'line-color': '#aaa', 'line-width': 0.6,
      'line-opacity': ['interpolate',['linear'],['zoom'],6,0.5,10,0] }
  });

  map.on('click', 'd3d', e => {
    if (!e.features?.length) return;
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset:8 })
      .setHTML(`<b>${p.name}</b><br>Risk: ${(p.composite_risk*100).toFixed(1)}% (${p.risk_class?.replace(/_/g,' ')})`)
      .setLngLat(e.lngLat).addTo(map);
  });
  map.on('mouseenter', 'd3d', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'd3d', () => { map.getCanvas().style.cursor = ''; });
}

// ─── Markers ─────────────────────────────────────────────────
let _originMarker = null;
let _destMarker = null;

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
    if (destPoint || destType !== null) autoRoute();
  });
}

function addDestMarker(lat, lon, name, type) {
  _destMarker?.remove();
  const el = document.createElement('div');
  el.className = 'm-dest';
  el.innerHTML = `<div class="m-dest-pin m-dest-pin--${type||'hospital'}"><span>${type==='hospital'?'🏥':'🏛'}</span></div>`;
  _destMarker = new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat]).addTo(map);
  new maplibregl.Popup({ offset: 18, closeButton: false })
    .setHTML(`<b>${name}</b><br><small>${type}</small>`)
    .setLngLat([lon, lat]).addTo(map);
}

function clearMarkers() {
  _destMarker?.remove(); _destMarker = null;
}

// ─── Risk readout ─────────────────────────────────────────────
function updateRiskReadout(lat, lon) {
  if (!isLoaded()) return;
  const weights = getWeights();
  const sample = sampleAt(lat, lon);
  if (!sample || !sample.landMask) return;
  const comp = compositeRisk(sample, weights);
  if (comp === null) return;

  const cls = classifyRisk(comp);
  const colorMap = { very_low:'#0d9f63', low:'#34a853', moderate:'#f9ab00', high:'#ea4335', very_high:'#c5221f' };
  const col = colorMap[cls] || '#999';

  $('rp-composite').textContent = `${(comp*100).toFixed(1)}%`;
  $('rp-composite').style.color = col;
  $('rp-label').textContent = riskLabel(cls) + ' risk at this location';
  $('rp-label').style.color = col;

  const layers = [
    { key:'flood', label:'Flood', val: sample.flood },
    { key:'landslide', label:'Landslide', val: sample.landslide },
    { key:'slope', label:'Slope', val: sample.slope },
    { key:'exposure', label:'Exposure', val: sample.exposure },
  ];
  $('rp-bars').innerHTML = layers.map(l => {
    const c = classifyRisk(l.val);
    const lc = colorMap[c] || '#999';
    return `<div class="risk-mini-bar">
      <span class="risk-mini-label">${l.label}</span>
      <div class="risk-mini-track"><div class="risk-mini-fill" style="width:${l.val*100}%;background:${lc}"></div></div>
      <span class="risk-mini-val">${(l.val*100).toFixed(0)}%</span>
    </div>`;
  }).join('');

  const rp = $('risk-pill');
  rp.style.display = 'block';
}

// ─── Targeted Dijkstra (origin → specific target node) ───────
function dijkstraToTarget(nodes, startKey, targetKey, lam = 3) {
  const dist = new Map();
  const prev = new Map();
  const prevEdge = new Map();
  const visited = new Set();
  // Simple min-heap
  const heap = [{ key: startKey, cost: 0 }];
  const push = item => { heap.push(item); heap.sort((a,b) => a.cost - b.cost); };
  const pop  = () => heap.shift();

  dist.set(startKey, 0);

  while (heap.length) {
    const { key, cost } = pop();
    if (visited.has(key)) continue;
    visited.add(key);
    if (key === targetKey) break;

    const node = nodes.get(key);
    if (!node) continue;
    for (const edge of node.edges) {
      if (visited.has(edge.to)) continue;
      const edgeCost = edge.dist * (1 + lam * edge.risk);
      const nd = cost + edgeCost;
      if (!dist.has(edge.to) || nd < dist.get(edge.to)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, key);
        prevEdge.set(edge.to, edge);
        push({ key: edge.to, cost: nd });
      }
    }
  }

  if (!dist.has(targetKey)) return null;

  const path = [];
  const pathEdges = [];
  let cur = targetKey;
  while (cur) {
    path.unshift(cur);
    const e = prevEdge.get(cur);
    if (e) pathEdges.unshift(e);
    cur = prev.get(cur);
  }

  // Compute stats
  let totalDist = 0, totalRisk = 0, maxRisk = 0;
  let vhCount = 0, hCount = 0;
  for (const e of pathEdges) {
    totalDist += e.dist;
    totalRisk += e.risk * e.dist;
    if (e.risk > maxRisk) maxRisk = e.risk;
    const cls = classifyRisk(e.risk);
    if (cls === 'very_high') vhCount++;
    if (cls === 'high') hCount++;
  }
  const meanRisk = totalDist > 0 ? totalRisk / totalDist : 0;

  const targetNode = nodes.get(targetKey);
  return {
    path,
    edges: pathEdges,
    dest: targetNode,
    stats: { distance: totalDist, meanRisk, maxRisk, veryHighSegments: vhCount, highSegments: hCount, segmentCount: pathEdges.length },
  };
}

// ─── Route ───────────────────────────────────────────────────
async function autoRoute() {
  if (isRouting || !originPoint) return;
  isRouting = true;
  clearRoutes();
  clearMarkers();
  $('route-result').classList.remove('visible');
  $('route-cards-container').innerHTML = '';

  // Add origin marker
  addOriginMarker(originPoint.lat, originPoint.lon);

  // Fit view
  if (destPoint) {
    const sw = [Math.min(originPoint.lon,destPoint.lon)-0.02, Math.min(originPoint.lat,destPoint.lat)-0.02];
    const ne = [Math.max(originPoint.lon,destPoint.lon)+0.02, Math.max(originPoint.lat,destPoint.lat)+0.02];
    map.fitBounds([sw,ne], { padding: { top:80, bottom:80, left:440, right:80 }, duration:1000 });
  } else {
    map.flyTo({ center:[originPoint.lon,originPoint.lat], zoom:13, duration:1000 });
  }

  try {
    toast('Fetching road network…', { spinner: true });
    osmData = await fetchLocalData(originPoint.lat, originPoint.lon, s => toast(s, { spinner:true }));
    if (!osmData?.way_count) { toast('No roads found near origin', { error:true, dur:5000 }); return; }

    toast('Building road graph…', { spinner:true });
    const weights = getWeights();
    graph = buildGraph(osmData, weights);

    // Show facility dots
    addFacilityDots(osmData.hospitals||[], osmData.shelters||[]);

    toast('Computing safest route…', { spinner:true });
    const startNode = findNearest(graph.nodeIndex, graph.nodes, originPoint.lat, originPoint.lon, 2000);
    if (!startNode) { toast('No road within 2 km of origin', { error:true, dur:5000 }); return; }

    let safest, shortest;

    if (destPoint) {
      // Route to specific custom destination — snap to nearest graph node
      const endNode = findNearest(graph.nodeIndex, graph.nodes, destPoint.lat, destPoint.lon, 3000);
      if (!endNode) { toast('No road within 3 km of destination. Try a closer location.', { error:true, dur:5000 }); return; }

      // Temporarily mark the end node as a facility of type 'custom_dest'
      const savedType = endNode.facilityType;
      const savedName = endNode.facilityName;
      endNode.facilityType = 'custom_dest';
      endNode.facilityName = destPoint.label || 'Destination';

      // dijkstra uses: destType='either' matches any node with facilityType set
      // But 'custom_dest' won't match 'hospital'/'shelter', so we need to match via 'either'
      // Temporarily mark all other facility nodes so they don't interfere
      // Simplest fix: patch dijkstra match logic for 'custom_dest'
      // We'll use a separate targeted approach: find path from start to endNode.key directly
      safest  = dijkstraToTarget(graph.nodes, startNode.key, endNode.key, lambda);
      shortest = dijkstraToTarget(graph.nodes, startNode.key, endNode.key, 0);

      // Restore
      endNode.facilityType = savedType;
      endNode.facilityName = savedName;

      // Manually set the dest on the result
      if (safest) { safest.dest = { lat: endNode.lat, lon: endNode.lon, facilityName: destPoint.label || 'Destination', facilityType: 'custom_dest' }; }
      if (shortest) { shortest.dest = safest?.dest; }
    } else {
      // Route to nearest hospital/shelter
      safest = dijkstra(graph.nodes, startNode.key, lambda, false, destType);
      shortest = shortestPath(graph.nodes, startNode.key, destType);
    }

    if (!safest) { toast(`No reachable ${destType === 'either' ? 'facility' : destType} found. Try widening search.`, { error:true, dur:6000 }); return; }

    // Draw routes
    const safeCoords = routeToCoords(safest.path, graph.nodes);
    const altCoords  = shortest ? routeToCoords(shortest.path, graph.nodes) : null;
    drawRoutes(safeCoords, altCoords);

    // Dest marker
    const dest = safest.dest;
    if (dest) addDestMarker(dest.lat, dest.lon, dest.facilityName, dest.facilityType);

    // Show result cards
    showRouteCards(safest, shortest);
    hideToast();

  } catch (e) {
    console.error(e);
    toast(e.message, { error:true, dur:6000 });
  } finally {
    isRouting = false;
  }
}

// ─── Route cards ─────────────────────────────────────────────
function showRouteCards(safest, shortest) {
  const s = safest.stats;
  const colorMap = { very_low:'#0d9f63', low:'#34a853', moderate:'#f9ab00', high:'#ea4335', very_high:'#c5221f' };
  const riskCol = v => colorMap[classifyRisk(v)] || '#999';
  const destName = safest.dest?.facilityName || 'Destination';
  const destT = safest.dest?.facilityType || 'hospital';
  const destEmoji = destT === 'hospital' ? '🏥' : '🏛';

  let html = ``;

  // Safest card
  html += `<div class="route-card route-card--active" style="margin-top:12px">
    <div class="route-card-header">
      <span class="route-badge route-badge--safe">✅ Safest Route</span>
    </div>
    <div class="route-dest-name">${destEmoji} ${destName}</div>
    <div class="route-dest-type">${destT.charAt(0).toUpperCase()+destT.slice(1)}</div>
    <div class="route-stats">
      <div class="route-stat"><span class="route-stat-val">${formatDist(s.distance)}</span><span class="route-stat-lbl">Distance</span></div>
      <div class="route-stat"><span class="route-stat-val safe" style="color:${riskCol(s.meanRisk)}">${formatRisk(s.meanRisk)}</span><span class="route-stat-lbl">Avg Risk</span></div>
      <div class="route-stat"><span class="route-stat-val">${Math.round(s.distance/1000*1.5)} min</span><span class="route-stat-lbl">Est. time</span></div>
    </div>
  </div>`;

  // Shortest card
  if (shortest?.stats) {
    const sh = shortest.stats;
    html += `<div class="route-card" style="margin-top:8px">
      <div class="route-card-header">
        <span class="route-badge route-badge--alt">Shortest Route</span>
      </div>
      <div class="route-dest-name">${destEmoji} ${shortest.dest?.facilityName || destName}</div>
      <div class="route-dest-type">Alternative path</div>
      <div class="route-stats">
        <div class="route-stat"><span class="route-stat-val">${formatDist(sh.distance)}</span><span class="route-stat-lbl">Distance</span></div>
        <div class="route-stat"><span class="route-stat-val" style="color:${riskCol(sh.meanRisk)}">${formatRisk(sh.meanRisk)}</span><span class="route-stat-lbl">Avg Risk</span></div>
        <div class="route-stat"><span class="route-stat-val">${Math.round(sh.distance/1000*1.2)} min</span><span class="route-stat-lbl">Est. time</span></div>
      </div>
    </div>`;
  }

  // Recommendation
  const rec = compareRoutes(safest, shortest);
  if (rec) html += `<div class="route-rec" style="margin-top:8px">💡 ${rec}</div>`;

  $('route-cards-container').innerHTML = html;
  $('route-result').classList.add('visible');
}

// ─── Map routes ───────────────────────────────────────────────
function clearRoutes() {
  ['r-alt','r-safe-glow','r-safe'].forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  });
}

function drawRoutes(safeCoords, altCoords) {
  clearRoutes();

  const addLine = (id, coords, color, width, dash, blur=0, opacity=1) => {
    if (!coords?.length) return;
    if (map.getSource(id)) map.getSource(id).setData({ type:'Feature', geometry:{ type:'LineString', coordinates:coords }});
    else map.addSource(id, { type:'geojson', data:{ type:'Feature', geometry:{ type:'LineString', coordinates:coords }}});
    const paint = { 'line-color':color, 'line-width':width, 'line-opacity':opacity };
    if (dash) paint['line-dasharray'] = dash;
    if (blur) paint['line-blur'] = blur;
    if (!map.getLayer(id)) map.addLayer({ id, type:'line', source:id, paint }, getFirstLabelLayer());
    else Object.entries(paint).forEach(([k,v]) => map.setPaintProperty(id, k, v));
  };

  addLine('r-alt', altCoords, '#9aa0a6', 4, [6,4], 0, 0.5);
  addLine('r-safe-glow', safeCoords, '#1a73e8', 14, null, 10, 0.15);
  addLine('r-safe', safeCoords, '#1a73e8', 5, null, 0, 0.95);
}

// ─── Facility dots ────────────────────────────────────────────
function addFacilityDots(hospitals, shelters) {
  ['hospitals-layer','shelters-layer'].forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id.replace('-layer',''))) map.removeSource(id.replace('-layer',''));
  });

  const addDots = (id, items, color) => {
    if (!items.length) return;
    map.addSource(id, { type:'geojson', data:{ type:'FeatureCollection',
      features: items.map(f => ({ type:'Feature', geometry:{ type:'Point', coordinates:[f.lon,f.lat] }, properties:{ name:f.name } }))
    }});
    map.addLayer({ id:id+'-layer', type:'circle', source:id, paint:{
      'circle-radius':6,'circle-color':color,'circle-stroke-width':2,'circle-stroke-color':'#fff','circle-opacity':.9
    }});
  };

  addDots('hospitals', hospitals, '#ea4335');
  addDots('shelters', shelters, '#1a73e8');
}

// ─── Satellite toggle ─────────────────────────────────────────
async function setSatellite(sat) {
  isSatellite = sat;
  $('btn-street').classList.toggle('active', !sat);
  $('btn-sat').classList.toggle('active', sat);

  const style = sat ? STYLE_SAT_FB : STYLE_STREET;
  map.setStyle(style);

  // Re-add layers after style change
  await new Promise(r => map.once('styledata', r));
  await new Promise(r => setTimeout(r, 400));

  // Re-add terrain source
  if (!map.getSource('terrain-dem')) {
    map.addSource('terrain-dem', {
      type:'raster-dem',
      tiles:['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding:'terrarium', tileSize:256, maxzoom:15,
    });
  }

  // Re-add hazard overlay
  updateHazardOverlay();

  // Re-add districts
  try {
    const dr = await fetch(`${DATA_PATH}/tamil_nadu/districts.geojson`);
    if (dr.ok) addDistrictLayer(await dr.json());
  } catch {}

  // Re-add facility dots
  if (osmData) addFacilityDots(osmData.hospitals||[], osmData.shelters||[]);
}

// ─── Search ───────────────────────────────────────────────────
async function searchNominatim(q) {
  if (!q || q.length < 2) return [];
  const params = new URLSearchParams({ q, format:'json', countrycodes:'in', limit:'5', addressdetails:'1' });
  try {
    const r = await fetchWithTimeout(`${NOMINATIM_URL}?${params}`, { headers:{ 'User-Agent':'SafeRoute-TN/1.0' }}, 8000);
    if (!r.ok) return [];
    const data = await r.json();
    return data.map(x => ({ name: x.display_name.split(',').slice(0,3).join(', '), lat:+x.lat, lon:+x.lon }));
  } catch { return []; }
}

function showDropdown(dropdownEl, items, onSelect) {
  if (!items.length) { dropdownEl.classList.remove('open'); return; }
  dropdownEl.innerHTML = items.map((r,i) => `
    <div class="search-drop-item" data-i="${i}">
      <svg class="search-drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
      </svg>
      ${r.name}
    </div>
  `).join('');
  dropdownEl.classList.add('open');
  dropdownEl.querySelectorAll('.search-drop-item').forEach(el => {
    el.addEventListener('click', () => {
      dropdownEl.classList.remove('open');
      onSelect(items[+el.dataset.i]);
    });
  });
}

function setHasValue(rowEl, has) {
  rowEl.classList.toggle('has-value', has);
}

// ─── Wire UI ─────────────────────────────────────────────────
function wireUI() {

  // Map click
  map.on('click', e => {
    const feats = map.queryRenderedFeatures(e.point, { layers:['d3d'] });
    if (feats.length) return; // let district popup handle it

    const { lat, lng: lon } = e.lngLat;

    // If no origin yet, set as origin
    if (!originPoint) {
      originPoint = { lat, lon, label: 'Custom location' };
      $('origin-input').value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      setHasValue($('origin-row'), true);
      addOriginMarker(lat, lon);
      updateRiskReadout(lat, lon);
      toast('Now search or tap a destination, or choose "Route to Nearest"', { dur:4000 });
      return;
    }

    // Set as destination
    destPoint = { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
    $('dest-input').value = destPoint.label;
    setHasValue($('dest-row'), true);
    updateRiskReadout(lat, lon);
    autoRoute();
  });

  // Hazard chips
  document.querySelectorAll('.hchip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.hchip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedHazard = chip.dataset.hazard;
      updateHazardOverlay(selectedHazard);
      if (originPoint) autoRoute();
    });
  });

  // Dest type chips
  document.querySelectorAll('.dchip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.dchip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      destType = chip.dataset.dest;
      if (originPoint && !destPoint) autoRoute();
    });
  });

  // Origin input
  const originDrop = $('origin-dropdown');
  const originSearch = debounce(async v => {
    if (v.length < 2) { originDrop.classList.remove('open'); return; }
    const results = await searchNominatim(v);
    showDropdown(originDrop, results, r => {
      originPoint = { lat: r.lat, lon: r.lon, label: r.name };
      $('origin-input').value = r.name;
      setHasValue($('origin-row'), true);
      addOriginMarker(r.lat, r.lon);
      map.flyTo({ center:[r.lon, r.lat], zoom:13, duration:900 });
      updateRiskReadout(r.lat, r.lon);
      if (destPoint || destType) autoRoute();
    });
  }, 350);

  on($('origin-input'), 'input', e => {
    setHasValue($('origin-row'), !!e.target.value);
    originSearch(e.target.value);
  });
  on($('origin-clear'), 'click', () => {
    $('origin-input').value = '';
    originPoint = null;
    _originMarker?.remove(); _originMarker = null;
    originDrop.classList.remove('open');
    setHasValue($('origin-row'), false);
    $('risk-pill').style.display = 'none';
  });

  // Destination input
  const destDrop = $('dest-dropdown');
  const destSearch = debounce(async v => {
    if (v.length < 2) { destDrop.classList.remove('open'); return; }
    const results = await searchNominatim(v);
    showDropdown(destDrop, results, r => {
      destPoint = { lat: r.lat, lon: r.lon, label: r.name };
      $('dest-input').value = r.name;
      setHasValue($('dest-row'), true);
      autoRoute();
    });
  }, 350);

  on($('dest-input'), 'input', e => {
    setHasValue($('dest-row'), !!e.target.value);
    destSearch(e.target.value);
  });
  on($('dest-clear'), 'click', () => {
    $('dest-input').value = '';
    destPoint = null;
    _destMarker?.remove(); _destMarker = null;
    destDrop.classList.remove('open');
    setHasValue($('dest-row'), false);
    clearRoutes();
    $('route-result').classList.remove('visible');
  });

  // Swap origin ⇄ dest
  on($('btn-swap'), 'click', () => {
    const oLabel = $('origin-input').value;
    const dLabel = $('dest-input').value;
    $('origin-input').value = dLabel;
    $('dest-input').value = oLabel;
    const tmp = originPoint;
    originPoint = destPoint ? { ...destPoint } : null;
    destPoint   = tmp ? { ...tmp } : null;
    setHasValue($('origin-row'), !!originPoint);
    setHasValue($('dest-row'), !!destPoint);
    if (originPoint) addOriginMarker(originPoint.lat, originPoint.lon);
    if (originPoint && destPoint) autoRoute();
  });

  // GPS button
  on($('btn-gps'), 'click', async () => {
    try {
      toast('Getting your location…', { spinner:true });
      const pos = await getGPS();
      originPoint = { lat: pos.lat, lon: pos.lon, label: 'Your location' };
      $('origin-input').value = 'Your location';
      setHasValue($('origin-row'), true);
      addOriginMarker(pos.lat, pos.lon);
      map.flyTo({ center:[pos.lon, pos.lat], zoom:14, duration:1200 });
      updateRiskReadout(pos.lat, pos.lon);
      hideToast();
      if (destPoint || destType) autoRoute();
    } catch (e) { toast('Location access denied', { error:true, dur:4000 }); }
  });

  // Satellite toggle
  on($('btn-street'), 'click', () => setSatellite(false));
  on($('btn-sat'), 'click', () => setSatellite(true));

  // Info panel
  on($('btn-info'), 'click', openMeth);
  on($('meth-overlay'), 'click', closeMeth);

  // Sidebar toggle
  on($('sb-toggle'), 'click', () => {
    const sb = $('sidebar');
    sb.classList.toggle('collapsed');
    $('sb-toggle').textContent = sb.classList.contains('collapsed') ? '›' : '‹';
  });

  // Close dropdowns on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#origin-row')) originDrop.classList.remove('open');
    if (!e.target.closest('#dest-row')) destDrop.classList.remove('open');
  });
}

// ─── Methodology ─────────────────────────────────────────────
function openMeth() {
  $('meth-overlay').style.display = 'block';
  $('meth-drawer').style.display = 'block';
  setTimeout(() => {
    $('meth-overlay').style.opacity = '1';
    $('meth-drawer').style.transform = 'translateX(0)';
  }, 10);
}
window.closeMeth = function() {
  $('meth-overlay').style.display = 'none';
  $('meth-drawer').style.display = 'none';
};

function fillMeth(meta) {
  const ahp = meta?.ahp;
  let html = `
    <h3 style="font-size:15px;font-weight:600;margin:0 0 8px">Data Pipeline</h3>
    <p style="font-size:13px;color:#5f6368;line-height:1.7;margin-bottom:16px">
      Satellite imagery (Sentinel-1 SAR, Sentinel-2, SRTM DEM, WorldCover, GHSL Population, MODIS NDVI)
      is processed in Google Earth Engine to produce four normalized hazard layers.
    </p>
    <h3 style="font-size:15px;font-weight:600;margin:0 0 8px">MCDM – AHP Weights</h3>
    <p style="font-size:13px;color:#5f6368;line-height:1.7;margin-bottom:8px">`;

  if (ahp?.weights) {
    for (const [k,v] of Object.entries(ahp.weights)) {
      html += `<b>${k}</b>: ${(v*100).toFixed(1)}%&emsp;`;
    }
    html += `<br>CR = ${ahp.cr?.toFixed(4)||'N/A'} (< 0.10 ✓)`;
  }
  html += `</p>
    <h3 style="font-size:15px;font-weight:600;margin:12px 0 8px">Composite Risk Index</h3>
    <code style="font-size:12px;background:#f1f3f4;padding:6px 10px;border-radius:6px;display:block;margin-bottom:12px">
      R(x,y) = Σ wᵢ · Hazardᵢ(x,y)
    </code>
    <h3 style="font-size:15px;font-weight:600;margin:0 0 8px">Routing Algorithm</h3>
    <p style="font-size:13px;color:#5f6368;line-height:1.7">
      Road network from OpenStreetMap via Overpass API.
      Edge cost: <code style="font-size:12px;background:#f1f3f4;padding:2px 6px;border-radius:4px">C = length × (1 + λ × R)</code>
      Dijkstra's algorithm with binary min-heap finds the least-cost (safest) path.
      Shortest-distance alternative uses λ = 0.
    </p>`;
  $('meth-content').innerHTML = html;
}

// ─── Entry point ─────────────────────────────────────────────
boot().catch(e => {
  console.error('Boot failed:', e);
  dismissLoader();
  toast('Initialization failed. Please refresh.', { error:true, dur:10000 });
});
