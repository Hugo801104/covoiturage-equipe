// filepath: src/ui/format.ts
// Formatage (dates françaises, distances, libellés) et accès pratique aux données pour les vues.

import type { AppState, Participant, Place, SportEvent, StrategyMode } from '../domain/types.ts';
import { fullName } from '../domain/helpers.ts';

export const fmtKm = (km: number): string => `${(Math.round(km * 10) / 10).toString().replace('.', ',')} km`;

export const fmtNum = (x: number, digits = 1): string => (Math.round(x * 10 ** digits) / 10 ** digits).toString().replace('.', ',');

export const fmtSigned = (x: number, digits = 1): string => `${x > 0 ? '+' : ''}${fmtNum(x, digits)}`;

export function fmtDay(day: string, withYear = true): string {
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return 'jamais';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} Ko`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

export const MODE_SHORT: Record<StrategyMode, string> = { equity: 'Équité', volunteer: 'Volontaires', mixed: 'Mixte' };

export function participantMap(state: AppState): Map<string, Participant> {
  return new Map(state.participants.map((p) => [p.id, p]));
}

/** Nom affichable, y compris pour un participant supprimé (historique). */
export function nameFor(map: Map<string, Participant>, id: string): string {
  const p = map.get(id);
  if (!p) return 'Participant inconnu';
  return p.deletedAt ? `${fullName(p)} (supprimé)` : fullName(p);
}

export function placeText(place: Place | null | undefined): string {
  if (!place) return '—';
  return place.label || place.address || '—';
}

export function eventTitle(e: SportEvent): string {
  return `${e.name || 'Événement'} · ${fmtDay(e.date, false)}`;
}

export function compareNames(a: Participant, b: Participant): number {
  return fullName(a).localeCompare(fullName(b), 'fr', { sensitivity: 'base' });
}
