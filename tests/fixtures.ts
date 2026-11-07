// filepath: tests/fixtures.ts
// Aides de construction pour les tests : petits scénarios lisibles, sans dépendre de l'interface.

import type {
  Availability,
  DrivingPreference,
  Participant,
  Plan,
  SportEvent,
  StrategyConfig,
  StrategyMode,
} from '../src/domain/types.ts';
import { createAttendance, createEvent, createParticipant, defaultStrategy } from '../src/domain/helpers.ts';
import { GAZETTEER } from '../src/domain/gazetteer.ts';
import type { PlanContext } from '../src/engine/problem.ts';
import { solve } from '../src/engine/solver.ts';

export function coords(city: string): { lat: number; lng: number } {
  const e = GAZETTEER.find((g) => g.name === city);
  if (!e) throw new Error(`Commune inconnue : ${city}`);
  return { lat: e.lat, lng: e.lng };
}

export interface PersonSpec {
  seats?: number | null; // null/undefined = pas de voiture
  pref?: DrivingPreference;
  city?: string;
  lat?: number;
  lng?: number;
  neverDrive?: boolean;
  priorityDriver?: boolean;
  lastResort?: boolean;
  carAvailable?: boolean;
}

export function person(id: string, spec: PersonSpec = {}): Participant {
  const c = spec.lat !== undefined && spec.lng !== undefined ? { lat: spec.lat, lng: spec.lng } : coords(spec.city ?? 'Nantes');
  const hasCar = spec.seats !== undefined && spec.seats !== null;
  return createParticipant({
    id,
    firstName: id,
    lastName: 'Test',
    home: { label: spec.city ?? 'Nantes', address: '', lat: c.lat, lng: c.lng },
    hasCar,
    carAvailable: spec.carAvailable ?? hasCar,
    seats: spec.seats ?? 0,
    drivingPreference: spec.pref ?? 'indifferent',
    neverDrive: spec.neverDrive ?? false,
    priorityDriver: spec.priorityDriver ?? false,
    acceptLastResort: spec.lastResort ?? false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

export function makeEvent(
  id: string,
  destCity: string,
  date: string,
  participants: Participant[],
  availability: Record<string, Availability> = {},
): SportEvent {
  const dest = coords(destCity);
  return createEvent({
    id,
    name: id,
    date,
    destination: { label: destCity, address: '', lat: dest.lat, lng: dest.lng },
    attendance: participants.map((p) => createAttendance(p.id, availability[p.id] ?? 'yes')),
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
  });
}

export function ctx(
  event: SportEvent,
  participants: Participant[],
  allEvents: SportEvent[] = [event],
  strategy: StrategyConfig = defaultStrategy('mixed'),
  extra: Partial<PlanContext> = {},
): PlanContext {
  return { event, participants, allEvents, strategy, now: '2026-01-01T00:00:00.000Z', seed: 1, ...extra };
}

export function driversOf(plan: Plan): string[] {
  return plan.vehicles.map((v) => v.driverId).sort();
}

export function strategyOf(mode: StrategyMode, patch: Partial<StrategyConfig> = {}): StrategyConfig {
  return { ...defaultStrategy(mode), ...patch };
}

/**
 * Planifie puis « termine » une suite d'événements dans l'ordre : chaque calcul tient compte
 * de l'historique des précédents (c'est ce qui permet de tester l'équité dans le temps).
 */
export function runSeason(
  participants: Participant[],
  events: SportEvent[],
  strategy: StrategyConfig,
  seed = 1,
): SportEvent[] {
  const done: SportEvent[] = events.map((e) => ({ ...e }));
  for (const e of done) {
    const plan = solve(ctx(e, participants, done, strategy, { seed, now: `${e.date}T06:00:00.000Z` }));
    e.plan = plan;
    e.status = 'done';
  }
  return done;
}
