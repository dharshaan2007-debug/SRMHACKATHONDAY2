/**
 * map3d.js – MapLibre GL JS setup, terrain, layers, camera.
 * Google Maps-like light basemap with optional 3D terrain.
 */

import { MAP_STYLE, TERRAIN, DEFAULT_VIEW, RISK_COLORS, FACILITY_COLORS, ROUTE_COLORS } from './config.js';

let map = null;
let terrainEnabled = false; // Start flat (Google Maps-like)
let terrainExaggeration = TERRAIN.exaggeration;

/**
 * Initialize the map.
 */
export function initMap(containerId) {
  map = new maplibregl.Map({
    container: containerId,
    style: MAP_STYLE,
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    pitch: DEFAULT_VIEW.pitch,
    bearing: DEFAULT_VIEW.bearing,
    maxPitch: 70,
    attributionControl: true,
    hash: false,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'bottom-right');

  map.on('load', () => {
    // Add terrain source (available but not enabled by default)
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: [TERRAIN.url],
      encoding: TERRAIN.encoding,
      tileSize: 256,
      maxzoom: TERRAIN.maxzoom,
    });

    console.log('Map initialized (Google Maps-like light basemap)');
  });

  return map;
}

/**
 * Get the map instance.
 */
export function getMap() { return map; }

/**
 * Get the first label layer ID for inserting layers below labels.
 */
function getFirstLabelLayer() {
  if (!map) return undefined;
  const layers = map.getStyle().layers;
  for (const layer of layers) {
    if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      return layer.id;
    }
  }
  return undefined;
}

/**
 * Get a layer ID to insert above terrain but below labels.
 */
export function getInsertionLayer() {
  return getFirstLabelLayer();
}

/**
 * Toggle terrain on/off.
 */
export function toggleTerrain(enabled) {
  terrainEnabled = enabled;
  if (!map) return;
  if (enabled) {
    map.setTerrain({ source: 'terrain-dem', exaggeration: terrainExaggeration });
    map.easeTo({ pitch: 45, duration: 800 });
  } else {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, duration: 800 });
  }
}

/**
 * Set terrain exaggeration.
 */
export function setTerrainExaggeration(value) {
  terrainExaggeration = value;
  if (map && terrainEnabled) {
    map.setTerrain({ source: 'terrain-dem', exaggeration: value });
  }
}

/**
 * Reset view to default.
 */
export function resetView() {
  if (!map) return;
  map.flyTo({
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    pitch: 0,
    bearing: 0,
    duration: 1500,
  });
}

/**
 * Fly to a bounding box.
 */
export function flyToBbox(bbox, padding = 60) {
  if (!map) return;
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
    padding,
    duration: 1500,
    pitch: 0,
  });
}

/**
 * Fly to a point.
 */
export function flyToPoint(lat, lon, zoom = 13) {
  if (!map) return;
  map.flyTo({
    center: [lon, lat],
    zoom,
    pitch: 0,
    duration: 1200,
  });
}

/**
 * Add hazard raster overlay as an image source.
 */
export function setHazardLayer(canvas, bbox) {
  if (!map) return;

  // Remove existing
  if (map.getLayer('hazard-layer')) map.removeLayer('hazard-layer');
  if (map.getSource('hazard-source')) map.removeSource('hazard-source');

  if (!canvas) return;

  const imageUrl = canvas.toDataURL('image/png');

  map.addSource('hazard-source', {
    type: 'image',
    url: imageUrl,
    coordinates: [
      [bbox[0], bbox[3]], // top-left
      [bbox[2], bbox[3]], // top-right
      [bbox[2], bbox[1]], // bottom-right
      [bbox[0], bbox[1]], // bottom-left
    ],
  });

  map.addLayer({
    id: 'hazard-layer',
    type: 'raster',
    source: 'hazard-source',
    paint: {
      'raster-opacity': 0.55,
      'raster-fade-duration': 300,
    },
  }, getFirstLabelLayer());
}

/**
 * Set hazard layer opacity.
 */
export function setHazardOpacity(opacity) {
  if (map?.getLayer('hazard-layer')) {
    map.setPaintProperty('hazard-layer', 'raster-opacity', opacity);
  }
}

/**
 * Add districts as 3D fill-extrusion layer.
 */
export function addDistrictLayer(geojson) {
  if (!map) return;

  if (map.getLayer('districts-3d')) map.removeLayer('districts-3d');
  if (map.getLayer('districts-outline')) map.removeLayer('districts-outline');
  if (map.getSource('districts')) map.removeSource('districts');

  map.addSource('districts', {
    type: 'geojson',
    data: geojson,
  });

  // 3D columns (subtle on light map)
  map.addLayer({
    id: 'districts-3d',
    type: 'fill-extrusion',
    source: 'districts',
    maxzoom: 9,
    paint: {
      'fill-extrusion-color': [
        'match', ['get', 'risk_class'],
        'very_low', RISK_COLORS.very_low,
        'low', RISK_COLORS.low,
        'moderate', RISK_COLORS.moderate,
        'high', RISK_COLORS.high,
        'very_high', RISK_COLORS.very_high,
        '#ccc',
      ],
      'fill-extrusion-height': [
        '*', ['get', 'composite_risk'], 60000
      ],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': [
        'interpolate', ['linear'], ['zoom'],
        6, 0.6,
        8, 0.2,
        9, 0,
      ],
    },
  });

  // Outline
  map.addLayer({
    id: 'districts-outline',
    type: 'line',
    source: 'districts',
    maxzoom: 10,
    paint: {
      'line-color': '#b0b0b0',
      'line-width': 0.8,
      'line-opacity': [
        'interpolate', ['linear'], ['zoom'],
        6, 0.6,
        9, 0.1,
        10, 0,
      ],
    },
  });
}

