// filepath: src/engine/fairness.ts
// Indicateurs d'équité : lisibles par un non-spécialiste et utilisés pour comparer des organisations.

import type { ParticipantHistory } from './history.ts';

export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/** Indice de Gini : 0 = parfaitement égal, 1 = un seul porte tout. */
export function gini(values: number[]): number {
  const v = values.filter((x) => x >= 0).sort((a, b) => a - b);
  const n = v.length;
  const sum = v.reduce((s, x) => s + x, 0);
  if (n === 0 || sum === 0) return 0;
  let acc = 0;
  v.forEach((x, i) => {
    acc += (2 * (i + 1) - n - 1) * x;
  });
  return acc / (n * sum);
}

/**
 * Écart-type projeté de la dette de conduite après l'événement si `driverIds` conduisent
 * (parmi `eligibleIds`). Plus il est bas, plus le groupe reste équilibré.
 */
export function projectedImbalance(
  history: Map<string, ParticipantHistory>,
  eligibleIds: string[],
  driverIds: string[],
): number {
  if (eligibleIds.length === 0) return 0;
  const drivers = new Set(driverIds);
  const share = driverIds.length / eligibleIds.length;
  const balances = eligibleIds.map((id) => (history.get(id)?.driveBalance ?? 0) + (drivers.has(id) ? 1 : 0) - share);
  return stdDev(balances);
}

export interface FairnessReport {
  /** Participants ayant eu au moins une occasion de conduire. */
  pool: number;
  totalDrives: number;
  meanDrives: number;
  /** Écart-type de la dette de conduite (en trajets). */
  imbalance: number;
  /** Écart entre le plus et le moins chargé (en trajets). */
  spread: number;
  giniDrives: number;
  /** 0..100, 100 = parfaitement équitable. */
  score: number;
}

export function fairnessReport(history: Map<string, ParticipantHistory>, poolIds: string[]): FairnessReport {
  const hs = poolIds
    .map((id) => history.get(id))
    .filter((h): h is ParticipantHistory => !!h && (h.expectedDrives > 0 || h.timesDriver > 0));
  const balances = hs.map((h) => h.driveBalance);
  const drives = hs.map((h) => h.timesDriver);
  const totalDrives = drives.reduce((s, v) => s + v, 0);
  const imbalance = stdDev(balances);
  const spread = balances.length > 0 ? Math.max(...balances) - Math.min(...balances) : 0;
  return {
    pool: hs.length,
    totalDrives,
    meanDrives: hs.length > 0 ? totalDrives / hs.length : 0,
    imbalance,
    spread,
    giniDrives: gini(drives),
    score: Math.max(0, Math.round(100 - imbalance * 40)),
  };
}
