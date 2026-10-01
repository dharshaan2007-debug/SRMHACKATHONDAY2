/**
 * main.js – Application entry point (Google Maps-like UX).
 *
 * Flow:
 *   1. App loads → map + hazard rasters loaded → loading screen dismissed
 *   2. Home screen: user sees the map with hazard-picker cards at bottom
 *   3. User clicks a hazard card (Flood / Landslide / All / Slope)
 *      → hazard overlay appears on map
 *      → cards hide, toast says "Tap your location on the map"
 *   4. User clicks map (or search/geolocate)
 *      → OSM roads + facilities fetched
 *      → Dijkstra least-risk route computed
 *      → route drawn, bottom-sheet route panel shown
 */

import { DEFAULT_WEIGHTS, DEFAULT_LAMBDA, REGIONS_FILE, DATA_PATH } from './config.js';
import { initMap, getMap, setHazardLayer, addDistrictLayer, flyToPoint,
  addStartMarker, addDestMarker, addFacilityMarkers, clearFacilityMarkers,
  drawRoutes, clearRoutes, clearAllMarkers, setHazardOpacity } from './map3d.js';
import { loadRegionRasters, createHazardCanvas, getBbox, getMeta, sampleAt, compositeRisk, isLoaded } from './hazard-raster.js';
import { initWeightsFromMeta, getWeights, setWeights } from './risk.js';
import { loadDemoCache, fetchLocalData } from './osm-live.js';
import { buildGraph, findNearest, recomputeEdgeRisks } from './graph.js';
import { dijkstra, shortestPath, routeToCoords, compareRoutes } from './router.js';
import { searchPlace, createDebouncedSearch, getCurrentPosition } from './geocode.js';
import { debounce, inBbox, classifyRisk, riskLabel, riskMod, formatDist, formatRisk, round } from './utils.js';

// ── State ──
let regions = [];
let currentRegion = null;
let districts = null;
let startPoint = null;
let graph = null;
let osmData = null;
let destType = 'either';
let lambda = DEFAULT_LAMBDA;
let avoidVeryHigh = false;
let isRouting = false;
let selectedHazard = null; // 'flood' | 'landslide' | 'composite' | 'slope'

// ── DOM refs ──
const $ = (id) => document.getElementById(id);
const loadingScreen = $('loading-screen');
const hazardPicker = $('hazard-picker');
const routePanel = $('route-panel');
const routeContent = $('route-content');
const riskReadout = $('risk-readout');
const statusToast = $('status-toast');
const toastText = $('toast-text');
const toastSpinner = $('toast-spinner');
const searchInput = $('search-input');
const searchResults = $('search-results');
const legend = $('legend');
const settingsPanel = $('settings-panel');

// ── Status helpers ──
function showStatus(msg, showSpinner = true) {
  toastText.textContent = msg;
  toastSpinner.style.display = showSpinner ? 'block' : 'none';
  statusToast.classList.remove('error');
  statusToast.classList.add('visible');
}

function hideStatus() {
  statusToast.classList.remove('visible');
}

function showError(msg) {
  toastText.textContent = msg;
  toastSpinner.style.display = 'none';
  statusToast.classList.add('error', 'visible');
  setTimeout(hideStatus, 5000);
}

// ── Boot ──
async function boot() {
  showStatus('Loading map & hazard data');

  // Load regions
  try {
    const resp = await fetch(REGIONS_FILE);
    if (resp.ok) regions = (await resp.json()).regions || [];
  } catch { /* defaults */ }

  // Init map
  const map = initMap('map');

  map.on('load', async () => {
    // Load demo cache in parallel
    loadDemoCache();

    currentRegion = 'tamil_nadu';

    try {
      const meta = await loadRegionRasters(currentRegion, DATA_PATH);
      initWeightsFromMeta(meta);

      // Load districts
      try {
        const dResp = await fetch(`${DATA_PATH}/${currentRegion}/districts.geojson`);
        if (dResp.ok) {
          districts = await dResp.json();
          addDistrictLayer(districts);

          // District click popup
          map.on('click', 'districts-3d', (e) => {
            if (e.features?.length) {
              const p = e.features[0].properties;
              new maplibregl.Popup({ offset: 10 })
                .setHTML(`
                  <div class="district-popup__name">${p.name}</div>
                  <div class="district-popup__risk">
                    Risk: ${(p.composite_risk * 100).toFixed(1)}% (${riskLabel(p.risk_class)})
                  </div>
                `)
                .setLngLat(e.lngLat)
                .addTo(map);
            }
          });
          map.on('mouseenter', 'districts-3d', () => { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', 'districts-3d', () => { map.getCanvas().style.cursor = ''; });
        }
      } catch (e) { console.warn('Districts:', e); }

      // Fill methodology
      fillMethodology(meta);

      // Map click → set start point (only after hazard is selected)
      map.on('click', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['districts-3d'] });
        if (features.length > 0) return;
        if (!selectedHazard) return; // Don't do anything if no hazard selected
        handleStartPoint(e.lngLat.lat, e.lngLat.lng);
      });

      // Dismiss loading screen
      loadingScreen.classList.add('done');
      setTimeout(() => { loadingScreen.style.display = 'none'; }, 600);
      hideStatus();

    } catch (e) {
      console.error('Load error:', e);
      showError('Failed to load hazard data');
      loadingScreen.classList.add('done');
    }
  });

  // Wire up all UI
  initHazardPicker();
  initSearchBox();
  initLocateBtn();
  initSettingsPanel();
  initInfoPanel();
}

