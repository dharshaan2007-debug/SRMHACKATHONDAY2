/**
 * ui.js – UI initialization, event bindings, panel rendering.
 */

import { getMap, resetView, toggleTerrain, setTerrainExaggeration, setHazardOpacity } from './map3d.js';
import { getWeights, setWeights, resetToAHP, getAHPInfo } from './risk.js';
import { classifyRisk, riskLabel, riskMod, formatRisk, formatDist, round } from './utils.js';
import { sampleAt, compositeRisk, getMeta } from './hazard-raster.js';
import { compareRoutes } from './router.js';

let onLayerChange = null;
let onWeightsChange = null;
let onStartPointSet = null;
let onDestTypeChange = null;
let onLambdaChange = null;
let onAvoidHighChange = null;
let currentHazardMode = 'composite';

/**
 * Initialize all UI elements and bindings.
 */
export function initUI(callbacks) {
  onLayerChange = callbacks.onLayerChange;
  onWeightsChange = callbacks.onWeightsChange;
  onStartPointSet = callbacks.onStartPointSet;
  onDestTypeChange = callbacks.onDestTypeChange;
  onLambdaChange = callbacks.onLambdaChange;
  onAvoidHighChange = callbacks.onAvoidHighChange;

  initLayerToggles();
  initWeightSliders();
  initRouteControls();
  initMapControls();
  initMethodology();
  initMobilePanel();
}

function initLayerToggles() {
  const container = document.getElementById('layer-toggles');
  if (!container) return;

  const layers = [
    { id: 'composite', label: 'Composite risk', active: true },
    { id: 'flood', label: 'Flood hazard' },
    { id: 'landslide', label: 'Landslide hazard' },
    { id: 'slope', label: 'Slope' },
    { id: 'exposure', label: 'Population exposure' },
  ];

  container.innerHTML = layers.map(l => `
    <div class="toggle ${l.active ? 'active' : ''}" data-layer="${l.id}" tabindex="0" role="button">
      <span class="toggle__dot"></span>
      <span>${l.label}</span>
    </div>
  `).join('');

  container.addEventListener('click', (e) => {
    const toggle = e.target.closest('.toggle');
    if (!toggle) return;

    container.querySelectorAll('.toggle').forEach(t => t.classList.remove('active'));
    toggle.classList.add('active');
    currentHazardMode = toggle.dataset.layer;
    if (onLayerChange) onLayerChange(currentHazardMode);
  });
}

function initWeightSliders() {
  const weights = getWeights();
  const sliders = [
    { id: 'flood', label: 'Flood' },
    { id: 'landslide', label: 'Landslide' },
    { id: 'slope', label: 'Slope' },
    { id: 'exposure', label: 'Exposure' },
  ];

  const container = document.getElementById('weight-sliders');
  if (!container) return;

  container.innerHTML = sliders.map(s => `
    <div class="slider-group">
      <div class="slider-group__header">
        <span class="slider-group__label">${s.label}</span>
        <span class="slider-group__value mono" id="weight-val-${s.id}">${(weights[s.id] * 100).toFixed(0)}%</span>
      </div>
      <input type="range" id="weight-${s.id}" min="0" max="100" value="${Math.round(weights[s.id] * 100)}" step="1">
    </div>
  `).join('');

  container.innerHTML += `<button class="btn btn--small" id="btn-reset-ahp" style="margin-top:var(--sp-1)">Reset to AHP weights</button>`;

  // Slider change handler
  for (const s of sliders) {
    const input = document.getElementById(`weight-${s.id}`);
    input.addEventListener('input', () => {
      updateWeightsFromSliders();
    });
  }

  // Reset button
  document.getElementById('btn-reset-ahp').addEventListener('click', () => {
    const w = resetToAHP();
    updateSliderValues(w);
    if (onWeightsChange) onWeightsChange(w);
  });
}

function updateWeightsFromSliders() {
  const raw = {
    flood: parseInt(document.getElementById('weight-flood').value) / 100,
    landslide: parseInt(document.getElementById('weight-landslide').value) / 100,
    slope: parseInt(document.getElementById('weight-slope').value) / 100,
    exposure: parseInt(document.getElementById('weight-exposure').value) / 100,
  };
  const normalized = setWeights(raw);
  // Update displayed percentages
  for (const [k, v] of Object.entries(normalized)) {
    const el = document.getElementById(`weight-val-${k}`);
    if (el) el.textContent = `${(v * 100).toFixed(0)}%`;
  }
  if (onWeightsChange) onWeightsChange(normalized);
}

