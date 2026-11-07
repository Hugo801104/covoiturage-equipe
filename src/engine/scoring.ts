// filepath: src/engine/scoring.ts
// Coût « conducteur » : plus il est BAS, plus la personne est prioritaire pour conduire.
// Chaque composante est conservée séparément afin de pouvoir expliquer le choix à l'utilisateur.

import type { DrivingPreference, Participant, StrategyConfig } from '../domain/types.ts';
import { averageDriveKm } from './history.ts';
import type { ParticipantHistory } from './history.ts';

/** Écart entre deux groupes de préférence en mode « volontaires » : domine toute équité. */
export const TIER_GAP = 1000;
/** Pénalité de « dernier recours » : un passager-préféré ne conduit que si rien d'autre n'est possible. */
export const LAST_RESORT_PENALTY = 400;

/**
 * Points de préférence, en fraction du « trajet typique » (voir scoreDrivers : tripKm).
 * Toutes les composantes du coût sont exprimées en kilomètres-équivalents : un trajet plus long
 * rend les écarts d'équité proportionnellement plus lourds que quelques kilomètres de détour.
 */
const PREFERENCE_FRACTION: Record<DrivingPreference, number> = {
  priority: 0,
  volunteer: 0.2,
  indifferent: 0.5,
  prefer_passenger: 0.5,
  refuse: 0, // jamais candidat
};

export interface DriverScoreParts {
  /** Palier de préférence (mode volontaires) ou points de préférence pondérés. */
  preference: number;
  /** Bonus du statut « conducteur prioritaire » (négatif = favorable). */
  priorityBonus: number;
  /** Équité du nombre de trajets (négatif = a moins conduit que la moyenne du groupe). */
  tripFairness: number;
  /** Équité des distances conduites. */
  distanceFairness: number;
  /** Pénalité de trajets consécutifs. */
  streak: number;
  /** Pénalité « dernier recours ». */
  lastResort: number;
}

export interface DriverScore {
  participantId: string;
  total: number;
  parts: DriverScoreParts;
  /** 0 prioritaire, 1 volontaire, 2 indifférent, 3 dernier recours. */
  tier: 0 | 1 | 2 | 3;
  /** Dette de conduite relative au groupe candidat (en trajets). */
  relativeTrips: number;
  /** Dette de distance relative, en « trajets équivalents ». */
  relativeKm: number;
  streak: number;
  timesDriver: number;
  eventsAttended: number;
}

export interface ScoringCandidate {
  participant: Participant;
  lastResortOnly: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function tierOf(c: ScoringCandidate): 0 | 1 | 2 | 3 {
  if (c.lastResortOnly) return 3;
  const p = c.participant;
  if (p.priorityDriver || p.drivingPreference === 'priority') return 0;
  if (p.drivingPreference === 'volunteer') return 1;
  return 2;
}

/** Hachage déterministe très léger pour départager sans aléatoire. */
export function tieBreaker(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) * 1e-6;
}

/**
 * @param tripKm longueur typique d'un trajet conducteur pour cet événement (km à vol d'oiseau).
 *   Sert d'unité commune : une « dette » d'un trajet vaut une fraction de cette longueur.
 */