// ── Hazard Picker ──
function initHazardPicker() {
  const cards = document.querySelectorAll('.hazard-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      const hazard = card.dataset.hazard;
      selectHazard(hazard);

      // UI: highlight selected card
      cards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });
}

function selectHazard(hazard) {
  selectedHazard = hazard;

  // Show hazard overlay on map
  updateHazardOverlay(hazard);
  legend.style.display = 'flex';

  // Hide picker, show instruction
  setTimeout(() => {
    hazardPicker.classList.add('hidden');
  }, 300);

  showStatus('Tap your location on the map, search, or use GPS 📍', false);
  setTimeout(hideStatus, 4000);
}

// ── Hazard Overlay ──
function updateHazardOverlay(mode) {
  if (!isLoaded()) return;
  mode = mode || selectedHazard || 'composite';
  const weights = getWeights();
  const canvas = createHazardCanvas(mode, weights);
  const bbox = getBbox();
  if (canvas && bbox) {
    setHazardLayer(canvas, bbox);
  }
}

// ── Start Point & Routing ──
async function handleStartPoint(lat, lon) {
  if (isRouting) return;

  const bbox = getBbox();
  if (bbox && !inBbox(lat, lon, bbox)) {
    showError('Outside Tamil Nadu coverage area');
    return;
  }

  startPoint = { lat, lon };
  isRouting = true;

  // Update risk readout
  updateRiskReadout(lat, lon);

  // Add marker
  addStartMarker(lat, lon, (newLat, newLon) => {
    handleStartPoint(newLat, newLon);
  });

  // Fly to
  flyToPoint(lat, lon, 13);

  // Clear old
  clearRoutes();
  clearFacilityMarkers();
  routePanel.classList.add('hidden');

  try {
    osmData = await fetchLocalData(lat, lon, showStatus);

    if (!osmData || osmData.way_count === 0) {
      showError('No roads found near this location');
      isRouting = false;
      return;
    }

    showStatus('Building road network');
    const weights = getWeights();
    graph = buildGraph(osmData, weights);

    addFacilityMarkers(osmData.hospitals || [], osmData.shelters || []);

    await runRouting();
  } catch (e) {
    console.error('Error:', e);
    showError(e.message);
  } finally {
    isRouting = false;
  }
}

async function runRouting() {
  if (!graph || !startPoint) return;

  showStatus('Computing safest escape route');

  const startNode = findNearest(graph.nodeIndex, graph.nodes, startPoint.lat, startPoint.lon, 2000);
  if (!startNode) {
    showError('No road found within 2 km');
    hideStatus();
    return;
  }

  const safestResult = dijkstra(graph.nodes, startNode.key, lambda, avoidVeryHigh, destType);
  const shortestResult = shortestPath(graph.nodes, startNode.key, destType);

  if (!safestResult) {
    showError(`No reachable ${destType === 'either' ? 'facility' : destType} found`);
    hideStatus();
    return;
  }

  // Draw routes
  const safestCoords = routeToCoords(safestResult.path, graph.nodes);
  const shortestCoords = shortestResult ? routeToCoords(shortestResult.path, graph.nodes) : null;
  drawRoutes(safestCoords, shortestCoords);

  // Dest marker
  const dest = safestResult.dest;
  addDestMarker(dest.lat, dest.lon, dest.facilityName, dest.facilityType);

  // Show route panel
  showRoutePanel(safestResult, shortestResult);

  hideStatus();
}