/**
 * Add facility markers.
 */
export function addFacilityMarkers(hospitals, shelters) {
  clearLayerIfExists('hospitals');
  clearLayerIfExists('shelters');

  if (hospitals.length > 0) {
    const geojson = {
      type: 'FeatureCollection',
      features: hospitals.map(h => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
        properties: { name: h.name, type: 'hospital' },
      })),
    };
    addOrUpdateSource('hospitals', geojson);
    map.addLayer({
      id: 'hospitals',
      type: 'circle',
      source: 'hospitals',
      paint: {
        'circle-radius': 7,
        'circle-color': FACILITY_COLORS.hospital,
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.95,
      },
    });
  }

  if (shelters.length > 0) {
    const geojson = {
      type: 'FeatureCollection',
      features: shelters.map(s => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: { name: s.name, type: 'shelter' },
      })),
    };
    addOrUpdateSource('shelters', geojson);
    map.addLayer({
      id: 'shelters',
      type: 'circle',
      source: 'shelters',
      paint: {
        'circle-radius': 6,
        'circle-color': FACILITY_COLORS.shelter,
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.95,
      },
    });
  }
}

/**
 * Draw routes on the map.
 */
export function drawRoutes(safestCoords, shortestCoords) {
  clearLayerIfExists('route-shortest');
  clearLayerIfExists('route-safest-glow');
  clearLayerIfExists('route-safest');

  if (shortestCoords && shortestCoords.length > 1) {
    addOrUpdateSource('route-shortest', {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: shortestCoords },
    });
    map.addLayer({
      id: 'route-shortest',
      type: 'line',
      source: 'route-shortest',
      paint: {
        'line-color': ROUTE_COLORS.shortest,
        'line-width': 4,
        'line-dasharray': [6, 4],
        'line-opacity': 0.5,
      },
    });
  }

  if (safestCoords && safestCoords.length > 1) {
    addOrUpdateSource('route-safest', {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: safestCoords },
    });

    // Glow
    map.addLayer({
      id: 'route-safest-glow',
      type: 'line',
      source: 'route-safest',
      paint: {
        'line-color': ROUTE_COLORS.safest,
        'line-width': 14,
        'line-blur': 10,
        'line-opacity': 0.2,
      },
    });

    // Main line
    map.addLayer({
      id: 'route-safest',
      type: 'line',
      source: 'route-safest',
      paint: {
        'line-color': ROUTE_COLORS.safest,
        'line-width': 5,
        'line-opacity': 0.9,
      },
    });
  }
}

/**
 * Clear routes.
 */
export function clearRoutes() {
  clearLayerIfExists('route-shortest');
  clearLayerIfExists('route-safest-glow');
  clearLayerIfExists('route-safest');
}

/**
 * Add/update a GeoJSON source.
 */
function addOrUpdateSource(id, data) {
  if (map.getSource(id)) {
    map.getSource(id).setData(data);
  } else {
    map.addSource(id, { type: 'geojson', data });
  }
}

/**
 * Clear layer and source if they exist.
 */
function clearLayerIfExists(id) {
  if (map?.getLayer(id)) map.removeLayer(id);
  if (map?.getSource(id)) map.removeSource(id);
}

/**
 * Add a draggable start marker (Google Maps blue dot style).
 */
export function addStartMarker(lat, lon, onDragEnd) {
  if (window._startMarker) {
    window._startMarker.remove();
  }

  const el = document.createElement('div');
  el.className = 'marker-start';

  const marker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([lon, lat])
    .addTo(map);

  marker.on('dragend', () => {
    const lngLat = marker.getLngLat();
    if (onDragEnd) onDragEnd(lngLat.lat, lngLat.lng);
  });

  window._startMarker = marker;
  return marker;
}

/**
 * Add destination marker.
 */
export function addDestMarker(lat, lon, name, type) {
  if (window._destMarker) window._destMarker.remove();

  const el = document.createElement('div');
  el.className = `marker-dest marker-dest--${type || 'hospital'}`;
  el.textContent = type === 'hospital' ? '🏥' : '🏛️';

  const marker = new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat])
    .addTo(map);

  const popup = new maplibregl.Popup({ offset: 15, closeButton: true })
    .setHTML(`<div class="district-popup__name">${name}</div><div class="district-popup__risk">${type}</div>`);
  marker.setPopup(popup);

  window._destMarker = marker;
  return marker;
}

/**
 * Clear facility markers.
 */
export function clearFacilityMarkers() {
  clearLayerIfExists('hospitals');
  clearLayerIfExists('shelters');
}

/**
 * Clear all markers.
 */
export function clearAllMarkers() {
  if (window._startMarker) { window._startMarker.remove(); window._startMarker = null; }
  if (window._destMarker) { window._destMarker.remove(); window._destMarker = null; }
}
