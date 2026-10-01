/**
 * graph.js – Build road graph from OSM ways, spatial index, snapping.
 */

import { haversine } from './utils.js';
import { sampleAt, compositeRisk } from './hazard-raster.js';

/**
 * Build a directed graph from OSM ways.
 * Nodes keyed by "lat,lon" (6 decimals).
 * Returns { nodes: Map, edges: [], nodeIndex: SpatialIndex }
 */
export function buildGraph(osmData, weights) {
  const nodes = new Map(); // key -> { lat, lon, edges: [] }
  const edges = [];

  function nodeKey(lat, lon) {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  function getOrCreateNode(lat, lon) {
    const key = nodeKey(lat, lon);
    if (!nodes.has(key)) {
      nodes.set(key, { lat, lon, key, edges: [], facilityType: null, facilityName: null });
    }
    return nodes.get(key);
  }

  // Add road edges
  for (const way of osmData.ways) {
    const coords = way.coords;
    const isOneway = way.oneway === 'yes' || way.oneway === '1' || way.oneway === 'true';
    const isReverse = way.oneway === '-1';

    for (let i = 0; i < coords.length - 1; i++) {
      const [lat1, lon1] = coords[i];
      const [lat2, lon2] = coords[i + 1];
      const n1 = getOrCreateNode(lat1, lon1);
      const n2 = getOrCreateNode(lat2, lon2);

      const dist = haversine(lat1, lon1, lat2, lon2);
      if (dist < 0.5) continue; // Skip near-zero segments

      // Sample risk along the segment
      const risk = sampleSegmentRisk(lat1, lon1, lat2, lon2, weights, dist);

      const edge = {
        from: n1.key,
        to: n2.key,
        dist,
        risk,
        highway: way.highway,
        name: way.name,
      };

      if (isReverse) {
        // Reverse oneway: only n2 -> n1
        const revEdge = { ...edge, from: n2.key, to: n1.key };
        edges.push(revEdge);
        n2.edges.push(revEdge);
      } else if (isOneway) {
        // Forward oneway: only n1 -> n2
        edges.push(edge);
        n1.edges.push(edge);
      } else {
        // Bidirectional
        edges.push(edge);
        n1.edges.push(edge);
        const revEdge = { ...edge, from: n2.key, to: n1.key };
        edges.push(revEdge);
        n2.edges.push(revEdge);
      }
    }
  }

  // Add facility nodes (snap to nearest road node)
  const nodeIndex = buildSpatialIndex(nodes);

  for (const h of osmData.hospitals || []) {
    const nearest = findNearest(nodeIndex, nodes, h.lat, h.lon, 500);
    if (nearest) {
      nearest.facilityType = 'hospital';
      nearest.facilityName = h.name;
    } else {
      // Create standalone node
      const n = getOrCreateNode(h.lat, h.lon);
      n.facilityType = 'hospital';
      n.facilityName = h.name;
    }
  }

  for (const s of osmData.shelters || []) {
    const nearest = findNearest(nodeIndex, nodes, s.lat, s.lon, 500);
    if (nearest) {
      if (!nearest.facilityType) {
        nearest.facilityType = 'shelter';
        nearest.facilityName = s.name;
      }
    } else {
      const n = getOrCreateNode(s.lat, s.lon);
      n.facilityType = 'shelter';
      n.facilityName = s.name;
    }
  }

  // Rebuild spatial index with any new facility nodes
  const finalIndex = buildSpatialIndex(nodes);

  return { nodes, edges, nodeIndex: finalIndex };
}

/**
 * Sample hazard risk along a road segment.
 * For segments > 200m, sample intermediate points.
 */
function sampleSegmentRisk(lat1, lon1, lat2, lon2, weights, dist) {
  const numSamples = Math.max(1, Math.ceil(dist / 200));
  let totalRisk = 0;
  let validSamples = 0;

  for (let i = 0; i <= numSamples; i++) {
    const t = numSamples > 0 ? i / numSamples : 0.5;
    const lat = lat1 + (lat2 - lat1) * t;
    const lon = lon1 + (lon2 - lon1) * t;
    const sample = sampleAt(lat, lon);
    if (sample && sample.landMask) {
      const r = compositeRisk(sample, weights);
      if (r !== null) {
        totalRisk += r;
        validSamples++;
      }
    }
  }

  return validSamples > 0 ? totalRisk / validSamples : 0.3; // Default moderate risk
}

/**
 * Simple grid-based spatial index for fast nearest-node lookup.
 */
function buildSpatialIndex(nodes, cellSize = 0.005) {
  const grid = new Map();

  for (const [key, node] of nodes) {
    const gx = Math.floor(node.lon / cellSize);
    const gy = Math.floor(node.lat / cellSize);
    const gkey = `${gx},${gy}`;
    if (!grid.has(gkey)) grid.set(gkey, []);
    grid.get(gkey).push(key);
  }

  return { grid, cellSize };
}

/**
 * Find nearest node within maxDist meters.
 */
export function findNearest(index, nodes, lat, lon, maxDist = 500) {
  const { grid, cellSize } = index;
  const searchRadius = Math.ceil(maxDist / 111000 / cellSize) + 1;
  const gx = Math.floor(lon / cellSize);
  const gy = Math.floor(lat / cellSize);

  let bestNode = null;
  let bestDist = maxDist;

  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const gkey = `${gx + dx},${gy + dy}`;
      const keys = grid.get(gkey);
      if (!keys) continue;
      for (const k of keys) {
        const n = nodes.get(k);
        const d = haversine(lat, lon, n.lat, n.lon);
        if (d < bestDist) {
          bestDist = d;
          bestNode = n;
        }
      }
    }
  }

  return bestNode;
}

/**
 * Recompute all edge risks with new weights.
 */
export function recomputeEdgeRisks(graph, weights) {
  for (const edge of graph.edges) {
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (fromNode && toNode) {
      edge.risk = sampleSegmentRisk(
        fromNode.lat, fromNode.lon,
        toNode.lat, toNode.lon,
        weights,
        edge.dist
      );
    }
  }
}
