// filepath: src/engine/plan-edit.ts
// Modification manuelle d'un plan. Fonctions pures : elles renvoient un NOUVEAU plan dont les
// contraintes (capacité, disponibilité, refus de conduire…) sont revérifiées à chaque appel.
// Toute modification manuelle verrouille le choix pour qu'un recalcul « en conservant mes
// modifications » ne le défasse pas.

import type { Locks, Plan, PlanIssue, Vehicle } from '../domain/types.ts';
import { prepareProblem } from './problem.ts';
import type { PlanContext } from './problem.ts';
import { finalizePlan } from './plan-utils.ts';
import { solve } from './solver.ts';
import type { SolveOptions } from './solver.ts';

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

const cloneVehicles = (vs: Vehicle[]): Vehicle[] => vs.map((v) => ({ ...v, passengerIds: [...v.passengerIds] }));
const cloneLocks = (l: Locks): Locks => ({ drivers: [...l.drivers], assignments: { ...l.assignments } });

function rebuild(
  ctx: PlanContext,
  plan: Plan,
  vehicles: Vehicle[],
  excluded: string[],
  locks: Locks,
  validated = false,
): Plan {
  const problem = prepareProblem({ ...ctx, strategy: plan.strategy, locks, excluded });
  return finalizePlan(problem, {
    id: plan.id,
    strategy: plan.strategy,
    generatedAt: plan.generatedAt,
    source: 'manual',
    vehicles,
    unassigned: [],
    excluded,
    locks,
    alternatives: plan.alternatives,
    validated,
  });
}

function removeFromAllVehicles(vehicles: Vehicle[], participantId: string): void {
  for (const v of vehicles) v.passengerIds = v.passengerIds.filter((id) => id !== participantId);
}

/** Déplace un passager vers un autre véhicule (ou le retire de tout véhicule si `toVehicleId` est null). */
export function movePassenger(
  ctx: PlanContext,
  plan: Plan,
  participantId: string,
  toVehicleId: string | null,
  index?: number,
): Plan {
  const vehicles = cloneVehicles(plan.vehicles);
  const locks = cloneLocks(plan.locks);
  if (vehicles.some((v) => v.driverId === participantId)) {
    throw new EditError('Cette personne conduit : changez d’abord le conducteur ou supprimez le véhicule.');
  }
  removeFromAllVehicles(vehicles, participantId);
  delete locks.assignments[participantId];
  const excluded = plan.excluded.filter((id) => id !== participantId);

  if (toVehicleId !== null) {
    const target = vehicles.find((v) => v.id === toVehicleId);
    if (!target) throw new EditError('Véhicule introuvable.');
    const at = index === undefined ? target.passengerIds.length : Math.max(0, Math.min(index, target.passengerIds.length));
    target.passengerIds.splice(at, 0, participantId);
    locks.assignments[participantId] = target.driverId;
  }
  return rebuild(ctx, plan, vehicles, excluded, locks);
}

/** Remplace le conducteur d'un véhicule ; l'ancien conducteur devient passager de ce véhicule. */
export function setDriver(ctx: PlanContext, plan: Plan, vehicleId: string, newDriverId: string): Plan {
  const vehicles = cloneVehicles(plan.vehicles);
  const locks = cloneLocks(plan.locks);
  const vehicle = vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) throw new EditError('Véhicule introuvable.');
  if (vehicle.driverId === newDriverId) return plan;
  if (vehicles.some((v) => v.driverId === newDriverId)) {
    throw new EditError('Cette personne conduit déjà un autre véhicule.');
  }

  const oldDriver = vehicle.driverId;
  removeFromAllVehicles(vehicles, newDriverId);
  vehicle.passengerIds.unshift(oldDriver);
  vehicle.driverId = newDriverId;
  vehicle.id = `veh_${newDriverId}`;

  locks.drivers = locks.drivers.filter((d) => d !== oldDriver && d !== newDriverId).concat(newDriverId);
  delete locks.assignments[newDriverId];
  for (const pid of Object.keys(locks.assignments)) {
    if (locks.assignments[pid] === oldDriver) locks.assignments[pid] = newDriverId;
  }
  locks.assignments[oldDriver] = newDriverId;
  const excluded = plan.excluded.filter((id) => id !== newDriverId);
  return rebuild(ctx, plan, vehicles, excluded, locks);
}

/** Ajoute un véhicule conduit par `driverId`. */
export function addVehicle(ctx: PlanContext, plan: Plan, driverId: string): Plan {
  const vehicles = cloneVehicles(plan.vehicles);
  const locks = cloneLocks(plan.locks);
  if (vehicles.some((v) => v.driverId === driverId)) throw new EditError('Cette personne conduit déjà un véhicule.');
  removeFromAllVehicles(vehicles, driverId);
  delete locks.assignments[driverId];
  vehicles.push({ id: `veh_${driverId}`, driverId, passengerIds: [] });
  if (!locks.drivers.includes(driverId)) locks.drivers.push(driverId);
  const excluded = plan.excluded.filter((id) => id !== driverId);
  return rebuild(ctx, plan, vehicles, excluded, locks);
}

