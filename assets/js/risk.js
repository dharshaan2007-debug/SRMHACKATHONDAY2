/**
 * risk.js – Weighted-sum risk computation, AHP normalization, classification.
 */

import { classifyRisk, riskLabel } from './utils.js';
import { DEFAULT_WEIGHTS } from './config.js';

let currentWeights = { ...DEFAULT_WEIGHTS };
let metaWeights = null; // AHP weights from meta.json

/**
 * Initialize weights from meta.json AHP data.
 */
export function initWeightsFromMeta(meta) {
  if (meta?.ahp?.weights) {
    metaWeights = { ...meta.ahp.weights };
    currentWeights = { ...metaWeights };
  }
}

/**
 * Get current weights (normalized to sum = 1).
 */
export function getWeights() {
  return normalizeWeights(currentWeights);
}

/**
 * Set weights from slider values and normalize.
 */
export function setWeights(raw) {
  currentWeights = normalizeWeights(raw);
  return currentWeights;
}

/**
 * Reset to AHP weights from meta.json.
 */
export function resetToAHP() {
  if (metaWeights) {
    currentWeights = { ...metaWeights };
  } else {
    currentWeights = { ...DEFAULT_WEIGHTS };
  }
  return currentWeights;
}

/**
 * Normalize weights to sum to 1.
 */
export function normalizeWeights(w) {
  const sum = (w.flood || 0) + (w.landslide || 0) + (w.slope || 0) + (w.exposure || 0);
  if (sum <= 0) return { flood: 0.25, landslide: 0.25, slope: 0.25, exposure: 0.25 };
  return {
    flood: w.flood / sum,
    landslide: w.landslide / sum,
    slope: w.slope / sum,
    exposure: w.exposure / sum,
  };
}

/**
 * Compute composite risk from individual hazard values.
 */
export function computeComposite(sample, weights) {
  if (!sample) return null;
  const w = weights || currentWeights;
  return sample.flood * w.flood +
    sample.landslide * w.landslide +
    sample.slope * w.slope +
    sample.exposure * w.exposure;
}

/**
 * Classify composite risk and return { value, class, label, color }.
 */
export function classifyComposite(value) {
  const cls = classifyRisk(value);
  return {
    value,
    class: cls,
    label: riskLabel(cls),
  };
}

/**
 * Get AHP info from meta for display.
 */
export function getAHPInfo(meta) {
  if (!meta?.ahp) return null;
  return {
    criteria: meta.ahp.criteria,
    matrix: meta.ahp.matrix,
    weights: meta.ahp.weights,
    lambdaMax: meta.ahp.lambda_max,
    ci: meta.ahp.ci,
    cr: meta.ahp.cr,
  };
}
