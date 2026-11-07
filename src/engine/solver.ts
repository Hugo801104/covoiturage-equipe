// filepath: src/engine/solver.ts
// Moteur d'optimisation du covoiturage.
//
// Problème : choisir un ensemble de conducteurs S et affecter chaque autre participant à l'un
// d'eux, en minimisant un coût global pondéré (tout en « kilomètres-équivalents ») :
//
//   coût(S) = Σ coût_conducteur(d)            préférences + équité dans le temps (scoring.ts)
//           + coût_voiture × |S|              limiter le nombre de véhicules
//           + coût_km × Σ longueur_itinéraire kilomètres totaux (vol d'oiseau)
//           + pénalité × Σ détour excédentaire détours au-delà du seuil toléré
//
// Contraintes dures : capacité, un seul véhicule par personne, conducteur avec voiture
// disponible et ayant déclaré sa disponibilité, refus de conduire respecté.
//
// Méthode (déterministe, sans appel externe) :
//  1. Pour un ensemble S donné, les passagers sont insérés par « regret » (le passager qui perdrait
//     le plus à ne pas obtenir sa meilleure voiture est servi en premier). Un « polissage » optionnel
//     améliore ensuite l'affectation par déplacements/échanges entre voitures voisines ; l'ordre de
//     récupération de chaque voiture est exact (≤ 10 arrêts).
//  2. S est choisi par recherche locale (échange / ajout / retrait de conducteur) lancée depuis
//     plusieurs départs (meilleurs scores, grosses capacités, répartition géographique, aléatoires
//     reproductibles). La recherche utilise l'évaluation rapide ; seuls les meilleurs ensembles sont polis.
//  3. Un budget de travail déterministe (et non un chronomètre) borne le temps de calcul : le résultat
//     est reproductible d'une machine à l'autre.
//  4. Si les places sont insuffisantes, le moteur le DIT : plan incomplet, places manquantes,
//     participants non affectés, pistes de solution. Jamais de plan non conforme présenté comme valide.

import type { Plan, Vehicle } from '../domain/types.ts';
import { newId, nowIso } from '../domain/helpers.ts';
import { projectedImbalance } from './fairness.ts';
import { capacityOf, findDriverCandidates, prepareProblem } from './problem.ts';
import type { PlanContext, Problem } from './problem.ts';
import { finalizePlan } from './plan-utils.ts';
import type { PlanDraft } from './plan-utils.ts';
import { carCost, detourPenaltyPerKm, kmCost, scoreDrivers } from './scoring.ts';
import type { DriverScore, ScoringCandidate } from './scoring.ts';

export interface SolveOptions {
  /** Plafond d'évaluations d'ensembles de conducteurs. */
  maxEvaluations?: number;
  /** Budget de travail (≈ passagers × voitures cumulés sur toutes les évaluations). */
  maxWork?: number;
  /** Nombre de départs aléatoires supplémentaires. */
  randomStarts?: number;
}

