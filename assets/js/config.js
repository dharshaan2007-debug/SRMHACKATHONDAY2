/**
 * config.js – Application configuration and constants.
 * All CDN versions pinned for reproducibility.
 */

export const CDN = {
  maplibre: {
    js: 'https://unpkg.com/maplibre-gl@4.5.0/dist/maplibre-gl.js',
    css: 'https://unpkg.com/maplibre-gl@4.5.0/dist/maplibre-gl.css',
  },
};

export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export const TERRAIN = {
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  exaggeration: 1.4,
  maxzoom: 15,
};

export const DEFAULT_VIEW = {
  center: [78.6, 11.0],   // Tamil Nadu center
  zoom: 6.8,
  pitch: 40,
  bearing: -12,
};

export const RISK_COLORS = {
  very_low:  '#16403a',
  low:       '#2f7d5b',
  moderate:  '#c8b44a',
  high:      '#e8833a',
  very_high: '#e5484d',
};

export const RISK_THRESHOLDS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
export const RISK_LABELS = ['Very low', 'Low', 'Moderate', 'High', 'Very high'];

export const FACILITY_COLORS = {
  hospital: '#5eead4',
  shelter:  '#8ab4ff',
};

export const ROUTE_COLORS = {
  shortest: '#9aa7a0',
  safest:   '#7dff9b',
};

// Overpass API mirrors
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export const OVERPASS_TIMEOUT = 30; // seconds

export const HIGHWAY_TYPES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential';

// Nominatim
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Road fetch radii
export const FETCH_RADII = [6000, 12000, 20000];

// Default AHP weights (overridden from meta.json at runtime)
export const DEFAULT_WEIGHTS = {
  flood: 0.35,
  landslide: 0.35,
  slope: 0.20,
  exposure: 0.10,
};

// Risk aversion default
export const DEFAULT_LAMBDA = 3;

// Routing edge cost: length * (1 + lambda * risk)
export const MAX_LAMBDA = 10;

// Data paths (relative to repo root)
export const DATA_PATH = 'data';
export const REGIONS_FILE = 'data/regions.json';
