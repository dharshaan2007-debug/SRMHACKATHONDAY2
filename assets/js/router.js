/**
 * router.js – Binary-heap Dijkstra, route stats, comparison.
 */

import { classifyRisk } from './utils.js';

/**
 * Binary min-heap for Dijkstra.
 */
class MinHeap {
  constructor() {
    this.data = [];
  }

  push(item) {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }

  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  get size() { return this.data.length; }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].cost < this.data[parent].cost) {
        [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
        i = parent;
      } else break;
    }
  }

  _sinkDown(i) {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left].cost < this.data[smallest].cost) smallest = left;
      if (right < n && this.data[right].cost < this.data[smallest].cost) smallest = right;
      if (smallest !== i) {
        [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
        i = smallest;
      } else break;
    }
  }
}

/**
 * Run Dijkstra from a start node.
 * @param {Map} nodes - graph nodes
 * @param {string} startKey - start node key
 * @param {number} lambda - risk aversion factor
 * @param {boolean} avoidVeryHigh - block very-high-risk edges
 * @param {string} destType - 'hospital', 'shelter', or 'either'
 * @returns {{ route, dest, stats } | null}
 */
export function dijkstra(nodes, startKey, lambda = 3, avoidVeryHigh = false, destType = 'either') {
  const dist = new Map();
  const prev = new Map();
  const prevEdge = new Map();
  const visited = new Set();
  const heap = new MinHeap();

  dist.set(startKey, 0);
  heap.push({ key: startKey, cost: 0 });

  let bestDest = null;
  let bestCost = Infinity;

  while (heap.size > 0) {
    const { key, cost } = heap.pop();
    if (visited.has(key)) continue;
    visited.add(key);

    const node = nodes.get(key);
    if (!node) continue;

    // Check if this is a destination
    if (node.facilityType && key !== startKey) {
      const match = destType === 'either' ||
        destType === node.facilityType;
      if (match && cost < bestCost) {
        bestDest = key;
        bestCost = cost;
        // Don't break – continue to find possibly closer ones
      }
    }

    // Early termination: if we've gone 3x beyond best destination, stop
    if (bestDest && cost > bestCost * 3) break;

    for (const edge of node.edges) {
      if (visited.has(edge.to)) continue;

      // Block very-high-risk edges if enabled
      if (avoidVeryHigh && classifyRisk(edge.risk) === 'very_high') {
        continue;
      }

      const edgeCost = edge.dist * (1 + lambda * edge.risk);
      const newDist = cost + edgeCost;

      if (!dist.has(edge.to) || newDist < dist.get(edge.to)) {
        dist.set(edge.to, newDist);
        prev.set(edge.to, key);
        prevEdge.set(edge.to, edge);
        heap.push({ key: edge.to, cost: newDist });
      }
    }
  }

  if (!bestDest) {
    // If avoiding very high failed, retry without
    if (avoidVeryHigh) {
      return dijkstra(nodes, startKey, lambda, false, destType);
    }
    return null;
  }

  // Reconstruct path
  const path = [];
  const pathEdges = [];
  let current = bestDest;
  while (current) {
    path.unshift(current);
    const e = prevEdge.get(current);
    if (e) pathEdges.unshift(e);
    current = prev.get(current);
  }

  // Compute stats
  const stats = computeRouteStats(pathEdges, nodes);
  stats.totalCost = bestCost;

  const destNode = nodes.get(bestDest);

  return {
    path,
    edges: pathEdges,
    dest: destNode,
    stats,
  };
}

/**
 * Run shortest-path Dijkstra (lambda = 0).
 */
export function shortestPath(nodes, startKey, destType = 'either') {
  return dijkstra(nodes, startKey, 0, false, destType);
}

/**
 * Compute route statistics.
 */
function computeRouteStats(edges, nodes) {
  let totalDist = 0;
  let totalRisk = 0;
  let maxRisk = 0;
  let veryHighCount = 0;
  let highCount = 0;

  for (const edge of edges) {
    totalDist += edge.dist;
    totalRisk += edge.risk * edge.dist;
    maxRisk = Math.max(maxRisk, edge.risk);
    const cls = classifyRisk(edge.risk);
    if (cls === 'very_high') veryHighCount++;
    if (cls === 'high') highCount++;
  }

  const meanRisk = totalDist > 0 ? totalRisk / totalDist : 0;

  return {
    distance: totalDist,
    meanRisk,
    maxRisk,
    veryHighSegments: veryHighCount,
    highSegments: highCount,
    segmentCount: edges.length,
  };
}

/**
 * Get route coordinates for map display.
 */
export function routeToCoords(path, nodes) {
  return path.map(key => {
    const n = nodes.get(key);
    return [n.lon, n.lat];
  });
}

/**
 * Compare two routes and generate recommendation text.
 */
export function compareRoutes(safest, shortest) {
  if (!safest || !shortest) return '';

  const extraDist = safest.stats.distance - shortest.stats.distance;
  const extraPct = shortest.stats.distance > 0
    ? (extraDist / shortest.stats.distance * 100)
    : 0;

  const riskReduction = shortest.stats.meanRisk - safest.stats.meanRisk;
  const riskReductionPct = shortest.stats.meanRisk > 0
    ? (riskReduction / shortest.stats.meanRisk * 100)
    : 0;

  if (extraDist < 50) {
    return `Both routes are nearly identical. Take the least-risk route to ${safest.dest.facilityName}.`;
  }

  if (riskReduction < 0.02) {
    return `Risk is similar on both routes. The shortest path to ${safest.dest.facilityName} is recommended.`;
  }

  const parts = [];
  parts.push(`The least-risk route is ${(extraDist / 1000).toFixed(1)} km longer (+${extraPct.toFixed(1)}%)`);
  parts.push(`but reduces mean risk by ${(riskReduction * 100).toFixed(1)} percentage points`);

  if (shortest.stats.veryHighSegments > 0 && safest.stats.veryHighSegments === 0) {
    parts.push(`and avoids ${shortest.stats.veryHighSegments} very-high-risk road segments`);
  }

  parts.push(`to reach ${safest.dest.facilityName}.`);

  if (riskReductionPct > 20 || shortest.stats.veryHighSegments > safest.stats.veryHighSegments) {
    return parts.join(' ') + ' Recommended: take the least-risk route.';
  }

  return parts.join(' ') + ' The detour is modest; the least-risk route is preferable.';
}
