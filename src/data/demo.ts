// filepath: src/data/demo.ts
// Jeu de données de démonstration : 24 participants autour de Nantes, des voitures de capacités
// variées, des préférences de conduite contrastées, 6 tournois passés (historique réel généré par
// le moteur) et 3 tournois à venir.

import type { AppState, DrivingPreference, Participant, SportEvent } from '../domain/types.ts';
import { createAttendance, createEvent, createParticipant } from '../domain/helpers.ts';
import { GAZETTEER, placeFromEntry } from '../domain/gazetteer.ts';
import type { PlanContext } from '../engine/problem.ts';
import { solve } from '../engine/solver.ts';
import { createEmptyState } from './schema.ts';

interface DemoRow {
  first: string;
  last: string;
  city: string;
  /** null = pas de voiture. */
  seats: number | null;
  pref: DrivingPreference;
  priorityDriver?: boolean;
  neverDrive?: boolean;
  lastResort?: boolean;
  notes?: string;
}

const ROWS: DemoRow[] = [
  { first: 'Hugo', last: 'Martin', city: 'Nantes', seats: 4, pref: 'priority' },
  { first: 'Jasmin', last: 'Bernard', city: 'Rezé', seats: 3, pref: 'volunteer' },
  { first: 'Léa', last: 'Dubois', city: 'Vertou', seats: 4, pref: 'volunteer' },
  { first: 'Thomas', last: 'Moreau', city: 'Saint-Sébastien-sur-Loire', seats: 4, pref: 'indifferent' },
  { first: 'Camille', last: 'Laurent', city: 'Saint-Herblain', seats: 3, pref: 'indifferent' },
  { first: 'Nathan', last: 'Simon', city: 'Orvault', seats: 4, pref: 'priority', priorityDriver: true },
  { first: 'Emma', last: 'Michel', city: 'Carquefou', seats: 2, pref: 'prefer_passenger', lastResort: true },
  { first: 'Lucas', last: 'Lefebvre', city: 'Bouguenais', seats: 4, pref: 'refuse', notes: 'Ne souhaite pas conduire.' },
  { first: 'Chloé', last: 'Garcia', city: 'Couëron', seats: 3, pref: 'volunteer' },
  { first: 'Maxime', last: 'Roux', city: 'Sainte-Luce-sur-Loire', seats: 6, pref: 'volunteer', notes: 'Minibus 7 places.' },
  { first: 'Inès', last: 'Fournier', city: 'Basse-Goulaine', seats: null, pref: 'refuse' },
  { first: 'Louis', last: 'Girard', city: 'La Chapelle-sur-Erdre', seats: 4, pref: 'indifferent' },
  { first: 'Manon', last: 'Bonnet', city: 'Sautron', seats: null, pref: 'refuse' },
  { first: 'Hugo', last: 'Lambert', city: 'Les Sorinières', seats: 3, pref: 'volunteer' },
  { first: 'Sarah', last: 'Mercier', city: 'Nantes', seats: null, pref: 'refuse' },
  { first: 'Antoine', last: 'Blanc', city: 'Rezé', seats: null, pref: 'refuse' },
  { first: 'Julie', last: 'Faure', city: 'Vertou', seats: 4, pref: 'prefer_passenger' },
  { first: 'Romain', last: 'Perrin', city: 'Saint-Herblain', seats: null, pref: 'refuse' },
  { first: 'Clara', last: 'Morel', city: 'Thouaré-sur-Loire', seats: 4, pref: 'indifferent' },
  { first: 'Paul', last: 'André', city: 'Saint-Étienne-de-Montluc', seats: null, pref: 'refuse' },
  { first: 'Eva', last: 'Lopez', city: 'Clisson', seats: 3, pref: 'volunteer' },
  { first: 'Mathis', last: 'Roche', city: 'Nantes', seats: null, pref: 'refuse' },
  { first: 'Zoé', last: 'Vincent', city: 'Orvault', seats: null, pref: 'refuse' },
  { first: 'Enzo', last: 'Colin', city: 'Carquefou', seats: 4, pref: 'refuse', neverDrive: true, notes: 'Ne doit jamais conduire.' },
];

const ISO = '2026-09-01T08:00:00.000Z';

function cityPlace(city: string, address = '') {
  const entry = GAZETTEER.find((g) => g.name === city);
  if (!entry) throw new Error(`Commune inconnue dans le jeu de démonstration : ${city}`);
  return placeFromEntry(entry, address);
}

