// filepath: src/ui/context.ts
// Contexte partagé par les vues : store, navigation, état d'interface persistant entre les rendus.

import type { AppState, Participant, SportEvent, StrategyConfig } from '../domain/types.ts';
import { nowIso } from '../domain/helpers.ts';
import type { PlanContext } from '../engine/index.ts';
import { activeEvents, activeParticipants } from '../data/actions.ts';
import type { Store } from '../data/store.ts';

export type RouteName = 'dashboard' | 'participants' | 'events' | 'organisation' | 'history' | 'data';

export interface Route {
  name: RouteName;
  param: string | null;
}

/** État purement visuel (jamais sauvegardé) conservé d'un rendu à l'autre. */
export interface UiState {
  participantFilter: string;
  participantEditId: string | 'new' | null;
  eventEditId: string | 'new' | null;
  attendanceFilter: string;
  orgKeepLocked: boolean;
  orgShowAdvanced: boolean;
  orgShowExplain: boolean;
  orgHiddenVehicles: Set<string>;
  orgComparison: ComparisonRow[] | null;
  orgComparisonEventId: string | null;
  historySort: { key: HistorySortKey; dir: 1 | -1 };
  importPreview: ImportPreview | null;
  importErrors: string[];
}

export type HistorySortKey = 'name' | 'attended' | 'drives' | 'balance' | 'passenger' | 'km' | 'streak';

export interface ComparisonRow {
  mode: StrategyConfig['mode'];
  driverNames: string[];
  cars: number;
  totalKm: number;
  imbalance: number;
  status: string;
  lines: string[];
}

export interface ImportPreview {
  fileName: string;
  incoming: AppState;
  warnings: string[];
  fromVersion: number;
}

export interface AppContext {
  store: Store;
  ui: UiState;
  route: Route;
  navigate(name: RouteName, param?: string | null): void;
  /** Redessine la vue courante sans toucher aux données. */
  refresh(): void;
  today(): string;
}

export function createUiState(): UiState {
  return {
    participantFilter: '',
    participantEditId: null,
    eventEditId: null,
    attendanceFilter: '',
    orgKeepLocked: true,
    orgShowAdvanced: false,
    orgShowExplain: false,
    orgHiddenVehicles: new Set(),
    orgComparison: null,
    orgComparisonEventId: null,
    historySort: { key: 'name', dir: 1 },
    importPreview: null,
    importErrors: [],
  };
}

/** Contexte du moteur pour un événement. Seuls les participants non supprimés sont éligibles. */
export function planContextFor(state: AppState, event: SportEvent, strategy: StrategyConfig, extra: Partial<PlanContext> = {}): PlanContext {
  return {
    event,
    participants: activeParticipants(state),
    allEvents: activeEvents(state),
    strategy,
    now: nowIso(),
    ...extra,
  };
}

export function findEvent(state: AppState, id: string | null): SportEvent | undefined {
  return id ? state.events.find((e) => e.id === id && e.deletedAt === null) : undefined;
}

export function findParticipant(state: AppState, id: string | null): Participant | undefined {
  return id ? state.participants.find((p) => p.id === id) : undefined;
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const names: RouteName[] = ['dashboard', 'participants', 'events', 'organisation', 'history', 'data'];
  const first = parts[0] as RouteName | undefined;
  const name = first && names.includes(first) ? first : 'dashboard';
  return { name, param: parts[1] ? decodeURIComponent(parts[1]) : null };
}

export function routeHash(name: RouteName, param: string | null = null): string {
  return `#/${name}${param ? `/${encodeURIComponent(param)}` : ''}`;
}