function updateSliderValues(weights) {
  for (const [k, v] of Object.entries(weights)) {
    const slider = document.getElementById(`weight-${k}`);
    const val = document.getElementById(`weight-val-${k}`);
    if (slider) slider.value = Math.round(v * 100);
    if (val) val.textContent = `${(v * 100).toFixed(0)}%`;
  }
}

function initRouteControls() {
  // Destination type buttons
  const destBtns = document.querySelectorAll('.dest-selector .btn');
  destBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      destBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (onDestTypeChange) onDestTypeChange(btn.dataset.dest);
    });
  });

  // Lambda slider
  const lambdaSlider = document.getElementById('lambda-slider');
  if (lambdaSlider) {
    lambdaSlider.addEventListener('input', () => {
      const val = parseFloat(lambdaSlider.value);
      document.getElementById('lambda-val').textContent = val.toFixed(1);
      if (onLambdaChange) onLambdaChange(val);
    });
  }

  // Avoid very high checkbox
  const avoidCheck = document.getElementById('avoid-very-high');
  if (avoidCheck) {
    avoidCheck.addEventListener('change', () => {
      if (onAvoidHighChange) onAvoidHighChange(avoidCheck.checked);
    });
  }
}

function initMapControls() {
  // 3D toggle
  const toggle3d = document.getElementById('btn-3d');
  if (toggle3d) {
    toggle3d.addEventListener('click', () => {
      const is3d = toggle3d.classList.toggle('active');
      toggleTerrain(is3d);
      toggle3d.textContent = is3d ? '3D' : '2D';
    });
  }

  // Terrain exaggeration
  const terrainSlider = document.getElementById('terrain-exag');
  if (terrainSlider) {
    terrainSlider.addEventListener('input', () => {
      setTerrainExaggeration(parseFloat(terrainSlider.value));
    });
  }

  // Reset view
  const resetBtn = document.getElementById('btn-reset-view');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetView);
  }

  // Hazard opacity
  const opacitySlider = document.getElementById('hazard-opacity');
  if (opacitySlider) {
    opacitySlider.addEventListener('input', () => {
      setHazardOpacity(parseFloat(opacitySlider.value));
    });
  }
}

function initMethodology() {
  const btn = document.getElementById('btn-methodology');
  const drawer = document.getElementById('methodology-drawer');
  const overlay = document.getElementById('methodology-overlay');
  const closeBtn = document.getElementById('methodology-close');

  if (!btn || !drawer) return;

  const toggle = (open) => {
    drawer.classList.toggle('open', open);
    overlay?.classList.toggle('open', open);
  };

  btn.addEventListener('click', () => toggle(true));
  closeBtn?.addEventListener('click', () => toggle(false));
  overlay?.addEventListener('click', () => toggle(false));
}

function initMobilePanel() {
  const handle = document.querySelector('.panel__handle');
  const panel = document.querySelector('.panel');
  if (!handle || !panel) return;

  handle.addEventListener('click', () => {
    panel.classList.toggle('expanded');
  });
}

/**
 * Show status message.
 */
export function showStatus(text, progress = -1) {
  const bar = document.getElementById('statusbar');
  if (!bar) return;
  bar.classList.add('active');
  bar.querySelector('.statusbar__text').textContent = text;
  const prog = bar.querySelector('.statusbar__progress-bar');
  if (prog) {
    prog.style.width = progress >= 0 ? `${progress}%` : '0%';
    bar.querySelector('.statusbar__progress').style.display = progress >= 0 ? 'block' : 'none';
  }
}

/**
 * Hide status message.
 */
export function hideStatus() {
  const bar = document.getElementById('statusbar');
  if (bar) bar.classList.remove('active');
}

/**
 * Show error in status.
 */
export function showError(text) {
  showStatus(text);
  const bar = document.getElementById('statusbar');
  if (bar) bar.style.color = 'var(--risk-high)';
  setTimeout(() => {
    if (bar) bar.style.color = '';
    hideStatus();
  }, 5000);
}

/**
 * Update risk readout for a point.
 */