export function scoreDrivers(
  candidates: ScoringCandidate[],
  history: Map<string, ParticipantHistory>,
  strategy: StrategyConfig,
  tripKm = 100,
): Map<string, DriverScore> {
  const out = new Map<string, DriverScore>();
  if (candidates.length === 0) return out;

  const w = strategy.weights;
  const mode = strategy.mode;
  const avgKm = Math.max(1, averageDriveKm(history));
  const hist = (id: string): ParticipantHistory | undefined => history.get(id);

  // Moyennes du groupe candidat : l'équité est RELATIVE aux autres conducteurs possibles.
  const meanTrips = candidates.reduce((s, c) => s + (hist(c.participant.id)?.driveBalance ?? 0), 0) / candidates.length;
  const meanKm = candidates.reduce((s, c) => s + (hist(c.participant.id)?.kmBalance ?? 0), 0) / candidates.length;

  const unit = clamp(tripKm, 20, 300);
  const volunteerFactor = w.volunteer / 5;
  const fairnessScale = mode === 'equity' ? 2 : 1;

  for (const c of candidates) {
    const id = c.participant.id;
    const h = hist(id);
    const tier = tierOf(c);

    const relativeTrips = clamp((h?.driveBalance ?? 0) - meanTrips, -4, 4);
    const relativeKm = clamp(((h?.kmBalance ?? 0) - meanKm) / avgKm, -4, 4);
    const streak = h?.currentStreak ?? 0;

    let preference = 0;
    let priorityBonus = 0;
    if (mode === 'volunteer') {
      // Paliers lexicographiques : ceux qui veulent conduire (prioritaires + volontaires) d'abord,
      // puis les indifférents, puis le dernier recours. À l'intérieur du premier palier, l'équité fait
      // tourner les conducteurs : le prioritaire garde un avantage borné (≈ 1,5 trajet d'écart) avant
      // de laisser la place aux simples volontaires.
      const group = tier === 3 ? 2 : tier === 2 ? 1 : 0;
      const tripUnit = Math.max(0.1 * unit, (w.tripEquity / 5) * 0.5 * unit);
      preference = group * TIER_GAP + (tier === 1 ? 1.5 * tripUnit : 0);
    } else if (!c.lastResortOnly) {
      preference = PREFERENCE_FRACTION[c.participant.drivingPreference] * unit * volunteerFactor;
      if (c.participant.priorityDriver) priorityBonus = -0.4 * unit * volunteerFactor;
    }

    // Par défaut (poids 5), un trajet d'écart vaut la moitié d'un trajet typique.
    let tripFairness = (w.tripEquity / 5) * 0.5 * unit * relativeTrips * fairnessScale;
    let distanceFairness = (w.distanceEquity / 5) * 0.5 * unit * relativeKm * fairnessScale;
    let streakPenalty =
      streak >= strategy.maxConsecutive
        ? (w.consecutive / 5) * 0.6 * unit * (streak - strategy.maxConsecutive + 1)
        : 0;

    if (mode === 'volunteer') {
      // L'équité ne sert qu'à départager à l'intérieur d'un palier.
      const f = clamp(tripFairness + distanceFairness, -400, 400);
      const ratio = tripFairness + distanceFairness !== 0 ? f / (tripFairness + distanceFairness) : 1;
      tripFairness *= ratio;
      distanceFairness *= ratio;
      streakPenalty = Math.min(streakPenalty, 400);
    }

    const lastResort = c.lastResortOnly ? Math.max(LAST_RESORT_PENALTY, 5 * unit) : 0;
    const parts: DriverScoreParts = {
      preference,
      priorityBonus,
      tripFairness,
      distanceFairness,
      streak: streakPenalty,
      lastResort,
    };
    const total =
      preference + priorityBonus + tripFairness + distanceFairness + streakPenalty + lastResort + tieBreaker(id);

    out.set(id, {
      participantId: id,
      total,
      parts,
      tier,
      relativeTrips,
      relativeKm,
      streak,
      timesDriver: h?.timesDriver ?? 0,
      eventsAttended: h?.eventsAttended ?? 0,
    });
  }
  // Décalage : le meilleur candidat a un coût nul et personne n'a de coût négatif. Sans cela, ajouter
  // une voiture inutile pour « rembourser une dette d'équité » pourrait paraître rentable.
  let min = Number.POSITIVE_INFINITY;
  for (const sc of out.values()) min = Math.min(min, sc.total);
  if (Number.isFinite(min)) for (const sc of out.values()) sc.total -= min;
  return out;
}

/** Coût d'une voiture supplémentaire (en points), en plus de ses propres kilomètres. */
export function carCost(strategy: StrategyConfig): number {
  return (strategy.weights.fewCars / 5) * 40;
}

/** Coût d'un kilomètre parcouru par l'ensemble des voitures (en points). */
export function kmCost(strategy: StrategyConfig): number {
  return strategy.weights.compactness / 5;
}

/** Pénalité par km de détour au-delà du détour toléré. */
export function detourPenaltyPerKm(strategy: StrategyConfig): number {
  return 4 * Math.max(0.5, strategy.weights.compactness / 5);
}