export function buildDemoParticipants(): Participant[] {
  return ROWS.map((r, i) => {
    const hasCar = r.seats !== null;
    return createParticipant({
      id: `p_demo_${String(i + 1).padStart(2, '0')}`,
      firstName: r.first,
      lastName: r.last,
      home: cityPlace(r.city),
      hasCar,
      carAvailable: hasCar,
      seats: r.seats ?? 0,
      drivingPreference: r.pref,
      priorityDriver: r.priorityDriver ?? false,
      neverDrive: r.neverDrive ?? false,
      acceptLastResort: r.lastResort ?? false,
      notes: r.notes ?? '',
      createdAt: ISO,
      updatedAt: ISO,
    });
  });
}

interface DemoEventRow {
  id: string;
  name: string;
  city: string;
  date: string;
  time: string;
  done: boolean;
  /** Indices (1-based) des absents. */
  absent: number[];
  unknown?: number[];
}

const EVENTS: DemoEventRow[] = [
  { id: 'e_demo_1', name: 'Tournoi d’Angers', city: 'Angers', date: '2026-09-12', time: '07:30', done: true, absent: [5, 13, 22] },
  { id: 'e_demo_2', name: 'Match à Cholet', city: 'Cholet', date: '2026-09-26', time: '12:30', done: true, absent: [3, 8, 16, 20] },
  { id: 'e_demo_3', name: 'Tournoi de La Roche-sur-Yon', city: 'La Roche-sur-Yon', date: '2026-10-03', time: '07:00', done: true, absent: [2, 12, 18] },
  { id: 'e_demo_4', name: 'Rencontre à Saint-Nazaire', city: 'Saint-Nazaire', date: '2026-10-10', time: '09:00', done: true, absent: [1, 7, 15, 24] },
  { id: 'e_demo_5', name: 'Tournoi de Rennes', city: 'Rennes', date: '2026-10-17', time: '06:45', done: true, absent: [9, 14, 21] },
  { id: 'e_demo_6', name: 'Match à Vannes', city: 'Vannes', date: '2026-10-24', time: '07:15', done: true, absent: [4, 11, 19, 23] },
  { id: 'e_demo_7', name: 'Finale régionale à Angers', city: 'Angers', date: '2026-11-14', time: '08:00', done: false, absent: [10], unknown: [6, 17] },
  { id: 'e_demo_8', name: 'Tournoi du Mans', city: 'Le Mans', date: '2026-11-28', time: '06:30', done: false, absent: [2, 9], unknown: [14] },
  { id: 'e_demo_9', name: 'Tournoi de Rennes (retour)', city: 'Rennes', date: '2026-12-12', time: '07:00', done: false, absent: [], unknown: [20, 21, 22] },
];

/** Construit un état de démonstration complet avec historique calculé par le moteur. */
export function buildDemoState(): AppState {
  const state = createEmptyState('Les Loups de Loire (démo)');
  state.participants = buildDemoParticipants();

  const events: SportEvent[] = [];
  for (const row of EVENTS) {
    const attendance = state.participants.map((p, i) => {
      const idx = i + 1;
      const availability = row.absent.includes(idx) ? 'no' : row.unknown?.includes(idx) ? 'unknown' : 'yes';
      return createAttendance(p.id, availability);
    });
    const destination = cityPlace(row.city);
    const event = createEvent({
      id: row.id,
      name: row.name,
      date: row.date,
      departureTime: row.time,
      returnTime: null,
      destination: { ...destination, address: `Complexe sportif de ${row.city}` },
      attendance,
      createdAt: ISO,
      updatedAt: ISO,
    });
    events.push(event);
  }

  // Les événements passés sont planifiés dans l'ordre : chacun tient compte de l'historique précédent.
  for (const event of events) {
    if (!EVENTS.find((e) => e.id === event.id)?.done) continue;
    const ctx: PlanContext = {
      event,
      participants: state.participants,
      allEvents: events,
      strategy: state.settings.strategy,
      now: `${event.date}T06:00:00.000Z`,
      seed: 7,
    };
    const plan = solve(ctx);
    // Identifiant stable : charger la démo sur deux appareils ne doit pas créer de faux conflits à l'import.
    event.plan = { ...plan, id: `plan_${event.id}`, validated: true };
    event.status = 'done';
  }

  state.events = events;
  return state;
}