export interface Evaluation {
  driverIds: string[];
  /** Conducteur → passagers dans l'ordre de récupération. */
  stops: Map<string, string[]>;
  leftover: string[];
  driverCost: number;
  carCost: number;
  geoCost: number;
  km: number;
  total: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Permutations d'indices pour les petits itinéraires (calcul direct sans cache ni allocation). */
const SMALL_PERMS: number[][][] = [[[]], [[0]]];
for (let k = 2; k <= 4; k++) {
  const out: number[][] = [];
  const rec = (cur: number[], rest: number[]): void => {
    if (rest.length === 0) {
      out.push(cur);
      return;
    }
    rest.forEach((x, i) => rec([...cur, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  rec([], Array.from({ length: k }, (_, i) => i));
  SMALL_PERMS[k] = out;
}

export type EvaluateMode = 'regret' | 'cheapest';

export interface SolverState {
  problem: Problem;
  scores: Map<string, DriverScore>;
  /** Conducteurs possibles hors verrous. */
  free: string[];
  /** Conducteurs imposés (verrous). */
  fixed: string[];
  /** Dernier recours inclus dans free. */
  lastResort: Set<string>;
  /**
   * Évalue un ensemble de conducteurs. `polish: false` = évaluation rapide (insertion seule) pour la
   * recherche ; `polish: true` (défaut) améliore ensuite l'affectation.
   */
  evaluate(driverIds: string[], mode?: EvaluateMode, polish?: boolean): Evaluation | null;
  evaluations: number;
  work: number;
}

export function createSolverState(problem: Problem): SolverState {
  const { regular, lastResort } = findDriverCandidates(problem);
  const carpool = new Set(problem.carpoolIds);
  const fixed = problem.locks.drivers.filter((d) => carpool.has(d));
  const fixedSet = new Set(fixed);
  const lastResortSet = new Set(lastResort);

  const free = [...regular, ...lastResort].filter((id) => !fixedSet.has(id));
  const scoring: ScoringCandidate[] = [...free, ...fixed]
    .map((id) => problem.participants.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((participant) => ({ participant, lastResortOnly: lastResortSet.has(participant.id) }));

  // Longueur typique d'un trajet conducteur = médiane des distances directes candidats → destination.
  const direct = [...free, ...fixed]
    .map((id) => problem.matrix.get(problem.nodeOf.get(id) as number, problem.destNode))
    .sort((a, b) => a - b);
  const tripKm = direct.length > 0 ? (direct[Math.floor(direct.length / 2)] as number) : 100;
  const scores = scoreDrivers(scoring, problem.history, problem.strategy, tripKm);

  const strategy = problem.strategy;
  const perCar = carCost(strategy);
  const perKm = kmCost(strategy);
  const perDetourKm = detourPenaltyPerKm(strategy);
  const maxDetour = strategy.maxDetourKm;
  const dest = problem.destNode;
  const raw = problem.matrix.data;
  const size = problem.matrix.size;
  const D = (i: number, j: number): number => raw[i * size + j] as number;
  const n = problem.carpoolIds.length;

  const idOfNode: string[] = [];
  for (const [id, node] of problem.nodeOf) idOfNode[node] = id;

  /** Longueur minimale d'un itinéraire départ → arrêts → destination. */
  const routeKm = (start: number, stops: number[]): number => {
    const k = stops.length;
    if (k === 0) return D(start, dest);
    if (k === 1) {
      const s = stops[0] as number;
      return D(start, s) + D(s, dest);
    }
    if (k <= 4) {
      let best = Number.POSITIVE_INFINITY;
      for (const perm of SMALL_PERMS[k] as number[][]) {
        let prev = start;
        let t = 0;
        for (const idx of perm) {
          const s = stops[idx] as number;
          t += D(prev, s);
          prev = s;
        }
        t += D(prev, dest);
        if (t < best) best = t;
      }
      return best;
    }
    return problem.routes.get(start, stops).km;
  };

  const vehicleCost = (start: number, stops: number[]): number => {
    const km = routeKm(start, stops);
    const detour = km - D(start, dest);
    return perKm * km + perDetourKm * Math.max(0, detour - maxDetour);
  };

  const state: SolverState = {
    problem,
    scores,
    free,
    fixed,
    lastResort: lastResortSet,
    evaluations: 0,
    work: 0,
    evaluate(driverIds, mode = 'regret', polish = true) {
      const drivers = [...driverIds];
      const k = drivers.length;
      let seats = 0;
      for (const d of drivers) seats += capacityOf(problem, d);
      if (mode === 'regret' && seats < n) return null;
      state.evaluations++;
      state.work += n * Math.max(1, k) * (polish ? 4 : 1);

      const dNode = drivers.map((d) => problem.nodeOf.get(d) as number);
      const driverIdx = new Map<string, number>(drivers.map((d, i) => [d, i]));
      const left = drivers.map((d) => capacityOf(problem, d) - 1);
      const stops: number[][] = drivers.map(() => []);
      const driverNodes = new Set(dNode);

      let pending: number[] = [];
      for (const id of problem.carpoolIds) {
        const node = problem.nodeOf.get(id) as number;
        if (!driverNodes.has(node)) pending.push(node);
      }

      // Affectations imposées d'abord (conservées lors du polissage).
      const lockedTo = new Map<number, number>();
      for (const node of [...pending]) {
        const forced = problem.locks.assignments[idOfNode[node] as string];
        const di = forced !== undefined ? driverIdx.get(forced) : undefined;
        if (di !== undefined && (left[di] as number) > 0) {
          (stops[di] as number[]).push(node);
          left[di] = (left[di] as number) - 1;
          lockedTo.set(node, di);
          pending = pending.filter((x) => x !== node);
        }
      }

      const cur = dNode.map((s, i) => vehicleCost(s, stops[i] as number[]));

      // ── Insertion par regret avec tableau de deltas mis à jour incrémentalement ──
      const P = pending.length;
      const delta = new Float64Array(P * Math.max(1, k)).fill(Number.POSITIVE_INFINITY);
      const b1 = new Float64Array(P);
      const b2 = new Float64Array(P);
      const b1d = new Int32Array(P).fill(-1);
      const active = new Uint8Array(P).fill(1);

      const deltaFor = (pi: number, di: number): number => {
        if ((left[di] as number) <= 0) return Number.POSITIVE_INFINITY;
        const list = stops[di] as number[];
        list.push(pending[pi] as number);
        const c = vehicleCost(dNode[di] as number, list);
        list.pop();
        return c - (cur[di] as number);
      };
      const best = (pi: number): void => {
        let x1 = Number.POSITIVE_INFINITY;
        let x2 = Number.POSITIVE_INFINITY;
        let xd = -1;
        for (let di = 0; di < k; di++) {
          const v = delta[pi * k + di] as number;
          if (v < x1) {
            x2 = x1;
            x1 = v;
            xd = di;
          } else if (v < x2) {
            x2 = v;
          }
        }
        b1[pi] = x1;
        b2[pi] = x2;
        b1d[pi] = xd;
      };

      for (let pi = 0; pi < P; pi++) {
        for (let di = 0; di < k; di++) delta[pi * k + di] = deltaFor(pi, di);
        best(pi);
      }

      for (let round = 0; round < P; round++) {
        let pick = -1;
        let pickKey = mode === 'cheapest' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        let pickTie = 0;
        for (let pi = 0; pi < P; pi++) {
          if (!active[pi] || (b1d[pi] as number) < 0) continue;
          if (mode === 'cheapest') {
            if ((b1[pi] as number) < pickKey - 1e-12) {
              pick = pi;
              pickKey = b1[pi] as number;
            }
          } else {
            const x2 = b2[pi] as number;
            const regret = x2 === Number.POSITIVE_INFINITY ? 1e6 : x2 - (b1[pi] as number);
            if (regret > pickKey + 1e-12 || (Math.abs(regret - pickKey) <= 1e-12 && (b1[pi] as number) > pickTie)) {
              pick = pi;
              pickKey = regret;
              pickTie = b1[pi] as number;
            }
          }
        }
        if (pick < 0) break;
        const di = b1d[pick] as number;
        (stops[di] as number[]).push(pending[pick] as number);
        left[di] = (left[di] as number) - 1;
        cur[di] = (cur[di] as number) + (b1[pick] as number);
        active[pick] = 0;
        for (let pi = 0; pi < P; pi++) {
          if (!active[pi]) continue;
          delta[pi * k + di] = deltaFor(pi, di);
          best(pi);
        }
      }

      // ── Polissage : déplacements puis échanges entre voitures voisines ──
      if (polish && k > 1) {
        const nearK = Math.min(k, 5);
        const nearCache = new Map<number, number[]>();
        const near = (node: number): number[] => {
          let r = nearCache.get(node);
          if (!r) {
            r = Array.from({ length: k }, (_, i) => i)
              .sort((x, y) => D(node, dNode[x] as number) - D(node, dNode[y] as number))
              .slice(0, nearK);
            nearCache.set(node, r);
          }
          return r;
        };
        const isLocked = (node: number, di: number): boolean => lockedTo.get(node) === di;
        const without = (list: number[], node: number): number[] => list.filter((x) => x !== node);

        for (let pass = 0; pass < 6; pass++) {
          let improved = false;
          for (let a = 0; a < k; a++) {
            for (const p of [...(stops[a] as number[])]) {
              if (isLocked(p, a)) continue;
              const rest = without(stops[a] as number[], p);
              const costA = vehicleCost(dNode[a] as number, rest);
              for (const b of near(p)) {
                if (b === a || (left[b] as number) <= 0) continue;
                const list = stops[b] as number[];
                list.push(p);
                const costB = vehicleCost(dNode[b] as number, list);
                if (costA + costB < (cur[a] as number) + (cur[b] as number) - 1e-9) {
                  stops[a] = rest;
                  left[a] = (left[a] as number) + 1;
                  left[b] = (left[b] as number) - 1;
                  cur[a] = costA;
                  cur[b] = costB;
                  improved = true;
                  break;
                }
                list.pop();
              }
            }
          }
          for (let a = 0; a < k; a++) {
            for (const p of [...(stops[a] as number[])]) {
              if (isLocked(p, a) || !(stops[a] as number[]).includes(p)) continue;
              for (const b of near(p)) {
                if (b === a) continue;
                for (const q of [...(stops[b] as number[])]) {
                  if (isLocked(q, b)) continue;
                  const sa = without(stops[a] as number[], p).concat(q);
                  const sb = without(stops[b] as number[], q).concat(p);
                  const ca = vehicleCost(dNode[a] as number, sa);
                  const cb = vehicleCost(dNode[b] as number, sb);
                  if (ca + cb < (cur[a] as number) + (cur[b] as number) - 1e-9) {
                    stops[a] = sa;
                    stops[b] = sb;
                    cur[a] = ca;
                    cur[b] = cb;
                    improved = true;
                    break;
                  }
                }
                if (!(stops[a] as number[]).includes(p)) break;
              }
            }
          }
          if (!improved) break;
        }
      }

      // ── Ordre de récupération exact et totaux ──
      let geo = 0;
      let km = 0;
      const out = new Map<string, string[]>();
      for (let di = 0; di < k; di++) {
        const route = problem.routes.get(dNode[di] as number, stops[di] as number[]);
        out.set(
          drivers[di] as string,
          route.order.map((node) => idOfNode[node] as string),
        );
        km += route.km;
        geo += vehicleCost(dNode[di] as number, stops[di] as number[]);
      }

      let driverCost = 0;
      for (const d of drivers) driverCost += scores.get(d)?.total ?? 0;
      const cars = perCar * k;
      const leftover: string[] = [];
      for (let pi = 0; pi < P; pi++) if (active[pi]) leftover.push(idOfNode[pending[pi] as number] as string);
      return {
        driverIds: drivers,
        stops: out,
        leftover,
        driverCost,
        carCost: cars,
        geoCost: geo,
        km,
        total: driverCost + cars + geo,
      };
    },
  };
  return state;
}

/** Nombre minimal de voitures pour transporter n personnes avec les capacités données. */
function minCars(capacities: number[], n: number, alreadySeats: number, alreadyCars: number): number {
  const sorted = [...capacities].sort((a, b) => b - a);
  let seats = alreadySeats;
  let cars = alreadyCars;
  for (const c of sorted) {
    if (seats >= n) break;
    seats += c;
    cars++;
  }
  return seats >= n ? cars : Number.POSITIVE_INFINITY;
}

export function solve(ctx: PlanContext, options: SolveOptions = {}): Plan {
  const problem = prepareProblem(ctx);
  const state = createSolverState(problem);
  const generatedAt = ctx.now ?? nowIso();
  const n = problem.carpoolIds.length;
  const maxEvaluations = options.maxEvaluations ?? 60000;
  const maxWork = options.maxWork ?? 6_000_000;

  const draftBase = {
    id: newId('plan'),
    strategy: ctx.strategy,
    generatedAt,
    source: 'engine' as const,
    excluded: [...problem.excludedIds],
    locks: problem.locks,
    validated: false,
  };

  const buildVehicles = (ev: Evaluation): Vehicle[] =>
    ev.driverIds
      .map((d) => ({ id: `veh_${d}`, driverId: d, passengerIds: ev.stops.get(d) ?? [] }))
      .sort((a, b) => b.passengerIds.length - a.passengerIds.length || a.driverId.localeCompare(b.driverId));

  if (n === 0) {
    return finalizePlan(problem, { ...draftBase, vehicles: [], unassigned: [], alternatives: [] });
  }

  const candidates = [...state.fixed, ...state.free];
  const totalSeatsAll = candidates.reduce((s, d) => s + capacityOf(problem, d), 0);

  // ── Cas impossible : on remplit au mieux et on le signale. ──
  if (candidates.length === 0 || totalSeatsAll < n) {
    const best = candidates.length > 0 ? state.evaluate(candidates, 'cheapest') : null;
    const vehicles = best ? buildVehicles(best) : [];
    const reason =
      candidates.length === 0
        ? 'Aucun conducteur possible.'
        : 'Plus de place disponible dans les voitures des conducteurs possibles.';
    const left = best ? best.leftover : [...problem.carpoolIds];
    return finalizePlan(problem, {
      ...draftBase,
      vehicles,
      unassigned: left.map((participantId) => ({ participantId, reason })),
      alternatives: [],
    });
  }

  // ── Cas faisable : recherche des meilleurs conducteurs. ──
  const seatsFixed = state.fixed.reduce((s, d) => s + capacityOf(problem, d), 0);
  const kMin = minCars(
    state.free.map((d) => capacityOf(problem, d)),
    n,
    seatsFixed,
    state.fixed.length,
  );
  const maxCars = Math.min(candidates.length, kMin + Math.max(0, ctx.strategy.extraCars));

  const scoreOf = (id: string): number => state.scores.get(id)?.total ?? 0;
  const freeByScore = [...state.free].sort((a, b) => scoreOf(a) - scoreOf(b) || a.localeCompare(b));
  const seen = new Map<string, Evaluation>();
  const keyOf = (ids: string[]): string => [...ids].sort().join('|');
  const outOfBudget = (): boolean => state.evaluations >= maxEvaluations || state.work >= maxWork;

  /** Évaluation rapide (recherche) avec mémoïsation. */
  const evaluate = (ids: string[]): Evaluation | null => {
    const key = keyOf(ids);
    const hit = seen.get(key);
    if (hit) return hit;
    if (outOfBudget()) return null;
    const ev = state.evaluate(ids, 'regret', false);
    if (!ev || ev.leftover.length > 0) return null;
    seen.set(key, ev);
    return ev;
  };

  const fill = (order: string[]): string[] => {
    const set = [...state.fixed];
    let seats = seatsFixed;
    for (const id of order) {
      if (seats >= n) break;
      set.push(id);
      seats += capacityOf(problem, id);
    }
    return set;
  };

  const startSets: string[][] = [];
  startSets.push(fill(freeByScore));
  startSets.push(
    fill([...state.free].sort((a, b) => capacityOf(problem, b) - capacityOf(problem, a) || scoreOf(a) - scoreOf(b))),
  );
  startSets.push(fill([...state.free].sort((a, b) => scoreOf(a) / capacityOf(problem, a) - scoreOf(b) / capacityOf(problem, b))));

  // Répartition géographique : plus éloigné d'abord parmi les candidats, pour couvrir le territoire.
  const spread: string[] = [];
  const remaining = [...freeByScore];
  while (remaining.length > 0) {
    let bi = 0;
    let bd = -1;
    remaining.forEach((id, i) => {
      const node = problem.nodeOf.get(id) as number;
      let minD = problem.matrix.get(node, problem.destNode);
      for (const chosen of [...state.fixed, ...spread]) {
        minD = Math.min(minD, problem.matrix.get(node, problem.nodeOf.get(chosen) as number));
      }
      if (minD > bd + 1e-9) {
        bd = minD;
        bi = i;
      }
    });
    spread.push(remaining.splice(bi, 1)[0] as string);
  }
  startSets.push(fill(spread));

  const rng = mulberry32(ctx.seed ?? hashString(ctx.event.id));
  const randomStarts = options.randomStarts ?? 6;
  for (let r = 0; r < randomStarts; r++) {
    const shuffled = [...state.free];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string];
    }
    startSets.push(fill(shuffled));
  }

  // Heuristique d'ordonnancement des voisins (ne décide pas : sert à évaluer d'abord les plus prometteurs).
  const nodeOf = (id: string): number => problem.nodeOf.get(id) as number;
  const swapProxy = (a: string, b: string): number =>
    scoreOf(b) -
    scoreOf(a) +
    kmCost(ctx.strategy) *
      (problem.matrix.get(nodeOf(b), problem.destNode) -
        problem.matrix.get(nodeOf(a), problem.destNode) +
        0.7 * problem.matrix.get(nodeOf(a), nodeOf(b)));
  const NEIGHBOR_CAP = 48;

  const localSearch = (start: string[]): Evaluation | null => {
    let set = [...start];
    let cur = evaluate(set);
    if (!cur) return null;
    const fixedSet = new Set(state.fixed);
    for (let iter = 0; iter < 60 && !outOfBudget(); iter++) {
      let bestEv: Evaluation = cur;
      const inSet = new Set(set);
      const outs = set.filter((d) => !fixedSet.has(d));
      const ins = state.free.filter((d) => !inSet.has(d));

      const moves: Array<{ proxy: number; next: string[] }> = [];
      for (const a of outs) {
        for (const b of ins) moves.push({ proxy: swapProxy(a, b), next: set.filter((d) => d !== a).concat(b) });
      }
      moves.sort((x, y) => x.proxy - y.proxy);
      for (const mv of moves.slice(0, NEIGHBOR_CAP)) {
        const ev = evaluate(mv.next);
        if (ev && ev.total < bestEv.total - 1e-9) bestEv = ev;
      }
      if (set.length < maxCars) {
        for (const b of ins) {
          const ev = evaluate(set.concat(b));
          if (ev && ev.total < bestEv.total - 1e-9) bestEv = ev;
        }
      }
      for (const a of outs) {
        const ev = evaluate(set.filter((d) => d !== a));
        if (ev && ev.total < bestEv.total - 1e-9) bestEv = ev;
      }
      if (bestEv === cur) break;
      cur = bestEv;
      set = [...bestEv.driverIds];
    }
    return cur;
  };

  for (const start of startSets) {
    if (outOfBudget() && seen.size > 0) break;
    localSearch(start);
  }

  // Les meilleurs ensembles trouvés sont repris avec l'évaluation complète (polissage).
  const shortlist = [...seen.values()].sort((a, b) => a.total - b.total).slice(0, 4);
  const polished: Evaluation[] = [];
  for (const ev of shortlist) {
    const full = state.evaluate(ev.driverIds, 'regret', true);
    if (full && full.leftover.length === 0) polished.push(full);
  }
  polished.sort((a, b) => a.total - b.total);
  let best: Evaluation | null = polished[0] ?? null;

  if (!best) {
    // Garde-fou : budget épuisé avant toute solution → solution gloutonne.
    const greedy = state.evaluate(startSets[0] as string[]);
    best = greedy && greedy.leftover.length === 0 ? greedy : null;
  }
  if (!best) {
    const fallback = state.evaluate(candidates, 'cheapest');
    const vehicles = fallback ? buildVehicles(fallback) : [];
    return finalizePlan(problem, {
      ...draftBase,
      vehicles,
      unassigned: (fallback?.leftover ?? problem.carpoolIds).map((participantId) => ({
        participantId,
        reason: 'Aucune organisation complète trouvée.',
      })),
      alternatives: [],
    });
  }

  const eligible = findDriverCandidates(problem).regular;
  const alternatives = polished.slice(0, 3).map((ev) => ({
    driverIds: ev.driverIds,
    carsUsed: ev.driverIds.length,
    totalKm: ev.km,
    score: ev.total,
    projectedImbalance: projectedImbalance(problem.history, eligible, ev.driverIds),
  }));

  const draft: PlanDraft = {
    ...draftBase,
    vehicles: buildVehicles(best),
    unassigned: [],
    alternatives,
  };
  return finalizePlan(problem, draft);
}
