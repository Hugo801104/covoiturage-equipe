// filepath: src/engine/plan-utils.ts
// Métriques, validation des contraintes et finalisation d'un plan.
// Appelé après le solveur ET après chaque modification manuelle : les contraintes sont
// toujours revérifiées, un plan non conforme n'est jamais présenté comme valide.

import type {
  AlternativeSummary,
  Locks,
  Plan,
  PlanIssue,
  PlanMetrics,
  PlanStatus,
  StrategyConfig,
  UnassignedEntry,
  Vehicle,
  VehicleMetrics,
} from '../domain/types.ts';
import { routeKmOfOrder } from './routing.ts';
import { capacityOf, findDriverCandidates, nameOf } from './problem.ts';
import type { Problem } from './problem.ts';
import { roundKm } from './geo.ts';

/** Partie du plan fournie par le solveur ou par l'édition manuelle ; le reste est dérivé. */
export interface PlanDraft {
  id: string;
  strategy: StrategyConfig;
  generatedAt: string;
  source: 'engine' | 'manual';
  vehicles: Vehicle[];
  unassigned: UnassignedEntry[];
  excluded: string[];
  locks: Locks;
  alternatives: AlternativeSummary[];
  validated: boolean;
}

const HARD_CODES = new Set([
  'OVER_CAPACITY',
  'DRIVER_NOT_AVAILABLE',
  'DRIVER_NO_CAR',
  'DRIVER_REFUSES',
  'DUPLICATE_ASSIGNMENT',
  'UNKNOWN_PARTICIPANT',
  'PASSENGER_NOT_AVAILABLE',
]);

export function computeMetrics(problem: Problem, vehicles: Vehicle[]): PlanMetrics {
  const m = problem.matrix;
  const vms: VehicleMetrics[] = [];
  const passengerKm: Record<string, number> = {};
  let totalKm = 0;

  for (const v of vehicles) {
    const start = problem.nodeOf.get(v.driverId);
    if (start === undefined) continue;
    const known = v.passengerIds
      .map((id) => ({ id, node: problem.nodeOf.get(id) }))
      .filter((s): s is { id: string; node: number } => s.node !== undefined);
    const stops = known.map((s) => s.node);
    const routeKm = routeKmOfOrder(m, start, stops, problem.destNode);
    const directKm = m.get(start, problem.destNode);
    vms.push({
      vehicleId: v.id,
      routeKm,
      directKm,
      detourKm: Math.max(0, routeKm - directKm),
      seatsUsed: v.passengerIds.length + 1,
      seatsTotal: capacityOf(problem, v.driverId),
    });
    totalKm += routeKm;

    // Distance parcourue par chaque passager : de sa récupération jusqu'à la destination.
    let remaining = routeKm - (stops.length > 0 ? m.get(start, stops[0] as number) : 0);
    stops.forEach((node, i) => {
      const id = (known[i] as { id: string }).id;
      passengerKm[id] = remaining;
      const next = stops[i + 1];
      remaining -= next !== undefined ? m.get(node, next) : m.get(node, problem.destNode);
    });
  }

  let soloKm = 0;
  for (const id of problem.carpoolIds) {
    const n = problem.nodeOf.get(id);
    if (n !== undefined) soloKm += m.get(n, problem.destNode);
  }

  return {
    carsUsed: vehicles.length,
    totalKm,
    totalDetourKm: vms.reduce((s, v) => s + v.detourKm, 0),
    soloKm,
    vehicles: vms,
    passengerKm,
    distanceKind: m.kind,
  };
}

