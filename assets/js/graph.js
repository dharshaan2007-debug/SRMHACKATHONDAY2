/**
 * graph.js – Build road graph from OSM ways, spatial index, node snapping.
 *
 * BUG 1 FIXES:
 *  - Node key uses toFixed(6) so adjacent way nodes share the same key (graph connectivity).
 *  - Facility snap radius: 1 km (was 500 m).
 *  - One-way handling: if ignoreOneway=true, all edges are bidirectional (retry path).
 *  - Exports buildGraphIgnoreOneway for oneway-ignore retry.
 */

import { haversine } from './utils.js';
import { sampleAt, compositeRisk } from './hazard-raster.js';

/**
 * Build a directed graph from OSM ways.
 * @param {object} osmData - { ways, hospitals, shelters }
 * @param {object} weights - { flood, landslide, slope, exposure }
 * @param {boolean} [ignoreOneway=false] - treat all roads as bidirectional
 */
export function buildGraph(osmData, weights, ignoreOneway = false) {
  const nodes = new Map(); // key → node
  const edges = [];

  function nodeKey(lat, lon) {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  function getOrCreate(lat, lon) {
    const k = nodeKey(lat, lon);
    if (!nodes.has(k)) {
      nodes.set(k, { lat, lon, key: k, edges: [], facilityType: null, facilityName: null });
    }
    return nodes.get(k);
  }

  for (const way of osmData.ways) {
    const coords = way.coords;
    if (!coords || coords.length < 2) continue;

    const isOneway  = !ignoreOneway && (way.oneway === 'yes' || way.oneway === '1' || way.oneway === 'true');
    const isReverse = !ignoreOneway && way.oneway === '-1';

    for (let i = 0; i < coords.length - 1; i++) {
      const [lat1, lon1] = coords[i];
      const [lat2, lon2] = coords[i + 1];

      if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) continue;

      const n1 = getOrCreate(lat1, lon1);
      const n2 = getOrCreate(lat2, lon2);

      const dist = haversine(lat1, lon1, lat2, lon2);
      if (dist < 0.5) continue; // sub-meter, skip

      const risk = sampleSegmentRisk(lat1, lon1, lat2, lon2, weights, dist);

      const fwd = { from: n1.key, to: n2.key, dist, risk, highway: way.highway, name: way.name };
      const rev = { from: n2.key, to: n1.key, dist, risk, highway: way.highway, name: way.name };

      if (isReverse) {
        edges.push(rev); n2.edges.push(rev);
      } else if (isOneway) {
        edges.push(fwd); n1.edges.push(fwd);
      } else {
        edges.push(fwd); n1.edges.push(fwd);
        edges.push(rev); n2.edges.push(rev);
      }
    }
  }

  // Build spatial index before facility snapping
  const nodeIndex = buildSpatialIndex(nodes);

  // Snap hospitals to nearest road node (within 1 km)
  for (const h of osmData.hospitals || []) {
    const snap = findNearest(nodeIndex, nodes, h.lat, h.lon, 1000);
    if (snap) {
      snap.facilityType = 'hospital';
      snap.facilityName = h.name;
    } else {
      const n = getOrCreate(h.lat, h.lon);
      n.facilityType = 'hospital';
      n.facilityName = h.name;
    }
  }

  // Snap shelters (within 1 km), don't overwrite existing hospital
  for (const s of osmData.shelters || []) {
    const snap = findNearest(nodeIndex, nodes, s.lat, s.lon, 1000);
    if (snap) {
      if (!snap.facilityType) {
        snap.facilityType = 'shelter';
        snap.facilityName = s.name;
      }
    } else {
      const n = getOrCreate(s.lat, s.lon);
      n.facilityType = 'shelter';
      n.facilityName = s.name;
    }
  }

  const finalIndex = buildSpatialIndex(nodes);

  const debug = window.__osm_debug || {};
  Object.assign(debug, { nodes: nodes.size, edges: edges.length });
  window.__osm_debug = debug;
  console.log(`[Graph] ${nodes.size} nodes, ${edges.length} edges, ignoreOneway=${ignoreOneway}`);

  return { nodes, edges, nodeIndex: finalIndex };
}

/** Convenience: build with all edges bidirectional */
export function buildGraphIgnoreOneway(osmData, weights) {
  return buildGraph(osmData, weights, true);
}

/**
 * Sample risk along a segment (up to 5 samples).
 */
function sampleSegmentRisk(lat1, lon1, lat2, lon2, weights, dist) {
  const n = Math.max(1, Math.min(5, Math.ceil(dist / 300)));
  let total = 0, valid = 0;
  for (let i = 0; i <= n; i++) {
    const t   = i / n;
    const lat = lat1 + (lat2 - lat1) * t;
    const lon = lon1 + (lon2 - lon1) * t;
    const s   = sampleAt(lat, lon);
    if (s && s.landMask) {
      const r = compositeRisk(s, weights);
      if (r !== null) { total += r; valid++; }
    }
  }
  return valid > 0 ? total / valid : 0.3;
}

/**
 * Recompute edge risks (called when AHP weights change).
 */
export function recomputeEdgeRisks(graph, weights) {
  for (const edge of graph.edges) {
    const fn = graph.nodes.get(edge.from);
    const tn = graph.nodes.get(edge.to);
    if (fn && tn) {
      edge.risk = sampleSegmentRisk(fn.lat, fn.lon, tn.lat, tn.lon, weights, edge.dist);
    }
  }
}

// ── Spatial index (grid) ─────────────────────────────────────────────────────
function buildSpatialIndex(nodes, cellSize = 0.005) {
  const grid = new Map();
  for (const [, node] of nodes) {
    const gx = Math.floor(node.lon / cellSize);
    const gy = Math.floor(node.lat / cellSize);
    const k  = `${gx},${gy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(node.key);
  }
  return { grid, cellSize };
}

export function findNearest(index, nodes, lat, lon, maxDistM = 2000) {
  const { grid, cellSize } = index;
  const radius = Math.ceil(maxDistM / 111000 / cellSize) + 1;
  const gx = Math.floor(lon / cellSize);
  const gy = Math.floor(lat / cellSize);
  let best = null, bestD = maxDistM;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const keys = grid.get(`${gx + dx},${gy + dy}`);
      if (!keys) continue;
      for (const k of keys) {
        const n = nodes.get(k);
        if (!n) continue;
        const d = haversine(lat, lon, n.lat, n.lon);
        if (d < bestD) { bestD = d; best = n; }
      }
    }
  }
  return best;
}
