// filepath: src/engine/routing.ts
// Ordonnancement des points de récupération d'un véhicule.
// Chemin : départ du conducteur → arrêts (passagers) → destination.
// Exact (Held-Karp) jusqu'à EXACT_LIMIT arrêts, sinon plus proche voisin + 2-opt.

import type { DistanceMatrix } from './geo.ts';

export const EXACT_LIMIT = 10;

export interface RouteResult {
  /** Arrêts dans l'ordre optimal (indices de nœuds). */
  order: number[];
  km: number;
}

export function routeKmOfOrder(m: DistanceMatrix, start: number, order: number[], dest: number): number {
  let total = 0;
  let prev = start;
  for (const stop of order) {
    total += m.get(prev, stop);
    prev = stop;
  }
  return total + m.get(prev, dest);
}

function exactOrder(m: DistanceMatrix, start: number, stops: number[], dest: number): RouteResult {
  const n = stops.length;
  const full = (1 << n) - 1;
  const INF = Number.POSITIVE_INFINITY;
  const dp = new Float64Array((full + 1) * n).fill(INF);
  const parent = new Int8Array((full + 1) * n).fill(-1);

  for (let i = 0; i < n; i++) dp[(1 << i) * n + i] = m.get(start, stops[i] as number);

  for (let mask = 1; mask <= full; mask++) {
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const cur = dp[mask * n + last] as number;
      if (cur === INF) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const nm = mask | (1 << next);
        const cand = cur + m.get(stops[last] as number, stops[next] as number);
        if (cand < (dp[nm * n + next] as number) - 1e-12) {
          dp[nm * n + next] = cand;
          parent[nm * n + next] = last;
        }
      }
    }
  }

  let bestLast = 0;
  let best = INF;
  for (let last = 0; last < n; last++) {
    const total = (dp[full * n + last] as number) + m.get(stops[last] as number, dest);
    if (total < best - 1e-12) {
      best = total;
      bestLast = last;
    }
  }

  const order: number[] = [];
  let mask = full;
  let last = bestLast;
  while (last !== -1) {
    order.push(stops[last] as number);
    const p = parent[mask * n + last] as number;
    mask &= ~(1 << last);
    last = p;
  }
  order.reverse();
  return { order, km: best };
}

function heuristicOrder(m: DistanceMatrix, start: number, stops: number[], dest: number): RouteResult {
  // Plus proche voisin
  const remaining = [...stops];
  const order: number[] = [];
  let prev = start;
  while (remaining.length > 0) {
    let bi = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (m.get(prev, remaining[i] as number) < m.get(prev, remaining[bi] as number)) bi = i;
    }
    const [next] = remaining.splice(bi, 1) as [number];
    order.push(next);
    prev = next;
  }
  // 2-opt avec extrémités fixes
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (routeKmOfOrder(m, start, candidate, dest) < routeKmOfOrder(m, start, order, dest) - 1e-9) {
          order.splice(0, order.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return { order, km: routeKmOfOrder(m, start, order, dest) };
}

/** Meilleur ordre de récupération pour un ensemble d'arrêts. */
export function bestRoute(m: DistanceMatrix, start: number, stops: number[], dest: number): RouteResult {
  if (stops.length === 0) return { order: [], km: m.get(start, dest) };
  if (stops.length === 1) {
    const s = stops[0] as number;
    return { order: [s], km: m.get(start, s) + m.get(s, dest) };
  }
  return stops.length <= EXACT_LIMIT ? exactOrder(m, start, stops, dest) : heuristicOrder(m, start, stops, dest);
}

/** Cache des itinéraires optimaux : clé = départ + ensemble d'arrêts (ordre indifférent). */
export class RouteCache {
  private readonly cache = new Map<string, RouteResult>();
  private readonly m: DistanceMatrix;
  private readonly dest: number;

  constructor(m: DistanceMatrix, dest: number) {
    this.m = m;
    this.dest = dest;
  }

  get(start: number, stops: number[]): RouteResult {
    const key = `${start}|${[...stops].sort((a, b) => a - b).join(',')}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = bestRoute(this.m, start, stops, this.dest);
      this.cache.set(key, hit);
    }
    return hit;
  }
}