export function validatePlan(problem: Problem, vehicles: Vehicle[], unassignedIds: string[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const push = (
    severity: PlanIssue['severity'],
    code: PlanIssue['code'],
    message: string,
    participantIds: string[] = [],
    vehicleId: string | null = null,
  ): void => {
    issues.push({ severity, code, message, participantIds, vehicleId });
  };

  const seen = new Map<string, number>();
  for (const v of vehicles) {
    for (const id of [v.driverId, ...v.passengerIds]) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      push('error', 'DUPLICATE_ASSIGNMENT', `${nameOf(problem, id)} est affecté(e) à plusieurs véhicules.`, [id]);
    }
  }

  for (const v of vehicles) {
    const driverName = nameOf(problem, v.driverId);
    const driver = problem.participants.get(v.driverId);
    if (!driver) {
      push('error', 'UNKNOWN_PARTICIPANT', 'Un conducteur n’existe plus dans l’équipe.', [v.driverId], v.id);
      continue;
    }
    const prof = problem.profiles.get(v.driverId);
    const att = problem.attendance.get(v.driverId);

    if (att?.availability !== 'yes') {
      push('error', 'DRIVER_NOT_AVAILABLE', `${driverName} n’a pas déclaré sa disponibilité pour cet événement.`, [v.driverId], v.id);
    }
    if (!prof?.canDrive) {
      push('error', 'DRIVER_NO_CAR', `${driverName} n’a pas de voiture disponible pour cet événement.`, [v.driverId], v.id);
    }
    if (driver.neverDrive || driver.drivingPreference === 'refuse') {
      push('error', 'DRIVER_REFUSES', `${driverName} a indiqué ne pas vouloir conduire.`, [v.driverId], v.id);
    } else if (prof?.lastResortOnly) {
      push('info', 'LAST_RESORT_DRIVER', `${driverName} préfère être passager : conduit en dernier recours.`, [v.driverId], v.id);
    }

    const capacity = capacityOf(problem, v.driverId);
    const occupants = v.passengerIds.length + 1;
    if (occupants > capacity) {
      push(
        'error',
        'OVER_CAPACITY',
        `Voiture de ${driverName} : ${occupants} personnes pour ${capacity} places (conducteur compris).`,
        [v.driverId, ...v.passengerIds],
        v.id,
      );
    }

    for (const pid of v.passengerIds) {
      if (!problem.participants.has(pid)) {
        push('error', 'UNKNOWN_PARTICIPANT', 'Un passager n’existe plus dans l’équipe.', [pid], v.id);
      } else if (problem.attendance.get(pid)?.availability !== 'yes') {
        push('error', 'PASSENGER_NOT_AVAILABLE', `${nameOf(problem, pid)} n’a pas déclaré sa disponibilité.`, [pid], v.id);
      }
    }
  }

  // Détours démesurés (contrainte de cohérence géographique, souple).
  const metrics = computeMetrics(problem, vehicles);
  for (const vm of metrics.vehicles) {
    if (vm.detourKm > problem.strategy.maxDetourKm + 1e-9) {
      const v = vehicles.find((x) => x.id === vm.vehicleId);
      if (v) {
        push(
          'warning',
          'LONG_DETOUR',
          `Voiture de ${nameOf(problem, v.driverId)} : détour estimé de ${roundKm(vm.detourKm)} km (seuil ${problem.strategy.maxDetourKm} km).`,
          [v.driverId],
          v.id,
        );
      }
    }
  }

  // Participants non affectés
  for (const id of unassignedIds) {
    push('error', 'UNASSIGNED', `${nameOf(problem, id)} n’a pas de solution de transport.`, [id]);
  }

  // Coordonnées manquantes : le regroupement géographique est alors dégradé.
  const missing = problem.carpoolIds.filter((id) => {
    const n = problem.nodeOf.get(id);
    return n !== undefined && problem.matrix.unlocated.includes(n);
  });
  if (missing.length > 0) {
    push(
      'warning',
      'MISSING_COORDS',
      `Coordonnées manquantes pour ${missing.map((id) => nameOf(problem, id)).join(', ')} : leur regroupement géographique n’est pas optimisé.`,
      missing,
    );
  }
  if (problem.matrix.unlocated.includes(problem.destNode)) {
    push('warning', 'MISSING_COORDS', 'La destination n’a pas de coordonnées : les distances ne peuvent pas être calculées.');
  }

  return issues;
}

