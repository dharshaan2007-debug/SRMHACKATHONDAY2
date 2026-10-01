/**
 * dashboard.js – State/district summary, local area stats.
 */

import { classifyRisk, riskLabel, riskMod, formatRisk, round } from './utils.js';
import { compositeRiskAt, sampleAt } from './hazard-raster.js';

/**
 * Compute state summary from districts GeoJSON.
 */
export function computeStateSummary(districts) {
  if (!districts?.features?.length) return null;

  const classes = { very_low: 0, low: 0, moderate: 0, high: 0, very_high: 0 };
  let totalPixels = 0;

  for (const f of districts.features) {
    const cls = f.properties.risk_class;
    const px = f.properties.pixel_count || 1;
    if (classes[cls] !== undefined) classes[cls] += px;
    totalPixels += px;
  }

  const shares = {};
  for (const [k, v] of Object.entries(classes)) {
    shares[k] = totalPixels > 0 ? v / totalPixels : 0;
  }

  const top5 = districts.features
    .sort((a, b) => b.properties.composite_risk - a.properties.composite_risk)
    .slice(0, 5)
    .map(f => ({
      name: f.properties.name,
      risk: f.properties.composite_risk,
      class: f.properties.risk_class,
    }));

  return { shares, top5, districtCount: districts.features.length, totalPixels };
}

/**
 * Compute local area stats around a point.
 */
export function computeLocalStats(osmData, weights) {
  const result = {
    hospitals: [],
    shelters: [],
    settlements: [],
    highRiskFacilities: [],
    riskiestSettlements: [],
  };

  // Hospitals with risk
  for (const h of osmData.hospitals || []) {
    const risk = compositeRiskAt(h.lat, h.lon, weights);
    result.hospitals.push({ ...h, risk: risk ?? 0, riskClass: classifyRisk(risk ?? 0) });
  }

  // Shelters with risk
  for (const s of osmData.shelters || []) {
    const risk = compositeRiskAt(s.lat, s.lon, weights);
    result.shelters.push({ ...s, risk: risk ?? 0, riskClass: classifyRisk(risk ?? 0) });
  }

  // Settlements with risk
  for (const s of osmData.settlements || []) {
    const risk = compositeRiskAt(s.lat, s.lon, weights);
    result.settlements.push({ ...s, risk: risk ?? 0, riskClass: classifyRisk(risk ?? 0) });
  }

  // High/very-high risk facilities
  result.highRiskFacilities = [
    ...result.hospitals.filter(h => h.risk >= 0.6),
    ...result.shelters.filter(s => s.risk >= 0.6),
  ];

  // Top 5 riskiest settlements
  result.riskiestSettlements = [...result.settlements]
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 5);

  return result;
}

/**
 * Render state summary HTML.
 */
export function renderStateSummary(summary) {
  if (!summary) return '<p class="empty-text">No district data loaded</p>';

  let html = '';

  // Risk distribution bar
  html += '<div class="risk-legend">';
  for (const cls of ['very_low', 'low', 'moderate', 'high', 'very_high']) {
    const pct = (summary.shares[cls] * 100).toFixed(1);
    const color = getCSSVar(`--risk-${riskMod(cls)}`);
    html += `<div class="risk-legend__bar" style="flex:${Math.max(0.5, summary.shares[cls] * 10)};background:${color}" title="${riskLabel(cls)}: ${pct}%"></div>`;
  }
  html += '</div>';
  html += '<div class="risk-legend__labels"><span>Very low</span><span>Very high</span></div>';

  // Stats grid
  html += '<div class="stats-grid" style="margin-top:var(--sp-3)">';
  html += renderStatTile('Districts', summary.districtCount, '');
  const highPct = ((summary.shares.high + summary.shares.very_high) * 100).toFixed(1);
  html += renderStatTile('High + Very high', `${highPct}%`, 'of area');
  html += '</div>';

  // Top 5 highest risk districts
  html += `<div style="margin-top:var(--sp-3)">`;
  html += `<div class="panel__section-title">Highest-risk districts</div>`;
  for (const d of summary.top5) {
    html += `<div class="list-item">
      <span class="list-item__name">${d.name}</span>
      <span><span class="risk-badge risk-badge--${riskMod(d.class)}"><span class="risk-badge__dot"></span>${riskLabel(d.class)}</span> <span class="list-item__value">${formatRisk(d.risk)}</span></span>
    </div>`;
  }
  html += '</div>';

  return html;
}

/**
 * Render local area stats HTML.
 */
export function renderLocalStats(stats) {
  let html = '';

  html += '<div class="stats-grid">';
  html += renderStatTile('Hospitals', stats.hospitals.length, 'found');
  html += renderStatTile('Shelters', stats.shelters.length, 'found');
  html += '</div>';

  if (stats.highRiskFacilities.length > 0) {
    html += `<div style="margin-top:var(--sp-3)">`;
    html += `<div class="panel__section-title" style="color:var(--risk-high)">At-risk facilities</div>`;
    for (const f of stats.highRiskFacilities.slice(0, 5)) {
      html += `<div class="list-item">
        <span class="list-item__name">${f.name}</span>
        <span class="risk-badge risk-badge--${riskMod(f.riskClass)}"><span class="risk-badge__dot"></span>${formatRisk(f.risk)}</span>
      </div>`;
    }
    html += '</div>';
  }

  if (stats.riskiestSettlements.length > 0) {
    html += `<div style="margin-top:var(--sp-3)">`;
    html += `<div class="panel__section-title">Riskiest settlements</div>`;
    for (const s of stats.riskiestSettlements) {
      html += `<div class="list-item">
        <span class="list-item__name">${s.name}</span>
        <span class="risk-badge risk-badge--${riskMod(s.riskClass)}"><span class="risk-badge__dot"></span>${formatRisk(s.risk)}</span>
      </div>`;
    }
    html += '</div>';
  }

  return html;
}

function renderStatTile(label, value, sub) {
  return `<div class="stat-tile">
    <div class="stat-tile__label">${label}</div>
    <div class="stat-tile__value mono">${value}</div>
    ${sub ? `<div class="stat-tile__sub">${sub}</div>` : ''}
  </div>`;
}

function getCSSVar(name) {
  const map = {
    '--risk-very-low': '#16403a',
    '--risk-low': '#2f7d5b',
    '--risk-moderate': '#c8b44a',
    '--risk-high': '#e8833a',
    '--risk-very-high': '#e5484d',
  };
  return map[name] || '#555';
}
