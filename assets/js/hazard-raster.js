/**
 * hazard-raster.js – Load hazard PNGs, sample at coordinates, recolour for display.
 */

import { RISK_COLORS, RISK_THRESHOLDS } from './config.js';

let hazardsData = null;  // { width, height, data: Uint8ClampedArray }
let auxData = null;
let regionBbox = null;   // [west, south, east, north]
let regionMeta = null;

const riskRamp = [
  [22, 64, 58],     // very low
  [47, 125, 91],    // low
  [200, 180, 74],   // moderate
  [232, 131, 58],   // high
  [229, 72, 77],    // very high
];

/**
 * Load hazard and aux PNGs + meta.json for a region.
 */
export async function loadRegionRasters(regionId, basePath = 'data') {
  const metaUrl = `${basePath}/${regionId}/meta.json`;
  const hazUrl = `${basePath}/${regionId}/hazards.png`;
  const auxUrl = `${basePath}/${regionId}/aux_layers.png`;

  // Load meta
  const metaResp = await fetch(metaUrl);
  if (!metaResp.ok) throw new Error(`Failed to load meta.json: ${metaResp.status}`);
  regionMeta = await metaResp.json();
  regionBbox = regionMeta.bbox;

  // Load images
  const [hazImg, auxImg] = await Promise.all([
    loadImage(hazUrl),
    loadImage(auxUrl),
  ]);

  // Extract pixel data
  hazardsData = imageToData(hazImg);
  auxData = imageToData(auxImg);

  console.log(`Rasters loaded: ${hazardsData.width}x${hazardsData.height}`);
  return regionMeta;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

function imageToData(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return {
    width: img.width,
    height: img.height,
    data: imageData.data,
  };
}

/**
 * Get the pixel coordinates for a lat/lon.
 */
function latLonToPixel(lat, lon) {
  if (!regionBbox || !hazardsData) return null;
  const [west, south, east, north] = regionBbox;
  const x = Math.floor((lon - west) / (east - west) * hazardsData.width);
  const y = Math.floor((1 - (lat - south) / (north - south)) * hazardsData.height);
  if (x < 0 || x >= hazardsData.width || y < 0 || y >= hazardsData.height) return null;
  return { x, y };
}

/**
 * Sample raw hazard values at a lat/lon.
 * Returns { flood, landslide, slope, exposure, landMask } all 0-1.
 */
export function sampleAt(lat, lon) {
  const px = latLonToPixel(lat, lon);
  if (!px) return null;

  const idx = (px.y * hazardsData.width + px.x) * 4;
  const flood = hazardsData.data[idx] / 255;
  const landslide = hazardsData.data[idx + 1] / 255;
  const slope = hazardsData.data[idx + 2] / 255;

  const auxIdx = (px.y * auxData.width + px.x) * 4;
  const exposure = auxData.data[auxIdx] / 255;
  const landMask = auxData.data[auxIdx + 1] > 127;

  return { flood, landslide, slope, exposure, landMask };
}

/**
 * Compute composite risk at lat/lon with given weights.
 */
export function compositeRiskAt(lat, lon, weights) {
  const s = sampleAt(lat, lon);
  if (!s || !s.landMask) return null;
  return s.flood * weights.flood +
    s.landslide * weights.landslide +
    s.slope * weights.slope +
    s.exposure * weights.exposure;
}

/**
 * Compute composite risk from raw values.
 */
export function compositeRisk(sample, weights) {
  if (!sample || !sample.landMask) return null;
  return sample.flood * weights.flood +
    sample.landslide * weights.landslide +
    sample.slope * weights.slope +
    sample.exposure * weights.exposure;
}

/**
 * Create a recoloured canvas for map display.
 * @param {string} mode - 'composite', 'flood', 'landslide', 'slope', 'exposure'
 * @param {object} weights - { flood, landslide, slope, exposure }
 * @returns {HTMLCanvasElement}
 */
export function createHazardCanvas(mode, weights) {
  if (!hazardsData) return null;

  const { width, height, data } = hazardsData;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const out = imgData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const auxI = i; // Same pixel layout

      const landMask = auxData.data[auxI + 1] > 127;
      if (!landMask) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 0;
        continue;
      }

      const flood = data[i] / 255;
      const landslide = data[i + 1] / 255;
      const slope = data[i + 2] / 255;
      const exposure = auxData.data[auxI] / 255;

      let value;
      switch (mode) {
        case 'flood':     value = flood; break;
        case 'landslide': value = landslide; break;
        case 'slope':     value = slope; break;
        case 'exposure':  value = exposure; break;
        case 'composite':
        default:
          value = flood * weights.flood +
            landslide * weights.landslide +
            slope * weights.slope +
            exposure * weights.exposure;
          break;
      }

      value = Math.max(0, Math.min(1, value));
      const [r, g, b] = riskToColor(value);
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 170; // ~67% opacity
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Map a 0-1 value to an RGB color using the risk ramp.
 */
function riskToColor(v) {
  v = Math.max(0, Math.min(1, v));
  // 5 stops at 0, 0.25, 0.5, 0.75, 1.0
  const t = v * 4;
  const idx = Math.min(3, Math.floor(t));
  const frac = t - idx;
  const c0 = riskRamp[idx];
  const c1 = riskRamp[Math.min(4, idx + 1)];
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * frac),
    Math.round(c0[1] + (c1[1] - c0[1]) * frac),
    Math.round(c0[2] + (c1[2] - c0[2]) * frac),
  ];
}

/** Get loaded meta */
export function getMeta() { return regionMeta; }

/** Get loaded bbox */
export function getBbox() { return regionBbox; }

/** Check if rasters are loaded */
export function isLoaded() { return hazardsData !== null; }