/** Détecte l'insuffisance de places et propose des solutions concrètes. */
function seatShortage(problem: Problem, unassignedCount: number): { issues: PlanIssue[]; suggestions: string[] } {
  const issues: PlanIssue[] = [];
  const suggestions: string[] = [];
  if (unassignedCount === 0) return { issues, suggestions };

  const { regular, lastResort, refusing } = findDriverCandidates(problem);
  const usable = [...regular, ...lastResort, ...problem.locks.drivers.filter((d) => problem.carpoolIds.includes(d))];
  const usableSet = new Set(usable);
  const potentialSeats = [...usableSet].reduce((s, id) => s + capacityOf(problem, id), 0);
  const needed = problem.carpoolIds.length;

  if (usableSet.size === 0) {
    issues.push({
      severity: 'error',
      code: 'NO_DRIVER_AVAILABLE',
      message: `Aucun conducteur possible : personne n’a de voiture disponible et accepte de conduire (${needed} personne(s) sans transport).`,
      participantIds: [],
      vehicleId: null,
    });
  } else if (needed > potentialSeats) {
    const missing = needed - potentialSeats;
    issues.push({
      severity: 'error',
      code: 'INSUFFICIENT_SEATS',
      message: `Places insuffisantes : ${needed} personnes à transporter pour ${potentialSeats} places (conducteurs compris), soit ${missing} place(s) manquante(s).`,
      participantIds: [],
      vehicleId: null,
    });
  }

  if (needed > potentialSeats) {
    const missing = needed - potentialSeats;
    suggestions.push(`Trouver un véhicule supplémentaire d’au moins ${missing} place(s) passagers + conducteur.`);
  }

  const lines = refusing.map((id) => {
    const seats = problem.profiles.get(id)?.seats ?? 0;
    return `${nameOf(problem, id)} (${seats + 1} places, ne souhaite pas conduire)`;
  });
  if (lines.length > 0) {
    suggestions.push(`Demander exceptionnellement à : ${lines.join(' ; ')}.`);
  }

  const absent: string[] = [];
  for (const [id, p] of problem.participants) {
    const att = problem.attendance.get(id);
    if (p.hasCar && att && att.availability !== 'yes') absent.push(`${nameOf(problem, id)} (${p.seats + 1} places)`);
  }
  if (absent.length > 0) {
    suggestions.push(`Revoir les disponibilités de propriétaires de voiture indisponibles ou sans réponse : ${absent.join(', ')}.`);
  }
  const unavailableCar = problem.carpoolIds.filter((id) => {
    const p = problem.participants.get(id);
    return p?.hasCar && !problem.profiles.get(id)?.canDrive;
  });
  if (unavailableCar.length > 0) {
    suggestions.push(
      `Voiture non mise à disposition : ${unavailableCar.map((id) => nameOf(problem, id)).join(', ')} — à rediscuter.`,
    );
  }
  suggestions.push('Passer certains participants en transport autonome, ou revoir les affectations manuellement.');
  return { issues, suggestions };
}

export function finalizePlan(problem: Problem, draft: PlanDraft): Plan {
  const placed = new Set<string>();
  for (const v of draft.vehicles) {
    placed.add(v.driverId);
    v.passengerIds.forEach((id) => placed.add(id));
  }
  const excluded = new Set(draft.excluded);

  const unassignedIds = problem.carpoolIds.filter((id) => !placed.has(id) && !excluded.has(id));
  const reasonOf = new Map(draft.unassigned.map((u) => [u.participantId, u.reason]));
  const unassigned: UnassignedEntry[] = unassignedIds.map((id) => ({
    participantId: id,
    reason: reasonOf.get(id) ?? 'Non affecté à un véhicule.',
  }));

  const issues = validatePlan(problem, draft.vehicles, unassignedIds);
  const shortage = seatShortage(problem, unassignedIds.length);
  issues.unshift(...shortage.issues);

  const { regular } = findDriverCandidates(problem);
  const eligibleDriverIds = regular;

  const hasHard = issues.some((i) => i.severity === 'error' && HARD_CODES.has(i.code));
  const hasErrors = issues.some((i) => i.severity === 'error');
  const status: PlanStatus = hasHard ? 'invalid' : hasErrors ? 'incomplete' : 'ok';

  return {
    id: draft.id,
    strategy: draft.strategy,
    generatedAt: draft.generatedAt,
    source: draft.source,
    vehicles: draft.vehicles,
    unassigned,
    excluded: draft.excluded.filter((id) => problem.participants.has(id)),
    selfTransportIds: [...problem.selfIds],
    eligibleDriverIds,
    attendeeIds: [...problem.presentIds],
    locks: draft.locks,
    issues,
    suggestions: shortage.suggestions,
    status,
    metrics: computeMetrics(problem, draft.vehicles),
    alternatives: draft.alternatives,
    validated: draft.validated,
  };
}
