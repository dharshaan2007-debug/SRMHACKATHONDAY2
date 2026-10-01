/**
 * main.js – Application entry point. Orchestrates all modules.
 */

import { DEFAULT_WEIGHTS, DEFAULT_LAMBDA, REGIONS_FILE, DATA_PATH } from './config.js';
import { initMap, getMap, setHazardLayer, addDistrictLayer, flyToPoint, flyToBbox,
  addStartMarker, addDestMarker, addFacilityMarkers, clearFacilityMarkers,
  drawRoutes, clearRoutes, clearAllMarkers } from './map3d.js';
import { loadRegionRasters, createHazardCanvas, getBbox, getMeta, sampleAt, compositeRisk, isLoaded } from './hazard-raster.js';
import { initWeightsFromMeta, getWeights, setWeights } from './risk.js';
import { loadDemoCache, fetchLocalData } from './osm-live.js';
import { buildGraph, findNearest, recomputeEdgeRisks } from './graph.js';
import { dijkstra, shortestPath, routeToCoords, compareRoutes } from './router.js';
import { searchPlace, createDebouncedSearch, getCurrentPosition } from './geocode.js';
import { computeStateSummary, computeLocalStats, renderStateSummary, renderLocalStats } from './dashboard.js';
import { initUI, showStatus, hideStatus, showError, updateRiskReadout,
  showRouteCard, hideRouteCard, updateDashboard, fillMethodology, getHazardMode } from './ui.js';
import { debounce, inBbox, classifyRisk, riskLabel } from './utils.js';

// ── Application state ──
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

/**
 * Boot the application.
 */
async function boot() {
  showStatus('Initializing map');

  // Load regions registry
  try {
    const resp = await fetch(REGIONS_FILE);
    if (resp.ok) regions = (await resp.json()).regions || [];
  } catch { /* use defaults */ }

  // Init map
  const map = initMap('map');

  map.on('load', async () => {
    showStatus('Loading hazard data');

    // Load demo cache in parallel
    loadDemoCache();

    // Determine active region (default: tamil_nadu)
    currentRegion = 'tamil_nadu';

    try {
      // Load hazard rasters
      const meta = await loadRegionRasters(currentRegion, DATA_PATH);
      initWeightsFromMeta(meta);
      console.log('Region meta loaded:', meta.region_name);

      // Init UI with callbacks
      initUI({
        onLayerChange: handleLayerChange,
        onWeightsChange: debounce(handleWeightsChange, 100),
        onStartPointSet: handleStartPoint,
        onDestTypeChange: handleDestType,
        onLambdaChange: handleLambdaChange,
        onAvoidHighChange: handleAvoidHighChange,
      });

      // Render hazard overlay
      updateHazardOverlay();

      // Load districts
      try {
        const dResp = await fetch(`${DATA_PATH}/${currentRegion}/districts.geojson`);
        if (dResp.ok) {
          districts = await dResp.json();
          addDistrictLayer(districts);

          // Dashboard
          const summary = computeStateSummary(districts);
          updateDashboard(renderStateSummary(summary));

          // District click
          map.on('click', 'districts-3d', (e) => {
            if (e.features?.length) {
              const f = e.features[0];
              const p = f.properties;
              const popup = new maplibregl.Popup({ offset: 10 })
                .setHTML(`
                  <div class="district-popup__name">${p.name}</div>
                  <div class="district-popup__risk">
                    Risk: ${(p.composite_risk * 100).toFixed(1)}% (${riskLabel(p.risk_class)})
                  </div>
                `);
              popup.setLngLat(e.lngLat).addTo(map);
            }
          });

          map.on('mouseenter', 'districts-3d', () => {
            map.getCanvas().style.cursor = 'pointer';
          });
          map.on('mouseleave', 'districts-3d', () => {
            map.getCanvas().style.cursor = '';
          });
        }
      } catch (e) {
        console.warn('Districts not loaded:', e);
      }

      // Fill methodology
      fillMethodology(meta);

      // Map click to set start point
      map.on('click', (e) => {
        // Don't intercept district clicks
        const features = map.queryRenderedFeatures(e.point, { layers: ['districts-3d'] });
        if (features.length > 0) return;

        handleStartPoint(e.lngLat.lat, e.lngLat.lng);
      });

      hideStatus();
      showStatus('Click anywhere in Tamil Nadu to set start point', -1);
      setTimeout(hideStatus, 4000);

    } catch (e) {
      console.error('Failed to load hazard data:', e);
      showError('Failed to load hazard data. Check data/ folder.');

      // Still init UI for a usable state
      initUI({
        onLayerChange: () => {},
        onWeightsChange: () => {},
        onStartPointSet: handleStartPoint,
        onDestTypeChange: handleDestType,
        onLambdaChange: handleLambdaChange,
        onAvoidHighChange: handleAvoidHighChange,
      });
    }
  });

  // Search box
  initSearchBox();

  // Geolocate button
  const geoBtn = document.getElementById('btn-geolocate');
  if (geoBtn) {
    geoBtn.addEventListener('click', async () => {
      try {
        showStatus('Getting your location');
        const pos = await getCurrentPosition();
        handleStartPoint(pos.lat, pos.lon);
      } catch (e) {
        showError(e.message);
      }
    });
  }
}

