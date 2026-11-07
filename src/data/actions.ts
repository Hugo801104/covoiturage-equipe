// filepath: src/data/actions.ts
// Transformations pures de l'état (aucun effet de bord) : testables sans navigateur ni stockage.
// Toute modification met à jour `updatedAt` de l'entité touchée — c'est ce qui permet la fusion à l'import.

import type { AppState, Attendance, Participant, Plan, Settings, SportEvent } from '../domain/types.ts';
import { createAttendance, nowIso } from '../domain/helpers.ts';
import { doneEventsSorted } from '../engine/history.ts';

export type Action = (state: AppState) => AppState;

const touch = (state: AppState, now: string): AppState => ({ ...state, meta: { ...state.meta, updatedAt: now } });

export const activeParticipants = (s: AppState): Participant[] => s.participants.filter((p) => p.deletedAt === null);
export const activeEvents = (s: AppState): SportEvent[] => s.events.filter((e) => e.deletedAt === null);

export function upsertParticipant(p: Participant, now: string = nowIso()): Action {
  return (state) => {
    const updated: Participant = { ...p, updatedAt: now };
    const exists = state.participants.some((x) => x.id === p.id);
    const participants = exists ? state.participants.map((x) => (x.id === p.id ? updated : x)) : [...state.participants, updated];
    // Un nouveau participant apparaît « sans réponse » dans les événements à venir.
    const events = exists
      ? state.events
      : state.events.map((e) =>
          e.status === 'planned' && e.deletedAt === null && !e.attendance.some((a) => a.participantId === p.id)
            ? { ...e, attendance: [...e.attendance, createAttendance(p.id)], updatedAt: now }
            : e,
        );
    return touch({ ...state, participants, events }, now);
  };
}

/** Suppression logique : le participant reste dans l'historique (statistiques et plans passés). */
export function deleteParticipant(id: string, now: string = nowIso()): Action {
  return (state) =>
    touch(
      { ...state, participants: state.participants.map((p) => (p.id === id ? { ...p, deletedAt: now, updatedAt: now } : p)) },
      now,
    );
}

export function restoreParticipant(id: string, now: string = nowIso()): Action {
  return (state) =>
    touch(
      { ...state, participants: state.participants.map((p) => (p.id === id ? { ...p, deletedAt: null, updatedAt: now } : p)) },
      now,
    );
}

/** Complète l'événement avec une ligne de disponibilité par participant actif. */
export function withCompleteAttendance(state: AppState, event: SportEvent): SportEvent {
  const have = new Set(event.attendance.map((a) => a.participantId));
  const missing = activeParticipants(state).filter((p) => !have.has(p.id));
  if (missing.length === 0) return event;
  return { ...event, attendance: [...event.attendance, ...missing.map((p) => createAttendance(p.id))] };
}

export function upsertEvent(e: SportEvent, now: string = nowIso()): Action {
  return (state) => {
    const updated: SportEvent = { ...withCompleteAttendance(state, e), updatedAt: now };
    const exists = state.events.some((x) => x.id === e.id);
    const events = exists ? state.events.map((x) => (x.id === e.id ? updated : x)) : [...state.events, updated];
    return touch({ ...state, events }, now);
  };
}

export function deleteEvent(id: string, now: string = nowIso()): Action {
  return (state) =>
    touch({ ...state, events: state.events.map((e) => (e.id === id ? { ...e, deletedAt: now, updatedAt: now } : e)) }, now);
}

export function setAttendance(eventId: string, attendance: Attendance[], now: string = nowIso()): Action {
  return (state) =>
    touch({ ...state, events: state.events.map((e) => (e.id === eventId ? { ...e, attendance, updatedAt: now } : e)) }, now);
}

export function setPlan(eventId: string, plan: Plan | null, now: string = nowIso()): Action {
  return (state) =>
    touch({ ...state, events: state.events.map((e) => (e.id === eventId ? { ...e, plan, updatedAt: now } : e)) }, now);
}

/** Marque l'événement comme terminé : son organisation entre alors dans l'historique et l'équité. */
export function completeEvent(eventId: string, now: string = nowIso()): Action {
  return (state) =>
    touch(
      {
        ...state,
        events: state.events.map((e) =>
          e.id === eventId && e.plan ? { ...e, status: 'done' as const, plan: { ...e.plan, validated: true }, updatedAt: now } : e,
        ),
      },
      now,
    );
}

export function reopenEvent(eventId: string, now: string = nowIso()): Action {
  return (state) =>
    touch({ ...state, events: state.events.map((e) => (e.id === eventId ? { ...e, status: 'planned' as const, updatedAt: now } : e)) }, now);
}

export function updateSettings(patch: Partial<Settings>): Action {
  return (state) => touch({ ...state, settings: { ...state.settings, ...patch } }, nowIso());
}

export function setTeamName(name: string): Action {
  return (state) => touch({ ...state, team: { name } }, nowIso());
}

export function markExported(now: string = nowIso()): Action {
  return (state) => ({ ...state, meta: { ...state.meta, lastExportAt: now } });
}

export function markBackedUp(now: string = nowIso()): Action {
  return (state) => ({ ...state, meta: { ...state.meta, lastBackupAt: now } });
}

export function replaceState(next: AppState): Action {
  return () => next;
}

// ───────────────────────── Sélecteurs ─────────────────────────

export function upcomingEvents(state: AppState, today: string): SportEvent[] {
  return activeEvents(state)
    .filter((e) => e.status === 'planned' && e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function pastEvents(state: AppState, today: string): SportEvent[] {
  return activeEvents(state)
    .filter((e) => e.status === 'done' || e.date < today)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function doneEvents(state: AppState): SportEvent[] {
  return doneEventsSorted(activeEvents(state));
}

export function daysSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / 86_400_000);
}
