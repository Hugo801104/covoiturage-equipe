// filepath: src/data/validate.ts
// Validation stricte d'un fichier JSON importé (ou d'un état relu du stockage).
// Aucune confiance accordée au contenu : types, plages, énumérations, identifiants uniques et
// références croisées sont vérifiés, et l'état renvoyé est reconstruit champ par champ (aucun champ
// inconnu ne passe). Les erreurs bloquent l'import ; les avertissements sont affichés à l'utilisateur.

import type {
  AlternativeSummary,
  AppMeta,
  AppState,
  Attendance,
  Availability,
  DrivingPreference,
  Locks,
  Participant,
  Place,
  Plan,
  PlanIssue,
  PlanMetrics,
  PlanStatus,
  Settings,
  SportEvent,
  StrategyConfig,
  StrategyMode,
  UnassignedEntry,
  Vehicle,
  VehicleMetrics,
  Weights,
} from '../domain/types.ts';
import { defaultStrategy } from '../domain/helpers.ts';
import { CURRENT_SCHEMA_VERSION, defaultSettings } from './schema.ts';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value: T | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const PREFERENCES: DrivingPreference[] = ['priority', 'volunteer', 'indifferent', 'prefer_passenger', 'refuse'];
const AVAILABILITIES: Availability[] = ['yes', 'no', 'unknown'];
const MODES: StrategyMode[] = ['equity', 'volunteer', 'mixed'];
const PLAN_STATUSES: PlanStatus[] = ['ok', 'incomplete', 'invalid'];
const SEVERITIES = ['error', 'warning', 'info'] as const;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TEXT = 5000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Ctx {
  errors: ValidationIssue[] = [];
  warnings: ValidationIssue[] = [];
  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }

  str(o: Obj, key: string, path: string, opts: { required?: boolean; max?: number; fallback?: string } = {}): string {
    const v = o[key];
    if (v === undefined || v === null) {
      if (opts.required) this.error(`${path}.${key}`, 'champ obligatoire manquant');
      return opts.fallback ?? '';
    }
    if (typeof v !== 'string') {
      this.error(`${path}.${key}`, 'doit être un texte');
      return opts.fallback ?? '';
    }
    if (opts.required && v.trim() === '') this.error(`${path}.${key}`, 'ne doit pas être vide');
    if (v.length > (opts.max ?? MAX_TEXT)) {
      this.error(`${path}.${key}`, `texte trop long (max ${opts.max ?? MAX_TEXT} caractères)`);
      return v.slice(0, opts.max ?? MAX_TEXT);
    }
    return v;
  }

  bool(o: Obj, key: string, path: string, fallback = false): boolean {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') {
      this.error(`${path}.${key}`, 'doit être vrai ou faux');
      return fallback;
    }
    return v;
  }

  num(o: Obj, key: string, path: string, opts: { min?: number; max?: number; int?: boolean; fallback?: number } = {}): number {
    const v = o[key];
    const fb = opts.fallback ?? 0;
    if (v === undefined || v === null) return fb;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.error(`${path}.${key}`, 'doit être un nombre');
      return fb;
    }
    if (opts.int && !Number.isInteger(v)) this.error(`${path}.${key}`, 'doit être un nombre entier');
    if (opts.min !== undefined && v < opts.min) this.error(`${path}.${key}`, `doit être ≥ ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) this.error(`${path}.${key}`, `doit être ≤ ${opts.max}`);
    return v;
  }

  nullableNum(o: Obj, key: string, path: string, min: number, max: number): number | null {
    const v = o[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.error(`${path}.${key}`, 'doit être un nombre ou null');
      return null;
    }
    if (v < min || v > max) {
      this.error(`${path}.${key}`, `doit être compris entre ${min} et ${max}`);
      return null;
    }
    return v;
  }

  oneOf<T extends string>(o: Obj, key: string, path: string, allowed: readonly T[], fallback: T): T {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    this.error(`${path}.${key}`, `valeur invalide « ${String(v)} » (attendu : ${allowed.join(', ')})`);
    return fallback;
  }

  strArray(o: Obj, key: string, path: string): string[] {
    const v = o[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.error(`${path}.${key}`, 'doit être une liste de textes');
      return [];
    }
    return v as string[];
  }

  iso(o: Obj, key: string, path: string, fallback: string): string {
    const v = this.str(o, key, path, { fallback, max: 40 });
    if (v !== '' && Number.isNaN(Date.parse(v))) {
      this.error(`${path}.${key}`, 'date/heure invalide');
      return fallback;
    }
    return v || fallback;
  }

  nullableIso(o: Obj, key: string, path: string): string | null {
    const v = o[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
      this.error(`${path}.${key}`, 'date/heure invalide ou null attendu');
      return null;
    }
    return v;
  }
}

function place(c: Ctx, raw: unknown, path: string): Place {
  if (!isObj(raw)) {
    if (raw !== undefined && raw !== null) c.error(path, 'doit être un objet lieu');
    return { label: '', address: '', lat: null, lng: null };
  }
  const lat = c.nullableNum(raw, 'lat', path, -90, 90);
  const lng = c.nullableNum(raw, 'lng', path, -180, 180);
  const consistent = (lat === null) === (lng === null);
  if (!consistent) c.warn(path, 'latitude et longitude doivent être renseignées ensemble : coordonnées ignorées');
  return {
    label: c.str(raw, 'label', path, { max: 200 }),
    address: c.str(raw, 'address', path, { max: 400 }),
    lat: consistent ? lat : null,
    lng: consistent ? lng : null,
  };
}

function participant(c: Ctx, raw: unknown, path: string): Participant | null {
  if (!isObj(raw)) {
    c.error(path, 'doit être un objet participant');
    return null;
  }
  const now = new Date(0).toISOString();
  const seats = c.num(raw, 'seats', path, { min: 0, max: 20, int: true });
  const hasCar = c.bool(raw, 'hasCar', path);
  const p: Participant = {
    id: c.str(raw, 'id', path, { required: true, max: 100 }),
    firstName: c.str(raw, 'firstName', path, { max: 100 }),
    lastName: c.str(raw, 'lastName', path, { max: 100 }),
    home: place(c, raw['home'], `${path}.home`),
    hasCar,
    carAvailable: c.bool(raw, 'carAvailable', path),
    seats,
    drivingPreference: c.oneOf(raw, 'drivingPreference', path, PREFERENCES, 'indifferent'),
    priorityDriver: c.bool(raw, 'priorityDriver', path),
    neverDrive: c.bool(raw, 'neverDrive', path),
    acceptLastResort: c.bool(raw, 'acceptLastResort', path),
    notes: c.str(raw, 'notes', path),
    createdAt: c.iso(raw, 'createdAt', path, now),
    updatedAt: c.iso(raw, 'updatedAt', path, now),
    deletedAt: c.nullableIso(raw, 'deletedAt', path),
  };
  if (!p.firstName.trim() && !p.lastName.trim() && p.deletedAt === null) c.error(path, 'un participant doit avoir un nom ou un prénom');
  if (!hasCar && p.carAvailable) c.warn(path, 'voiture « disponible » alors que le participant n’a pas de voiture');
  return p;
}

function attendance(c: Ctx, raw: unknown, path: string): Attendance | null {
  if (!isObj(raw)) {
    c.error(path, 'doit être un objet disponibilité');
    return null;
  }
  return {
    participantId: c.str(raw, 'participantId', path, { required: true, max: 100 }),
    availability: c.oneOf(raw, 'availability', path, AVAILABILITIES, 'unknown'),
    selfTransport: c.bool(raw, 'selfTransport', path),
    startOverride: raw['startOverride'] === null || raw['startOverride'] === undefined ? null : place(c, raw['startOverride'], `${path}.startOverride`),
    seatsOverride: c.nullableNum(raw, 'seatsOverride', path, 0, 20),
    carAvailableOverride:
      raw['carAvailableOverride'] === null || raw['carAvailableOverride'] === undefined
        ? null
        : c.bool(raw, 'carAvailableOverride', path),
    note: c.str(raw, 'note', path),
  };
}

function weights(c: Ctx, raw: unknown, path: string, fallback: Weights): Weights {
  if (!isObj(raw)) {
    if (raw !== undefined) c.error(path, 'doit être un objet de poids');
    return { ...fallback };
  }
  const w = (k: keyof Weights): number => c.num(raw, k, path, { min: 0, max: 10, fallback: fallback[k] });
  return {
    volunteer: w('volunteer'),
    tripEquity: w('tripEquity'),
    distanceEquity: w('distanceEquity'),
    consecutive: w('consecutive'),
    compactness: w('compactness'),
    fewCars: w('fewCars'),
  };
}

function strategy(c: Ctx, raw: unknown, path: string): StrategyConfig {
  const base = defaultStrategy('mixed');
  if (!isObj(raw)) {
    if (raw !== undefined) c.error(path, 'doit être un objet stratégie');
    return base;
  }
  const mode = c.oneOf(raw, 'mode', path, MODES, 'mixed');
  return {
    mode,
    weights: weights(c, raw['weights'], `${path}.weights`, defaultStrategy(mode).weights),
    maxConsecutive: c.num(raw, 'maxConsecutive', path, { min: 1, max: 50, int: true, fallback: base.maxConsecutive }),
    maxDetourKm: c.num(raw, 'maxDetourKm', path, { min: 0, max: 1000, fallback: base.maxDetourKm }),
    extraCars: c.num(raw, 'extraCars', path, { min: 0, max: 5, int: true, fallback: base.extraCars }),
  };
}

function plan(c: Ctx, raw: unknown, path: string): Plan | null {
  if (raw === null || raw === undefined) return null;
  if (!isObj(raw)) {
    c.error(path, 'doit être un objet plan ou null');
    return null;
  }
  const vehiclesRaw = raw['vehicles'];
  const vehicles: Vehicle[] = [];
  if (!Array.isArray(vehiclesRaw)) c.error(`${path}.vehicles`, 'doit être une liste');
  else {
    vehiclesRaw.forEach((v: unknown, i: number) => {
      const vp = `${path}.vehicles[${i}]`;
      if (!isObj(v)) return c.error(vp, 'doit être un objet véhicule');
      vehicles.push({
        id: c.str(v, 'id', vp, { required: true, max: 200 }),
        driverId: c.str(v, 'driverId', vp, { required: true, max: 100 }),
        passengerIds: c.strArray(v, 'passengerIds', vp),
      });
    });
  }

  const unassigned: UnassignedEntry[] = [];
  const unRaw = raw['unassigned'];
  if (Array.isArray(unRaw)) {
    unRaw.forEach((u: unknown, i: number) => {
      const up = `${path}.unassigned[${i}]`;
      if (!isObj(u)) return c.error(up, 'doit être un objet');
      unassigned.push({ participantId: c.str(u, 'participantId', up, { required: true, max: 100 }), reason: c.str(u, 'reason', up) });
    });
  } else if (unRaw !== undefined) c.error(`${path}.unassigned`, 'doit être une liste');

  const locksRaw = raw['locks'];
  const locks: Locks = { drivers: [], assignments: {} };
  if (isObj(locksRaw)) {
    locks.drivers = c.strArray(locksRaw, 'drivers', `${path}.locks`);
    const a = locksRaw['assignments'];
    if (isObj(a)) {
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'string') locks.assignments[k] = v;
        else c.error(`${path}.locks.assignments.${k}`, 'doit être un identifiant');
      }
    } else if (a !== undefined) c.error(`${path}.locks.assignments`, 'doit être un objet');
  } else if (locksRaw !== undefined) c.error(`${path}.locks`, 'doit être un objet');

  const issues: PlanIssue[] = [];
  const issuesRaw = raw['issues'];
  if (Array.isArray(issuesRaw)) {
    issuesRaw.forEach((it: unknown, i: number) => {
      const ip = `${path}.issues[${i}]`;
      if (!isObj(it)) return c.error(ip, 'doit être un objet');
      issues.push({
        severity: c.oneOf(it, 'severity', ip, SEVERITIES, 'info'),
        code: c.str(it, 'code', ip, { max: 60 }) as PlanIssue['code'],
        message: c.str(it, 'message', ip),
        participantIds: c.strArray(it, 'participantIds', ip),
        vehicleId: typeof it['vehicleId'] === 'string' ? it['vehicleId'] : null,
      });
    });
  }

  const m = raw['metrics'];
  let metrics: PlanMetrics = { carsUsed: 0, totalKm: 0, totalDetourKm: 0, soloKm: 0, vehicles: [], passengerKm: {}, distanceKind: 'straight_line' };
  if (isObj(m)) {
    const mp = `${path}.metrics`;
    const vms: VehicleMetrics[] = [];
    const vmRaw = m['vehicles'];
    if (Array.isArray(vmRaw)) {
      vmRaw.forEach((x: unknown, i: number) => {
        const xp = `${mp}.vehicles[${i}]`;
        if (!isObj(x)) return c.error(xp, 'doit être un objet');
        vms.push({
          vehicleId: c.str(x, 'vehicleId', xp, { required: true, max: 200 }),
          routeKm: c.num(x, 'routeKm', xp, { min: 0 }),
          directKm: c.num(x, 'directKm', xp, { min: 0 }),
          detourKm: c.num(x, 'detourKm', xp, { min: 0 }),
          seatsUsed: c.num(x, 'seatsUsed', xp, { min: 0, int: true }),
          seatsTotal: c.num(x, 'seatsTotal', xp, { min: 0, int: true }),
        });
      });
    }
    const pk: Record<string, number> = {};
    const pkRaw = m['passengerKm'];
    if (isObj(pkRaw)) {
      for (const [k, v] of Object.entries(pkRaw)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) pk[k] = v;
        else c.error(`${mp}.passengerKm.${k}`, 'doit être un nombre positif');
      }
    }
    metrics = {
      carsUsed: c.num(m, 'carsUsed', mp, { min: 0, int: true }),
      totalKm: c.num(m, 'totalKm', mp, { min: 0 }),
      totalDetourKm: c.num(m, 'totalDetourKm', mp, { min: 0 }),
      soloKm: c.num(m, 'soloKm', mp, { min: 0 }),
      vehicles: vms,
      passengerKm: pk,
      distanceKind: c.oneOf(m, 'distanceKind', mp, ['straight_line', 'road'] as const, 'straight_line'),
    };
  } else c.error(`${path}.metrics`, 'métriques du plan manquantes');

  const alternatives: AlternativeSummary[] = [];
  const altRaw = raw['alternatives'];
  if (Array.isArray(altRaw)) {
    altRaw.forEach((a: unknown, i: number) => {
      const ap = `${path}.alternatives[${i}]`;
      if (!isObj(a)) return c.error(ap, 'doit être un objet');
      alternatives.push({
        driverIds: c.strArray(a, 'driverIds', ap),
        carsUsed: c.num(a, 'carsUsed', ap, { min: 0, int: true }),
        totalKm: c.num(a, 'totalKm', ap, { min: 0 }),
        score: c.num(a, 'score', ap),
        projectedImbalance: c.num(a, 'projectedImbalance', ap, { min: 0 }),
      });
    });
  }

  return {
    id: c.str(raw, 'id', path, { required: true, max: 200 }),
    strategy: strategy(c, raw['strategy'], `${path}.strategy`),
    generatedAt: c.iso(raw, 'generatedAt', path, new Date(0).toISOString()),
    source: c.oneOf(raw, 'source', path, ['engine', 'manual'] as const, 'engine'),
    vehicles,
    unassigned,
    excluded: c.strArray(raw, 'excluded', path),
    selfTransportIds: c.strArray(raw, 'selfTransportIds', path),
    eligibleDriverIds: c.strArray(raw, 'eligibleDriverIds', path),
    attendeeIds: c.strArray(raw, 'attendeeIds', path),
    locks,
    issues,
    suggestions: c.strArray(raw, 'suggestions', path),
    status: c.oneOf(raw, 'status', path, PLAN_STATUSES, 'incomplete'),
    metrics,
    alternatives,
    validated: c.bool(raw, 'validated', path),
  };
}

function event(c: Ctx, raw: unknown, path: string): SportEvent | null {
  if (!isObj(raw)) {
    c.error(path, 'doit être un objet événement');
    return null;
  }
  const now = new Date(0).toISOString();
  const day = c.str(raw, 'date', path, { required: true, max: 10 });
  if (day !== '' && (!DAY_RE.test(day) || Number.isNaN(Date.parse(day)))) c.error(`${path}.date`, 'date invalide (format AAAA-MM-JJ)');
  const dep = c.str(raw, 'departureTime', path, { max: 5, fallback: '08:00' });
  if (dep !== '' && !TIME_RE.test(dep)) c.error(`${path}.departureTime`, 'heure invalide (format HH:MM)');
  const retRaw = raw['returnTime'];
  let ret: string | null = null;
  if (typeof retRaw === 'string' && retRaw !== '') {
    if (!TIME_RE.test(retRaw)) c.error(`${path}.returnTime`, 'heure invalide (format HH:MM)');
    else ret = retRaw;
  } else if (retRaw !== null && retRaw !== undefined && retRaw !== '') c.error(`${path}.returnTime`, 'doit être une heure ou null');

  const attRaw = raw['attendance'];
  const att: Attendance[] = [];
  if (Array.isArray(attRaw)) {
    const seen = new Set<string>();
    attRaw.forEach((a: unknown, i: number) => {
      const parsed = attendance(c, a, `${path}.attendance[${i}]`);
      if (!parsed) return;
      if (seen.has(parsed.participantId)) c.error(`${path}.attendance[${i}]`, `participant en double : ${parsed.participantId}`);
      seen.add(parsed.participantId);
      att.push(parsed);
    });
  } else if (attRaw !== undefined) c.error(`${path}.attendance`, 'doit être une liste');

  return {
    id: c.str(raw, 'id', path, { required: true, max: 100 }),
    name: c.str(raw, 'name', path, { required: true, max: 200 }),
    date: day,
    departureTime: dep || '08:00',
    returnTime: ret,
    destination: place(c, raw['destination'], `${path}.destination`),
    constraints: c.str(raw, 'constraints', path),
    attendance: att,
    status: c.oneOf(raw, 'status', path, ['planned', 'done'] as const, 'planned'),
    plan: plan(c, raw['plan'], `${path}.plan`),
    createdAt: c.iso(raw, 'createdAt', path, now),
    updatedAt: c.iso(raw, 'updatedAt', path, now),
    deletedAt: c.nullableIso(raw, 'deletedAt', path),
  };
}

function settings(c: Ctx, raw: unknown): Settings {
  const base = defaultSettings();
  if (!isObj(raw)) {
    if (raw !== undefined) c.error('settings', 'doit être un objet');
    return base;
  }
  return {
    strategy: strategy(c, raw['strategy'], 'settings.strategy'),
    backupEveryDays: c.num(raw, 'backupEveryDays', 'settings', { min: 0, max: 365, int: true, fallback: base.backupEveryDays }),
    autoBackupEnabled: c.bool(raw, 'autoBackupEnabled', 'settings', base.autoBackupEnabled),
  };
}

function meta(c: Ctx, raw: unknown): AppMeta {
  const now = new Date().toISOString();
  if (!isObj(raw)) {
    if (raw !== undefined) c.error('meta', 'doit être un objet');
    return { deviceId: 'dev_unknown', createdAt: now, updatedAt: now, lastExportAt: null, lastBackupAt: null };
  }
  return {
    deviceId: c.str(raw, 'deviceId', 'meta', { fallback: 'dev_unknown', max: 100 }),
    createdAt: c.iso(raw, 'createdAt', 'meta', now),
    updatedAt: c.iso(raw, 'updatedAt', 'meta', now),
    lastExportAt: c.nullableIso(raw, 'lastExportAt', 'meta'),
    lastBackupAt: c.nullableIso(raw, 'lastBackupAt', 'meta'),
  };
}

/** Valide un état d'application déjà migré vers la version courante. */
export function validateAppState(input: unknown): ValidationResult<AppState> {
  const c = new Ctx();
  if (!isObj(input)) {
    c.error('', 'le contenu doit être un objet JSON');
    return { ok: false, value: null, errors: c.errors, warnings: c.warnings };
  }

  const version = c.num(input, 'schemaVersion', '', { min: 1, int: true, fallback: 0 });
  if (version !== CURRENT_SCHEMA_VERSION) c.error('schemaVersion', `version ${version} non prise en charge (attendu : ${CURRENT_SCHEMA_VERSION})`);

  const teamRaw = input['team'];
  const team = { name: isObj(teamRaw) ? c.str(teamRaw, 'name', 'team', { max: 200, fallback: 'Mon équipe' }) : 'Mon équipe' };
  if (!isObj(teamRaw)) c.error('team', 'doit être un objet');

  const participants: Participant[] = [];
  const pRaw = input['participants'];
  if (!Array.isArray(pRaw)) c.error('participants', 'doit être une liste');
  else {
    const ids = new Set<string>();
    pRaw.forEach((raw: unknown, i: number) => {
      const p = participant(c, raw, `participants[${i}]`);
      if (!p) return;
      if (ids.has(p.id)) c.error(`participants[${i}].id`, `identifiant en double : ${p.id}`);
      ids.add(p.id);
      participants.push(p);
    });
  }

  const events: SportEvent[] = [];
  const eRaw = input['events'];
  if (!Array.isArray(eRaw)) c.error('events', 'doit être une liste');
  else {
    const ids = new Set<string>();
    const known = new Set(participants.map((p) => p.id));
    eRaw.forEach((raw: unknown, i: number) => {
      const e = event(c, raw, `events[${i}]`);
      if (!e) return;
      if (ids.has(e.id)) c.error(`events[${i}].id`, `identifiant en double : ${e.id}`);
      ids.add(e.id);
      // Références croisées
      const before = e.attendance.length;
      e.attendance = e.attendance.filter((a) => known.has(a.participantId));
      if (e.attendance.length < before) c.warn(`events[${i}].attendance`, `${before - e.attendance.length} disponibilité(s) ignorée(s) : participant inconnu`);
      if (e.plan) {
        const used = new Set<string>();
        for (const v of e.plan.vehicles) [v.driverId, ...v.passengerIds].forEach((x) => used.add(x));
        const unknown = [...used].filter((x) => !known.has(x));
        if (unknown.length > 0) c.warn(`events[${i}].plan`, `le plan référence ${unknown.length} participant(s) inconnu(s)`);
      }
      if (e.status === 'done' && !e.plan) c.warn(`events[${i}]`, 'événement terminé sans organisation : ignoré dans les statistiques');
      events.push(e);
    });
  }

  const value: AppState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    team,
    participants,
    events,
    settings: settings(c, input['settings']),
    meta: meta(c, input['meta']),
  };
  return { ok: c.errors.length === 0, value: c.errors.length === 0 ? value : null, errors: c.errors, warnings: c.warnings };
}