/**
 * Handle hazard layer change.
 */
function handleLayerChange(mode) {
  updateHazardOverlay(mode);
}

/**
 * Handle weight change.
 */
function handleWeightsChange(weights) {
  updateHazardOverlay();

  // If we have a start point, update readout
  if (startPoint) {
    updateRiskReadout(startPoint.lat, startPoint.lon, weights);
  }

  // If we have a graph, recompute edge risks and re-route
  if (graph && startPoint) {
    recomputeEdgeRisks(graph, weights);
    runRouting();
  }
}

/**
 * Update hazard overlay on the map.
 */
function updateHazardOverlay(mode) {
  if (!isLoaded()) return;
  mode = mode || getHazardMode();
  const weights = getWeights();
  const canvas = createHazardCanvas(mode, weights);
  const bbox = getBbox();
  if (canvas && bbox) {
    setHazardLayer(canvas, bbox);
  }
}

/**
 * Handle setting start point.
 */
async function handleStartPoint(lat, lon) {
  if (isRouting) return;

  // Check if in any covered region
  const bbox = getBbox();
  if (bbox && !inBbox(lat, lon, bbox)) {
    const availableRegions = regions.length > 0
      ? regions.map(r => r.name).join(', ')
      : 'Tamil Nadu';
    showError(`Outside covered region. Currently available: ${availableRegions}`);
    return;
  }

  startPoint = { lat, lon };
  isRouting = true;

  // Show risk readout
  const weights = getWeights();
  updateRiskReadout(lat, lon, weights);

  // Add marker
  addStartMarker(lat, lon, (newLat, newLon) => {
    handleStartPoint(newLat, newLon);
  });

  // Fly to
  flyToPoint(lat, lon, 13);

  // Clear old routes and markers
  clearRoutes();
  clearFacilityMarkers();
  hideRouteCard();

  try {
    // Fetch local OSM data
    osmData = await fetchLocalData(lat, lon, showStatus);

    if (!osmData || osmData.way_count === 0) {
      showError('No roads found near this location');
      isRouting = false;
      return;
    }

    showStatus('Building road graph');

    // Build graph
    graph = buildGraph(osmData, weights);
    console.log(`Graph: ${graph.nodes.size} nodes, ${graph.edges.length} edges`);

    // Add facility markers
    addFacilityMarkers(osmData.hospitals || [], osmData.shelters || []);

    // Update local dashboard
    const localStats = computeLocalStats(osmData, weights);
    const dashHtml = renderLocalStats(localStats);
    updateDashboard(dashHtml);

    // Run routing
    await runRouting();

  } catch (e) {
    console.error('Error:', e);
    showError(e.message);
  } finally {
    isRouting = false;
  }
}

/**
 * Run Dijkstra routing from start point.
 */
async function runRouting() {
  if (!graph || !startPoint) return;

  showStatus('Computing least-risk route');

  // Snap start to nearest road node
  const startNode = findNearest(graph.nodeIndex, graph.nodes, startPoint.lat, startPoint.lon, 2000);
  if (!startNode) {
    showError('No road found within 2 km of start point');
    hideStatus();
    return;
  }

  // Find least-risk route
  const safestResult = dijkstra(graph.nodes, startNode.key, lambda, avoidVeryHigh, destType);

  // Find shortest route
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

  // Add destination marker
  const dest = safestResult.dest;
  addDestMarker(dest.lat, dest.lon, dest.facilityName, dest.facilityType);

  // Show comparison card
  showRouteCard(safestResult, shortestResult);

  hideStatus();
}

/**
 * Handle destination type change.
 */
function handleDestType(type) {
  destType = type;
  if (graph && startPoint) runRouting();
}

/**
 * Handle lambda change.
 */
function handleLambdaChange(value) {
  lambda = value;
  if (graph && startPoint) runRouting();
}

/**
 * Handle avoid-very-high toggle.
 */
function handleAvoidHighChange(checked) {
  avoidVeryHigh = checked;
  if (graph && startPoint) runRouting();
}

/**
 * Initialize the search box.
 */
function initSearchBox() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  if (!input || !results) return;

  const search = createDebouncedSearch((items) => {
    if (items.length === 0) {
      results.classList.remove('active');
      return;
    }

    results.innerHTML = items.map(r => `
      <div class="search-result" data-lat="${r.lat}" data-lon="${r.lon}">
        <div class="search-result__name">${r.name}</div>
      </div>
    `).join('');
    results.classList.add('active');
  }, 400);

  input.addEventListener('input', () => {
    search(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      results.classList.remove('active');
    }
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.search-result');
    if (!item) return;
    const lat = parseFloat(item.dataset.lat);
    const lon = parseFloat(item.dataset.lon);
    input.value = item.querySelector('.search-result__name').textContent;
    results.classList.remove('active');
    handleStartPoint(lat, lon);
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.topbar__search')) {
      results.classList.remove('active');
    }
  });
}

// Boot on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