export function updateRiskReadout(lat, lon, weights) {
  const el = document.getElementById('risk-readout');
  if (!el) return;

  const sample = sampleAt(lat, lon);
  if (!sample || !sample.landMask) {
    el.innerHTML = '<div class="empty-text">Outside coverage area</div>';
    return;
  }

  const composite = compositeRisk(sample, weights);
  const cls = classifyRisk(composite);

  el.innerHTML = `
    <div class="risk-readout">
      <div class="risk-readout__row">
        <span class="risk-readout__label">Composite risk</span>
        <span class="risk-readout__value" style="color:var(--risk-${riskMod(cls)})">${formatRisk(composite)}</span>
      </div>
      <div class="risk-readout__row">
        <span class="risk-readout__label">Classification</span>
        <span class="risk-badge risk-badge--${riskMod(cls)}"><span class="risk-badge__dot"></span>${riskLabel(cls)}</span>
      </div>
      <div class="risk-readout__row">
        <span class="risk-readout__label">Flood</span>
        <span class="risk-readout__value mono">${formatRisk(sample.flood)}</span>
      </div>
      <div class="risk-readout__row">
        <span class="risk-readout__label">Landslide</span>
        <span class="risk-readout__value mono">${formatRisk(sample.landslide)}</span>
      </div>
      <div class="risk-readout__row">
        <span class="risk-readout__label">Slope</span>
        <span class="risk-readout__value mono">${formatRisk(sample.slope)}</span>
      </div>
      <div class="risk-readout__row">
        <span class="risk-readout__label">Exposure</span>
        <span class="risk-readout__value mono">${formatRisk(sample.exposure)}</span>
      </div>
    </div>
    <div class="coords mono">${lat.toFixed(6)}°N, ${lon.toFixed(6)}°E</div>
  `;
}

/**
 * Show route comparison card.
 */
export function showRouteCard(safestResult, shortestResult) {
  const card = document.getElementById('route-card');
  if (!card || !safestResult) return;

  const ss = safestResult.stats;
  const sh = shortestResult?.stats;

  let extraPct = 0;
  if (sh && sh.distance > 0) {
    extraPct = ((ss.distance - sh.distance) / sh.distance * 100);
  }

  let html = `
    <div class="route-card__title">Route comparison</div>
    <button class="btn btn--icon route-card__close" id="btn-close-route" aria-label="Close">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>
    </button>
    <div class="route-compare">
      <div class="route-compare__col route-compare__col--shortest">
        <div class="route-compare__col-title">Shortest</div>
        ${sh ? `
          <div class="route-compare__row"><span>Distance</span><span>${formatDist(sh.distance)}</span></div>
          <div class="route-compare__row"><span>Mean risk</span><span>${formatRisk(sh.meanRisk)}</span></div>
          <div class="route-compare__row"><span>Max risk</span><span>${formatRisk(sh.maxRisk)}</span></div>
          <div class="route-compare__row"><span>Very high segs</span><span>${sh.veryHighSegments}</span></div>
        ` : '<div class="empty-text">No path</div>'}
      </div>
      <div class="route-compare__col route-compare__col--safest">
        <div class="route-compare__col-title">Least-risk</div>
        <div class="route-compare__row"><span>Distance</span><span>${formatDist(ss.distance)}</span></div>
        <div class="route-compare__row"><span>Mean risk</span><span>${formatRisk(ss.meanRisk)}</span></div>
        <div class="route-compare__row"><span>Max risk</span><span>${formatRisk(ss.maxRisk)}</span></div>
        <div class="route-compare__row"><span>Very high segs</span><span>${ss.veryHighSegments}</span></div>
      </div>
    </div>
  `;

  if (sh && extraPct !== 0) {
    html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:var(--sp-2);font-family:var(--font-mono)">Extra distance +${extraPct.toFixed(1)}%</div>`;
  }

  const rec = compareRoutes(safestResult, shortestResult);
  html += `<div class="route-card__recommendation">${rec}</div>`;

  card.innerHTML = html;
  card.classList.add('active');

  // Close button
  document.getElementById('btn-close-route')?.addEventListener('click', () => {
    card.classList.remove('active');
  });
}

/**
 * Hide route card.
 */
export function hideRouteCard() {
  const card = document.getElementById('route-card');
  if (card) card.classList.remove('active');
}

/**
 * Update dashboard content.
 */
export function updateDashboard(html) {
  const el = document.getElementById('dashboard-content');
  if (el) el.innerHTML = html;
}

/**
 * Fill methodology drawer with data from meta.
 */
