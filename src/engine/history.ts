// filepath: src/engine/history.ts
// Statistiques de conduite cumulées sur les événements terminés, et « dette de conduite ».
//
// Principe d'équité sur la durée : pour chaque événement passé, chaque conducteur possible
// présent se voit attribuer une PART ÉQUITABLE = (nombre de voitures) / (nombre de conducteurs
// possibles présents). Sa « dette » cumulée = trajets réellement conduits − parts équitables.
//   dette > 0 : a conduit plus que sa part → moins prioritaire ;
//   dette < 0 : a conduit moins que sa part → plus prioritaire.
// Comme seuls les présents comptent, l'absence à un tournoi ne crée ni dette ni crédit.

import type { Participant, SportEvent } from '../domain/types.ts';

export interface ParticipantHistory {
  participantId: string;
  eventsAttended: number;
  timesDriver: number;
  timesPassenger: number;
  timesSelfTransport: number;
  kmDriver: number;
  kmPassenger: number;
  /** Trajets conduits attendus si la charge avait été parfaitement partagée. */
  expectedDrives: number;
  /** timesDriver − expectedDrives. */
  driveBalance: number;
  /** Km conduits attendus si la charge avait été parfaitement partagée. */
  expectedKm: number;
  /** kmDriver − expectedKm. */
  kmBalance: number;
  /** Trajets conducteur consécutifs (parmi les événements auxquels il a participé). */
  currentStreak: number;
  lastDroveDate: string | null;
  /** Nombre de fois dans la même voiture qu'un autre participant. */
  rodeWith: Record<string, number>;
}

export function emptyHistory(participantId: string): ParticipantHistory {
  return {
    participantId,
    eventsAttended: 0,
    timesDriver: 0,
    timesPassenger: 0,
    timesSelfTransport: 0,
    kmDriver: 0,
    kmPassenger: 0,
    expectedDrives: 0,
    driveBalance: 0,
    expectedKm: 0,
    kmBalance: 0,
    currentStreak: 0,
    lastDroveDate: null,
    rodeWith: {},
  };
}

/** Événements terminés disposant d'un plan, triés chronologiquement. */
export function doneEventsSorted(events: SportEvent[]): SportEvent[] {
  return events
    .filter((e) => e.status === 'done' && e.plan !== null && e.deletedAt === null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}

/** Événements terminés à prendre en compte pour calculer l'équité avant `target`. */
export function historyEventsFor(target: SportEvent, allEvents: SportEvent[]): SportEvent[] {
  return doneEventsSorted(allEvents).filter((e) => e.id !== target.id && e.date <= target.date);
}

export function computeHistory(
  participants: Participant[],
  doneEvents: SportEvent[],
): Map<string, ParticipantHistory> {
  const map = new Map<string, ParticipantHistory>();
  for (const p of participants) map.set(p.id, emptyHistory(p.id));
  const get = (id: string): ParticipantHistory => {
    let h = map.get(id);
    if (!h) {
      h = emptyHistory(id);
      map.set(id, h);
    }
    return h;
  };

  for (const event of doneEventsSorted(doneEvents)) {
    const plan = event.plan;
    if (!plan) continue;
    const driverIds = new Set(plan.vehicles.map((v) => v.driverId));
    const eligible = new Set<string>([...plan.eligibleDriverIds, ...driverIds]);
    const cars = plan.vehicles.length;
    const km: Record<string, number> = {};
    let totalDriverKm = 0;
    for (const vm of plan.metrics.vehicles) {
      const vehicle = plan.vehicles.find((v) => v.id === vm.vehicleId);
      if (vehicle) km[vehicle.driverId] = vm.routeKm;
      totalDriverKm += vm.routeKm;
    }

    // Participation réelle : conducteurs, passagers et transports autonomes.
    const participants_: string[] = [];
    for (const v of plan.vehicles) {
      participants_.push(v.driverId, ...v.passengerIds);
      const group = [v.driverId, ...v.passengerIds];
      for (const a of group) {
        for (const b of group) {
          if (a !== b) get(a).rodeWith[b] = (get(a).rodeWith[b] ?? 0) + 1;
        }
      }
    }
    for (const id of plan.selfTransportIds) participants_.push(id);

    // Équité : parts équitables attribuées aux conducteurs possibles présents.
    if (eligible.size > 0 && cars > 0) {
      const shareCount = cars / eligible.size;
      const shareKm = totalDriverKm / eligible.size;
      for (const id of eligible) {
        const h = get(id);
        h.expectedDrives += shareCount;
        h.expectedKm += shareKm;
      }
    }

    for (const id of participants_) get(id).eventsAttended += 1;

    for (const v of plan.vehicles) {
      const d = get(v.driverId);
      d.timesDriver += 1;
      d.kmDriver += km[v.driverId] ?? 0;
      d.currentStreak += 1;
      d.lastDroveDate = event.date;
      for (const pid of v.passengerIds) {
        const p = get(pid);
        p.timesPassenger += 1;
        p.kmPassenger += plan.metrics.passengerKm[pid] ?? 0;
      }
    }
    for (const id of plan.selfTransportIds) get(id).timesSelfTransport += 1;

    // Série : un participant présent qui n'a pas conduit casse sa série ; un absent la conserve.
    for (const id of new Set(participants_)) {
      if (!driverIds.has(id)) get(id).currentStreak = 0;
    }
  }

  for (const h of map.values()) {
    h.driveBalance = h.timesDriver - h.expectedDrives;
    h.kmBalance = h.kmDriver - h.expectedKm;
  }
  return map;
}

/** Distance moyenne d'un trajet conducteur (sert à convertir des km en « trajets équivalents »). */
export function averageDriveKm(history: Map<string, ParticipantHistory>, fallback = 60): number {
  let km = 0;
  let drives = 0;
  for (const h of history.values()) {
    km += h.kmDriver;
    drives += h.timesDriver;
  }
  return drives > 0 && km > 0 ? km / drives : fallback;
}
