/**
 * map3d.js – MapLibre GL JS setup, terrain, layers, camera.
 */

import { MAP_STYLE, TERRAIN, DEFAULT_VIEW, RISK_COLORS, FACILITY_COLORS, ROUTE_COLORS } from './config.js';

let map = null;
let terrainEnabled = true;
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

  map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'top-right');

  map.on('load', () => {
    // Add terrain source
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: [TERRAIN.url],
      encoding: TERRAIN.encoding,
      tileSize: 256,
      maxzoom: TERRAIN.maxzoom,
    });

    // Enable terrain
    map.setTerrain({ source: 'terrain-dem', exaggeration: terrainExaggeration });

    // Add hillshade
    map.addLayer({
      id: 'hillshade',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-shadow-color': '#000000',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#111513',
        'hillshade-illumination-direction': 315,
        'hillshade-exaggeration': 0.3,
      },
    }, getFirstLabelLayer());

    console.log('Map initialized with 3D terrain');
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
    map.setPitch(DEFAULT_VIEW.pitch);
  } else {
    map.setTerrain(null);
    map.setPitch(0);
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
    pitch: terrainEnabled ? DEFAULT_VIEW.pitch : 0,
    bearing: DEFAULT_VIEW.bearing,
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
    pitch: terrainEnabled ? 40 : 0,
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
    pitch: terrainEnabled ? 45 : 0,
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
      'raster-opacity': 0.65,
      'raster-fade-duration': 200,
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

  // 3D columns
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
        '#555',
      ],
      'fill-extrusion-height': [
        '*', ['get', 'composite_risk'], 80000
      ],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': [
        'interpolate', ['linear'], ['zoom'],
        6, 0.8,
        8, 0.3,
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
      'line-color': '#212925',
      'line-width': 1,
      'line-opacity': [
        'interpolate', ['linear'], ['zoom'],
        6, 0.8,
        9, 0.2,
        10, 0,
      ],
    },
  });
}

/**
 * Add facility markers.
 */
export function addFacilityMarkers(hospitals, shelters) {
  // Remove existing
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
        'circle-radius': 6,
        'circle-color': FACILITY_COLORS.hospital,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0a0c0b',
        'circle-opacity': 0.9,
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
        'circle-radius': 5,
        'circle-color': FACILITY_COLORS.shelter,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0a0c0b',
        'circle-opacity': 0.9,
      },
    });
  }
}

/**
 * Draw routes on the map.
 */
export function drawRoutes(safestCoords, shortestCoords) {
  // Remove existing routes
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
        'line-width': 3,
        'line-dasharray': [4, 3],
        'line-opacity': 0.6,
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
        'line-width': 10,
        'line-blur': 8,
        'line-opacity': 0.25,
      },
    });

    // Main line
    map.addLayer({
      id: 'route-safest',
      type: 'line',
      source: 'route-safest',
      paint: {
        'line-color': ROUTE_COLORS.safest,
        'line-width': 4,
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
 * Add a draggable start marker.
 */
export function addStartMarker(lat, lon, onDragEnd) {
  // Remove existing
  if (window._startMarker) {
    window._startMarker.remove();
  }

  const el = document.createElement('div');
  el.style.cssText = `
    width: 20px; height: 20px;
    background: #7dff9b;
    border: 3px solid #0a0c0b;
    border-radius: 50%;
    box-shadow: 0 0 12px rgba(125,255,155,0.4);
    cursor: grab;
  `;

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

  const color = type === 'hospital' ? FACILITY_COLORS.hospital : FACILITY_COLORS.shelter;

  const el = document.createElement('div');
  el.style.cssText = `
    width: 24px; height: 24px;
    background: ${color};
    border: 3px solid #0a0c0b;
    border-radius: 4px;
    box-shadow: 0 0 12px ${color}40;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: bold; color: #0a0c0b;
  `;
  el.textContent = type === 'hospital' ? '+' : '⌂';

  const marker = new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat])
    .addTo(map);

  // Popup
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
