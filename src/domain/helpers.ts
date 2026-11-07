// filepath: src/domain/helpers.ts
import type {
  Attendance,
  DrivingPreference,
  Participant,
  Place,
  SportEvent,
  StrategyConfig,
  StrategyMode,
  Weights,
} from './types.ts';

// ───────────────────────── Identifiants et dates ─────────────────────────

let counter = 0;

/** Identifiant unique, sans dépendance : crypto.randomUUID si disponible. */
export function newId(prefix = ''): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid =
    g.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayDay(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ───────────────────────── Lieux ─────────────────────────

export function emptyPlace(): Place {
  return { label: '', address: '', lat: null, lng: null };
}

export function hasCoords(place: Place | null | undefined): place is Place & { lat: number; lng: number } {
  return !!place && typeof place.lat === 'number' && typeof place.lng === 'number'
    && Number.isFinite(place.lat) && Number.isFinite(place.lng);
}

// ───────────────────────── Participants ─────────────────────────

export function fullName(p: Pick<Participant, 'firstName' | 'lastName'>): string {
  return `${p.firstName} ${p.lastName}`.trim() || 'Sans nom';
}

export const DRIVING_PREFERENCE_LABELS: Record<DrivingPreference, string> = {
  priority: 'Souhaite conduire en priorité',
  volunteer: 'Volontaire pour conduire',
  indifferent: 'Indifférent',
  prefer_passenger: 'Préfère être passager',
  refuse: 'Ne souhaite pas conduire',
};

export const DRIVING_PREFERENCE_SHORT: Record<DrivingPreference, string> = {
  priority: 'Prioritaire',
  volunteer: 'Volontaire',
  indifferent: 'Indifférent',
  prefer_passenger: 'Passager',
  refuse: 'Ne conduit pas',
};

export function createParticipant(partial: Partial<Participant> = {}): Participant {
  const now = nowIso();
  return {
    id: newId('p'),
    firstName: '',
    lastName: '',
    home: emptyPlace(),
    hasCar: false,
    carAvailable: false,
    seats: 0,
    drivingPreference: 'indifferent',
    priorityDriver: false,
    neverDrive: false,
    acceptLastResort: false,
    notes: '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...partial,
  };
}

// ───────────────────────── Capacité à conduire vs volonté de conduire ─────────────────────────

/** Deux notions distinctes : (1) capacité = voiture disponible ; (2) volonté = préférences. */
export interface EffectiveDrivingProfile {
  /** (1) A une voiture mise à disposition pour cet événement. */
  canDrive: boolean;
  /** Nombre de places passagers (hors conducteur) pour cet événement. */
  seats: number;
  /** (2) Accepte de conduire (au moins en dernier recours). */
  willDrive: boolean;
  /** Ne conduit que si aucune autre solution. */
  lastResortOnly: boolean;
}

export function effectiveDrivingProfile(p: Participant, att: Attendance | undefined): EffectiveDrivingProfile {
  const carAvailable = att?.carAvailableOverride ?? p.carAvailable;
  const seats = Math.max(0, Math.floor(att?.seatsOverride ?? p.seats));
  const canDrive = p.hasCar && carAvailable;
  const refuses = p.neverDrive || p.drivingPreference === 'refuse';
  const lastResortOnly = p.drivingPreference === 'prefer_passenger';
  const willDrive = !refuses && (!lastResortOnly || p.acceptLastResort);
  return { canDrive, seats, willDrive, lastResortOnly };
}

// ───────────────────────── Événements ─────────────────────────

export function createAttendance(participantId: string, availability: Attendance['availability'] = 'unknown'): Attendance {
  return {
    participantId,
    availability,
    selfTransport: false,
    startOverride: null,
    seatsOverride: null,
    carAvailableOverride: null,
    note: '',
  };
}

export function createEvent(partial: Partial<SportEvent> = {}): SportEvent {
  const now = nowIso();
  return {
    id: newId('e'),
    name: '',
    date: todayDay(),
    departureTime: '08:00',
    returnTime: null,
    destination: emptyPlace(),
    constraints: '',
    attendance: [],
    status: 'planned',
    plan: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...partial,
  };
}

export function attendanceOf(event: SportEvent, participantId: string): Attendance | undefined {
  return event.attendance.find((a) => a.participantId === participantId);
}

// ───────────────────────── Stratégies par défaut ─────────────────────────

export const STRATEGY_PRESETS: Record<StrategyMode, Weights> = {
  // Équité absolue : l'équité prime sur tout le reste ; les préférences ne servent qu'à départager.
  equity: { volunteer: 0, tripEquity: 10, distanceEquity: 5, consecutive: 5, compactness: 5, fewCars: 6 },
  // Priorité aux volontaires : les paliers de préférence dominent ; l'équité départage à l'intérieur d'un palier.
  volunteer: { volunteer: 10, tripEquity: 3, distanceEquity: 1, consecutive: 3, compactness: 5, fewCars: 6 },
  // Mixte (recommandé) : les volontaires sont favorisés mais perdent leur priorité s'ils conduisent beaucoup.
  mixed: { volunteer: 5, tripEquity: 5, distanceEquity: 3, consecutive: 5, compactness: 5, fewCars: 6 },
};

export const STRATEGY_LABELS: Record<StrategyMode, { title: string; short: string; description: string }> = {
  mixed: {
    title: 'Mixte (recommandé)',
    short: 'Mixte',
    description:
      'Favorise ceux qui veulent conduire, tout en répartissant les trajets : plus on a conduit, moins on est prioritaire.',
  },
  equity: {
    title: 'Équité absolue',
    short: 'Équité',
    description:
      'Chaque conducteur possible conduit autant que les autres sur la durée, quelles que soient ses préférences.',
  },
  volunteer: {
    title: 'Priorité aux volontaires',
    short: 'Volontaires',
    description:
      'Les volontaires conduisent d’abord, puis les indifférents ; on tourne entre volontaires pour ne pas épuiser les mêmes.',
  },
};

export function defaultStrategy(mode: StrategyMode = 'mixed'): StrategyConfig {
  return {
    mode,
    weights: { ...STRATEGY_PRESETS[mode] },
    maxConsecutive: 2,
    maxDetourKm: 25,
    extraCars: 1,
  };
}