/** Supprime un véhicule : son conducteur et ses passagers redeviennent non affectés. */
export function removeVehicle(ctx: PlanContext, plan: Plan, vehicleId: string): Plan {
  const vehicle = plan.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) throw new EditError('Véhicule introuvable.');
  const vehicles = cloneVehicles(plan.vehicles).filter((v) => v.id !== vehicleId);
  const locks = cloneLocks(plan.locks);
  locks.drivers = locks.drivers.filter((d) => d !== vehicle.driverId);
  for (const pid of Object.keys(locks.assignments)) {
    if (locks.assignments[pid] === vehicle.driverId) delete locks.assignments[pid];
  }
  return rebuild(ctx, plan, vehicles, plan.excluded, locks);
}

/** Change l'ordre de récupération (la liste doit contenir exactement les mêmes passagers). */
export function reorderStops(ctx: PlanContext, plan: Plan, vehicleId: string, newOrder: string[]): Plan {
  const vehicles = cloneVehicles(plan.vehicles);
  const vehicle = vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) throw new EditError('Véhicule introuvable.');
  const same =
    newOrder.length === vehicle.passengerIds.length && newOrder.every((id) => vehicle.passengerIds.includes(id));
  if (!same) throw new EditError('L’ordre doit contenir exactement les passagers du véhicule.');
  vehicle.passengerIds = [...newOrder];
  return rebuild(ctx, plan, vehicles, plan.excluded, plan.locks, plan.validated);
}

/** Exclut un participant de l'organisation (retiré du véhicule ; s'il conduit, le véhicule est supprimé). */
export function excludeParticipant(ctx: PlanContext, plan: Plan, participantId: string): Plan {
  let vehicles = cloneVehicles(plan.vehicles);
  const locks = cloneLocks(plan.locks);
  const driven = vehicles.find((v) => v.driverId === participantId);
  if (driven) {
    vehicles = vehicles.filter((v) => v.id !== driven.id);
    locks.drivers = locks.drivers.filter((d) => d !== participantId);
    for (const pid of Object.keys(locks.assignments)) {
      if (locks.assignments[pid] === participantId) delete locks.assignments[pid];
    }
  }
  removeFromAllVehicles(vehicles, participantId);
  delete locks.assignments[participantId];
  const excluded = plan.excluded.includes(participantId) ? plan.excluded : [...plan.excluded, participantId];
  return rebuild(ctx, plan, vehicles, excluded, locks);
}

export function includeParticipant(ctx: PlanContext, plan: Plan, participantId: string): Plan {
  return rebuild(
    ctx,
    plan,
    cloneVehicles(plan.vehicles),
    plan.excluded.filter((id) => id !== participantId),
    cloneLocks(plan.locks),
  );
}

/** Valide l'organisation actuelle : tout est verrouillé pour les recalculs ultérieurs. */
export function lockAll(ctx: PlanContext, plan: Plan): Plan {
  const locks: Locks = { drivers: plan.vehicles.map((v) => v.driverId), assignments: {} };
  for (const v of plan.vehicles) for (const pid of v.passengerIds) locks.assignments[pid] = v.driverId;
  return rebuild(ctx, plan, cloneVehicles(plan.vehicles), plan.excluded, locks, true);
}

export function unlockAll(ctx: PlanContext, plan: Plan): Plan {
  return rebuild(ctx, plan, cloneVehicles(plan.vehicles), plan.excluded, { drivers: [], assignments: {} }, false);
}

/**
 * Relance l'optimisation. `keepLocked` conserve les modifications validées (conducteurs et
 * affectations verrouillés, exclusions) ; sinon tout est recalculé depuis zéro.
 */
export function recompute(ctx: PlanContext, plan: Plan | null, keepLocked: boolean, options?: SolveOptions): Plan {
  const locks: Locks = keepLocked && plan ? cloneLocks(plan.locks) : { drivers: [], assignments: {} };
  const excluded = keepLocked && plan ? [...plan.excluded] : [];
  const fresh = solve({ ...ctx, locks, excluded }, options);

  const notes: PlanIssue[] = [];
  const driving = new Set(fresh.vehicles.map((v) => v.driverId));
  for (const d of locks.drivers) {
    if (!driving.has(d)) {
      notes.push({
        severity: 'info',
        code: 'LOCK_NOT_APPLIED',
        message: 'Un conducteur imposé n’a pas pu être conservé (indisponible ou absent).',
        participantIds: [d],
        vehicleId: null,
      });
    }
  }
  for (const [pid, did] of Object.entries(locks.assignments)) {
    const v = fresh.vehicles.find((x) => x.driverId === did);
    if (v && !v.passengerIds.includes(pid) && v.driverId !== pid) {
      notes.push({
        severity: 'info',
        code: 'LOCK_NOT_APPLIED',
        message: 'Une affectation imposée n’a pas pu être conservée (voiture pleine ou participant absent).',
        participantIds: [pid],
        vehicleId: v.id,
      });
    }
  }
  return notes.length > 0 ? { ...fresh, issues: [...fresh.issues, ...notes] } : fresh;
}
