// filepath: src/engine/problem.ts
// Préparation d'un problème de covoiturage pour un événement : qui est présent, qui peut
// conduire, où chacun part, matrice des distances. Partagé par le solveur, la validation
// des plans, l'édition manuelle et les explications.

import type {
  Attendance,
  GeoPoint,
  Locks,
  Participant,
  SportEvent,
  StrategyConfig,
} from '../domain/types.ts';
import { effectiveDrivingProfile, hasCoords } from '../domain/helpers.ts';
import type { EffectiveDrivingProfile } from '../domain/helpers.ts';
import { buildDistanceMatrix, straightLineProvider } from './geo.ts';
import type { DistanceMatrix, DistanceProvider } from './geo.ts';
import { computeHistory, historyEventsFor } from './history.ts';
import type { ParticipantHistory } from './history.ts';
import { RouteCache } from './routing.ts';

export interface PlanContext {
  event: SportEvent;
  /** Tous les participants de l'équipe. */
  participants: Participant[];
  /** Tous les événements (le moteur sélectionne lui-même les événements terminés pertinents). */
  allEvents: SportEvent[];
  strategy: StrategyConfig;
  distance?: DistanceProvider;
  locks?: Locks;
  /** Participants exclus manuellement de l'organisation. */
  excluded?: string[];
  /** Graine pour les départs aléatoires reproductibles. */
  seed?: number;
  /** Horodatage injectable (tests déterministes). */
  now?: string;
}

export interface Problem {
  ctx: PlanContext;
  strategy: StrategyConfig;
  participants: Map<string, Participant>;
  attendance: Map<string, Attendance>;
  nodeOf: Map<string, number>;
  destNode: number;
  matrix: DistanceMatrix;
  routes: RouteCache;
  history: Map<string, ParticipantHistory>;
  /** Présents (disponibilité « oui »), tous transports confondus. */
  presentIds: string[];
  selfIds: string[];
  excludedIds: string[];
  /** À placer dans une voiture. */
  carpoolIds: string[];
  profiles: Map<string, EffectiveDrivingProfile>;
  locks: Locks;
}

export function startPointOf(p: Participant, att: Attendance | undefined): GeoPoint | null {
  const place = att?.startOverride && hasCoords(att.startOverride) ? att.startOverride : p.home;
  return hasCoords(place) ? { lat: place.lat, lng: place.lng } : null;
}

export function prepareProblem(ctx: PlanContext): Problem {
  const participants = new Map<string, Participant>();
  for (const p of ctx.participants) if (p.deletedAt === null) participants.set(p.id, p);

  const attendance = new Map<string, Attendance>();
  for (const a of ctx.event.attendance) attendance.set(a.participantId, a);

  const ids = [...participants.keys()];
  const nodeOf = new Map<string, number>();
  const points: Array<GeoPoint | null> = [];
  ids.forEach((id, i) => {
    nodeOf.set(id, i);
    points.push(startPointOf(participants.get(id) as Participant, attendance.get(id)));
  });
  const destNode = ids.length;
  points.push(hasCoords(ctx.event.destination) ? { lat: ctx.event.destination.lat, lng: ctx.event.destination.lng } : null);

  const provider = ctx.distance ?? straightLineProvider;
  const matrix = buildDistanceMatrix(points, provider);

  const excludedIds = (ctx.excluded ?? []).filter((id) => participants.has(id));
  const presentIds = ids.filter((id) => attendance.get(id)?.availability === 'yes');
  const selfIds = presentIds.filter((id) => attendance.get(id)?.selfTransport === true);
  const carpoolIds = presentIds.filter((id) => !selfIds.includes(id) && !excludedIds.includes(id));

  const profiles = new Map<string, EffectiveDrivingProfile>();
  for (const id of ids) {
    profiles.set(id, effectiveDrivingProfile(participants.get(id) as Participant, attendance.get(id)));
  }

  const history = computeHistory(ctx.participants, historyEventsFor(ctx.event, ctx.allEvents));

  return {
    ctx,
    strategy: ctx.strategy,
    participants,
    attendance,
    nodeOf,
    destNode,
    matrix,
    routes: new RouteCache(matrix, destNode),
    history,
    presentIds,
    selfIds,
    excludedIds,
    carpoolIds,
    profiles,
    locks: ctx.locks ?? { drivers: [], assignments: {} },
  };
}

export function nameOf(problem: Problem, id: string): string {
  const p = problem.participants.get(id);
  return p ? `${p.firstName} ${p.lastName}`.trim() || 'Sans nom' : 'Participant inconnu';
}

/** Capacité totale d'une voiture, conducteur compris. */
export function capacityOf(problem: Problem, driverId: string): number {
  return (problem.profiles.get(driverId)?.seats ?? 0) + 1;
}

/** Participants pouvant conduire, selon la contrainte « capacité ≠ volonté ». */
export interface DriverCandidates {
  /** Volontaires ou acceptables : peuvent être choisis normalement. */
  regular: string[];
  /** Préfèrent être passagers mais acceptent en dernier recours. */
  lastResort: string[];
  /** Ont une voiture disponible mais refusent de conduire (jamais affectés). */
  refusing: string[];
}

export function findDriverCandidates(problem: Problem): DriverCandidates {
  const regular: string[] = [];
  const lastResort: string[] = [];
  const refusing: string[] = [];
  for (const id of problem.carpoolIds) {
    const prof = problem.profiles.get(id) as EffectiveDrivingProfile;
    if (!prof.canDrive) continue;
    if (!prof.willDrive) refusing.push(id);
    else if (prof.lastResortOnly) lastResort.push(id);
    else regular.push(id);
  }
  return { regular, lastResort, refusing };
}