// ── Route Panel ──
function showRoutePanel(safest, shortest) {
  const s = safest.stats;
  const destName = safest.dest.facilityName || 'Facility';
  const destType = safest.dest.facilityType || 'hospital';
  const destIcon = destType === 'hospital' ? '🏥' : '🏛️';
  const riskClass = classifyRisk(s.meanRisk);
  const riskCls = riskMod(riskClass);

  let html = `
    <div class="route-header">
      <div class="route-header__title">🛡️ Safest Route Found</div>
      <button class="route-header__close" id="close-route" title="Close">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="route-comparison">
      <div class="route-option route-option--safest">
        <div class="route-option__badge">✅ Recommended</div>
        <div class="route-option__dest">${destIcon} ${destName}</div>
        <div class="route-option__stats">
          <div class="route-stat">
            <span class="route-stat__value">${formatDist(s.distance)}</span>
            Distance
          </div>
          <div class="route-stat">
            <span class="route-stat__value risk-color--${riskCls}">${formatRisk(s.meanRisk)}</span>
            Avg Risk
          </div>
          <div class="route-stat">
            <span class="route-stat__value">${s.segmentCount}</span>
            Segments
          </div>
          <div class="route-stat">
            <span class="route-stat__value">${s.veryHighSegments}</span>
            High-risk segs
          </div>
        </div>
      </div>
  `;

  if (shortest && shortest.stats) {
    const sh = shortest.stats;
    const shRiskCls = riskMod(classifyRisk(sh.meanRisk));
    html += `
      <div class="route-option route-option--shortest">
        <div class="route-option__badge">Shortest</div>
        <div class="route-option__dest">${destIcon} ${shortest.dest?.facilityName || destName}</div>
        <div class="route-option__stats">
          <div class="route-stat">
            <span class="route-stat__value">${formatDist(sh.distance)}</span>
            Distance
          </div>
          <div class="route-stat">
            <span class="route-stat__value risk-color--${shRiskCls}">${formatRisk(sh.meanRisk)}</span>
            Avg Risk
          </div>
          <div class="route-stat">
            <span class="route-stat__value">${sh.segmentCount}</span>
            Segments
          </div>
          <div class="route-stat">
            <span class="route-stat__value">${sh.veryHighSegments}</span>
            High-risk segs
          </div>
        </div>
      </div>
    `;
  }

  html += `</div>`;

  // Recommendation
  const rec = compareRoutes(safest, shortest);
  if (rec) {
    html += `<div class="route-recommendation">💡 ${rec}</div>`;
  }

  routeContent.innerHTML = html;
  routePanel.classList.remove('hidden');

  // Close button
  const closeBtn = document.getElementById('close-route');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      routePanel.classList.add('hidden');
    });
  }
}

// ── Risk Readout ──
function updateRiskReadout(lat, lon) {
  const weights = getWeights();
  const sample = sampleAt(lat, lon);
  if (!sample || !sample.landMask) {
    riskReadout.classList.remove('visible');
    return;
  }

  const composite = compositeRisk(sample, weights);
  if (composite === null) return;

  const cls = classifyRisk(composite);
  const riskVal = $('risk-value');
  const riskLbl = $('risk-label');
  const riskBars = $('risk-bars');

  riskVal.textContent = `${(composite * 100).toFixed(1)}%`;
  riskVal.className = `risk-readout__value risk-color--${riskMod(cls)}`;
  riskLbl.textContent = riskLabel(cls) + ' risk';
  riskLbl.className = `risk-readout__label risk-color--${riskMod(cls)}`;

  const layers = [
    { key: 'flood', label: 'Flood', val: sample.flood },
    { key: 'landslide', label: 'Landslide', val: sample.landslide },
    { key: 'slope', label: 'Slope', val: sample.slope },
    { key: 'exposure', label: 'Exposure', val: sample.exposure },
  ];

  riskBars.innerHTML = layers.map(l => {
    const c = classifyRisk(l.val);
    return `
      <div class="risk-bar">
        <span class="risk-bar__label">${l.label}</span>
        <div class="risk-bar__track">
          <div class="risk-bar__fill risk-bg--${riskMod(c)}" style="width:${l.val * 100}%"></div>
        </div>
        <span class="risk-bar__val">${(l.val * 100).toFixed(0)}%</span>
      </div>
    `;
  }).join('');

  riskReadout.classList.add('visible');
}

// ── Search ──
function initSearchBox() {
  if (!searchInput || !searchResults) return;

  const search = createDebouncedSearch((items) => {
    if (items.length === 0) {
      searchResults.classList.remove('active');
      return;
    }

    searchResults.innerHTML = items.map(r => `
      <div class="search-result" data-lat="${r.lat}" data-lon="${r.lon}">
        <svg class="search-result__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>
        <div class="search-result__name">${r.name}</div>
      </div>
    `).join('');
    searchResults.classList.add('active');
  }, 400);

  searchInput.addEventListener('input', () => search(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') searchResults.classList.remove('active');
  });

  searchResults.addEventListener('click', (e) => {
    const item = e.target.closest('.search-result');
    if (!item) return;
    const lat = parseFloat(item.dataset.lat);
    const lon = parseFloat(item.dataset.lon);
    searchInput.value = item.querySelector('.search-result__name').textContent;
    searchResults.classList.remove('active');

    // Auto-select composite if no hazard selected
    if (!selectedHazard) selectHazard('composite');
    handleStartPoint(lat, lon);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-bar')) searchResults.classList.remove('active');
  });
}