export function fillMethodology(meta) {
  const el = document.getElementById('methodology-content');
  if (!el || !meta) return;

  const ahp = meta.ahp;
  const normInfo = meta.normalization;

  el.innerHTML = `
    <h2>Data pipeline</h2>
    <div class="pipeline-diagram">
      <div class="pipeline-step">
        <div class="pipeline-step__icon"><svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4v4l3 2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></div>
        <div class="pipeline-step__label">Satellite data</div>
      </div>
      <div class="pipeline-arrow">→</div>
      <div class="pipeline-step">
        <div class="pipeline-step__icon"><svg viewBox="0 0 16 16" width="16" height="16"><rect x="3" y="3" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>
        <div class="pipeline-step__label">GEE processing</div>
      </div>
      <div class="pipeline-arrow">→</div>
      <div class="pipeline-step">
        <div class="pipeline-step__icon"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 12l5-8 3 4 4-6" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></div>
        <div class="pipeline-step__label">Hazard index</div>
      </div>
      <div class="pipeline-arrow">→</div>
      <div class="pipeline-step">
        <div class="pipeline-step__icon"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 2l6 12H2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>
        <div class="pipeline-step__label">3D map + routing</div>
      </div>
    </div>

    <h2>Data sources</h2>
    <table>
      <tr><th>Dataset</th><th>GEE Collection</th></tr>
      ${Object.entries(meta.sources || {}).map(([k, v]) =>
    `<tr><td>${k}</td><td><code>${v}</code></td></tr>`
  ).join('')}
    </table>
    <p>Date ranges: CHIRPS ${meta.date_ranges?.chirps?.start || '2020'} – ${meta.date_ranges?.chirps?.end || '2025'}, 
    MODIS NDVI ${meta.date_ranges?.modis_ndvi?.start || '2023'} – ${meta.date_ranges?.modis_ndvi?.end || '2025'},
    WorldCover ${meta.date_ranges?.worldcover || '2021'}.</p>

    <h2>Flood hazard factors</h2>
    <table>
      <tr><th>Factor</th><th>Weight</th></tr>
      ${Object.entries(meta.flood_factors || {}).map(([k, v]) =>
    `<tr><td>${k.replace(/_/g, ' ')}</td><td>${(v * 100).toFixed(0)}%</td></tr>`
  ).join('')}
    </table>

    <h2>Landslide hazard factors</h2>
    <table>
      <tr><th>Factor</th><th>Weight</th></tr>
      ${Object.entries(meta.landslide_factors || {}).map(([k, v]) =>
    `<tr><td>${k.replace(/_/g, ' ')}</td><td>${(v * 100).toFixed(0)}%</td></tr>`
  ).join('')}
    </table>

    <h2>AHP weighting</h2>
    <p>Analytic Hierarchy Process (Saaty, 1980) applied to ${ahp?.criteria?.length || 4} criteria.</p>
    ${ahp ? `
      <table>
        <tr><th></th>${ahp.criteria.map(c => `<th>${c}</th>`).join('')}</tr>
        ${ahp.matrix.map((row, i) => `
          <tr><th>${ahp.criteria[i]}</th>${row.map(v => `<td>${typeof v === 'number' ? v.toFixed(2) : v}</td>`).join('')}</tr>
        `).join('')}
      </table>
      <p>Weights: ${ahp.criteria.map((c, i) => `${c} = <code>${(ahp.weights[c] * 100).toFixed(1)}%</code>`).join(', ')}</p>
      <p>λ<sub>max</sub> = <code>${ahp.lambda_max?.toFixed(4)}</code>, 
         CI = <code>${ahp.ci?.toFixed(4)}</code>, 
         CR = <code>${ahp.cr?.toFixed(4)}</code> (< 0.10 ✓)</p>
    ` : ''}

    <h2>Normalization</h2>
    <p>${normInfo?.method || 'Min-max with 2nd/98th percentile clipping'}</p>
    <p>Formula: <code>x_norm = (x - p2) / (p98 - p2)</code>, clamped to [0, 1].</p>

    <h2>Risk index</h2>
    <p>Composite risk = Σ (w<sub>i</sub> × h<sub>i</sub>), where w<sub>i</sub> are AHP weights and h<sub>i</sub> are normalized hazard values.</p>

    <h2>Routing edge cost</h2>
    <p><code>cost = length_m × (1 + λ × segment_risk)</code></p>
    <p>λ (risk aversion) is adjustable from 0 (pure shortest) to 10 (strongly risk-averse).</p>

    <h2>Limitations</h2>
    <ul>
      ${(meta.limitations || []).map(l => `<li>${l}</li>`).join('')}
    </ul>

    <p style="margin-top:var(--sp-6);color:var(--text-dim);font-size:11px">
      Built: ${meta.build_time || 'N/A'} | Resolution: ${meta.pixel_size_m || 500}m | CRS: ${meta.crs || 'EPSG:4326'}
    </p>
  `;
}

/**
 * Get current hazard display mode.
 */
export function getHazardMode() {
  return currentHazardMode;
}