// ── Locate ──
function initLocateBtn() {
  const btn = $('btn-locate');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    try {
      showStatus('Getting your location');
      const pos = await getCurrentPosition();
      if (!selectedHazard) selectHazard('composite');
      handleStartPoint(pos.lat, pos.lon);
    } catch (e) {
      showError(e.message);
    }
  });
}

// ── Settings ──
function initSettingsPanel() {
  // Opacity slider
  const opacitySlider = $('hazard-opacity');
  const opacityVal = $('opacity-val');
  if (opacitySlider) {
    opacitySlider.addEventListener('input', () => {
      const v = parseFloat(opacitySlider.value);
      opacityVal.textContent = `${Math.round(v * 100)}%`;
      setHazardOpacity(v);
    });
  }

  // Lambda slider
  const lambdaSlider = $('lambda-slider');
  const lambdaVal = $('lambda-val');
  if (lambdaSlider) {
    lambdaSlider.addEventListener('input', () => {
      lambda = parseFloat(lambdaSlider.value);
      lambdaVal.textContent = lambda.toFixed(1);
      if (graph && startPoint) runRouting();
    });
  }

  // Dest chips
  const chips = document.querySelectorAll('#dest-chips .chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      destType = chip.dataset.dest;
      if (graph && startPoint) runRouting();
    });
  });

  // Avoid very high checkbox
  const avoidCb = $('avoid-very-high');
  if (avoidCb) {
    avoidCb.addEventListener('change', () => {
      avoidVeryHigh = avoidCb.checked;
      if (graph && startPoint) runRouting();
    });
  }

  // Toggle settings with info button (gear at top-right handled later)
}

// ── Info / Methodology ──
function initInfoPanel() {
  const btn = $('btn-info');
  const overlay = $('methodology-overlay');
  const drawer = $('methodology-drawer');
  const closeBtn = $('methodology-close');

  function open() {
    overlay.classList.add('visible');
    drawer.classList.add('visible');
    // Also show settings
    settingsPanel.classList.add('visible');
  }

  function close() {
    overlay.classList.remove('visible');
    drawer.classList.remove('visible');
    settingsPanel.classList.remove('visible');
  }

  if (btn) btn.addEventListener('click', open);
  if (overlay) overlay.addEventListener('click', close);
  if (closeBtn) closeBtn.addEventListener('click', close);
}

function fillMethodology(meta) {
  const content = $('methodology-content');
  if (!content) return;

  const ahp = meta?.ahp;
  let html = `<h2>Methodology</h2>`;

  html += `
    <h3>Data Pipeline</h3>
    <p>Satellite imagery (Sentinel-1 SAR, Sentinel-2, SRTM DEM, MODIS NDVI, WorldCover, GHSL Population)
    is processed through Google Earth Engine to produce normalized hazard rasters.</p>

    <h3>Multi-Criteria Decision Making (MCDM)</h3>
    <p>We use the <strong>Analytic Hierarchy Process (AHP)</strong> to derive weights for four hazard criteria.
    The pairwise comparison matrix produces weights via eigenvector method:</p>
  `;

  if (ahp) {
    html += `<p>`;
    for (const [k, v] of Object.entries(ahp.weights)) {
      html += `<strong>${k}</strong>: ${(v * 100).toFixed(1)}%&nbsp;&nbsp;`;
    }
    html += `</p>`;
    html += `<p>Consistency Ratio: <code>CR = ${ahp.cr?.toFixed(4) || 'N/A'}</code> (< 0.10 ✓)</p>`;
  }

  html += `
    <h3>Composite Risk Index</h3>
    <p><code>R(x,y) = w₁·Flood + w₂·Landslide + w₃·Slope + w₄·Exposure</code></p>

    <h3>Least-Risk Routing</h3>
    <p>Road network fetched live from OpenStreetMap via Overpass API.
    Each road segment's cost is:</p>
    <p><code>C(edge) = length × (1 + λ × R(edge))</code></p>
    <p>where λ (risk aversion) controls the tradeoff between distance and safety.
    Dijkstra's algorithm with a binary min-heap finds the optimal route.</p>

    <h3>Coverage</h3>
    <p>Full state of Tamil Nadu. Click anywhere, search any place, or use GPS.
    Road data is fetched live with auto-expanding search radius.</p>

    <h3>Limitations</h3>
    <p>Risk rasters are currently synthetic (based on geographic models).
    Replace with real GEE outputs via <code>pipeline/01_gee_hazards.py</code> for production use.</p>
  `;

  content.innerHTML = html;
}

// ── Boot ──
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
