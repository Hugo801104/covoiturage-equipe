// filepath: src/data/merge.ts
// Import d'un fichier JSON SANS écrasement silencieux.
//
// Sans serveur, il n'existe pas d'ancêtre commun entre deux copies : on compare donc entité par
// entité (participant, événement) via leur identifiant :
//   - absente en local            → AJOUTÉE (jamais destructif) ;
//   - identique                   → rien à faire ;
//   - présente des deux côtés mais différente → CONFLIT : l'utilisateur choisit « garder la mienne »
//     ou « prendre celle du fichier », champ par champ visible ; par défaut on GARDE LA LOCALE ;
//   - présente uniquement en local → conservée (un import n'efface jamais rien).
// Les suppressions sont des « tombstones » (deletedAt) : elles se propagent comme des modifications.

import type { AppState, Participant, SportEvent } from '../domain/types.ts';
import { nowIso } from '../domain/helpers.ts';

export type EntityKind = 'participant' | 'event';
export type DiffStatus = 'added' | 'unchanged' | 'conflict' | 'local_only' | 'ignored';
export type Resolution = 'local' | 'remote';

export interface EntityDiff {
  kind: EntityKind;
  id: string;
  label: string;
  status: DiffStatus;
  /** Pour un conflit : quelle copie a été modifiée le plus récemment. */
  newer: 'local' | 'remote' | 'same' | null;
  /** Champs qui diffèrent (pour affichage). */
  changedFields: string[];
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  localDeleted: boolean;
  remoteDeleted: boolean;
}

export interface ImportAnalysis {
  participants: EntityDiff[];
  events: EntityDiff[];
  teamNameDiffers: boolean;
  settingsDiffer: boolean;
  counts: { added: number; unchanged: number; conflicts: number; localOnly: number; ignored: number };
}

/** Clé de résolution d'un conflit. */
export const diffKey = (d: Pick<EntityDiff, 'kind' | 'id'>): string => `${d.kind}:${d.id}`;

/** Sérialisation stable (clés triées) pour comparer des objets. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

const IGNORED_FIELDS = new Set(['updatedAt', 'createdAt']);

function changedFields(a: object, b: object): string[] {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  const out: string[] = [];
  for (const k of keys) {
    if (IGNORED_FIELDS.has(k)) continue;
    if (stableStringify(ra[k]) !== stableStringify(rb[k])) out.push(k);
  }
  return out.sort();
}

function compareTimes(a: string, b: string): 'local' | 'remote' | 'same' {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (ta === tb) return 'same';
  return ta > tb ? 'local' : 'remote';
}

function participantLabel(p: Participant): string {
  return `${p.firstName} ${p.lastName}`.trim() || 'Sans nom';
}

function diffList<T extends Participant | SportEvent>(
  kind: EntityKind,
  local: T[],
  remote: T[],
  label: (x: T) => string,
): EntityDiff[] {
  const out: EntityDiff[] = [];
  const localById = new Map(local.map((x) => [x.id, x]));
  const remoteIds = new Set(remote.map((x) => x.id));

  for (const r of remote) {
    const l = localById.get(r.id);
    if (!l) {
      out.push({
        kind,
        id: r.id,
        label: label(r),
        status: r.deletedAt ? 'ignored' : 'added',
        newer: null,
        changedFields: [],
        localUpdatedAt: null,
        remoteUpdatedAt: r.updatedAt,
        localDeleted: false,
        remoteDeleted: r.deletedAt !== null,
      });
      continue;
    }
    const fields = changedFields(l, r);
    out.push({
      kind,
      id: r.id,
      label: label(l),
      status: fields.length === 0 ? 'unchanged' : 'conflict',
      newer: fields.length === 0 ? null : compareTimes(l.updatedAt, r.updatedAt),
      changedFields: fields,
      localUpdatedAt: l.updatedAt,
      remoteUpdatedAt: r.updatedAt,
      localDeleted: l.deletedAt !== null,
      remoteDeleted: r.deletedAt !== null,
    });
  }
  for (const l of local) {
    if (!remoteIds.has(l.id)) {
      out.push({
        kind,
        id: l.id,
        label: label(l),
        status: 'local_only',
        newer: null,
        changedFields: [],
        localUpdatedAt: l.updatedAt,
        remoteUpdatedAt: null,
        localDeleted: l.deletedAt !== null,
        remoteDeleted: false,
      });
    }
  }
  return out;
}

export function analyzeImport(local: AppState, incoming: AppState): ImportAnalysis {
  const participants = diffList('participant', local.participants, incoming.participants, participantLabel);
  const events = diffList('event', local.events, incoming.events, (e) => `${e.name} (${e.date})`);
  const all = [...participants, ...events];
  const count = (s: DiffStatus): number => all.filter((d) => d.status === s).length;
  return {
    participants,
    events,
    teamNameDiffers: local.team.name !== incoming.team.name,
    settingsDiffer: stableStringify(local.settings) !== stableStringify(incoming.settings),
    counts: {
      added: count('added'),
      unchanged: count('unchanged'),
      conflicts: count('conflict'),
      localOnly: count('local_only'),
      ignored: count('ignored'),
    },
  };
}

/** Résolution par défaut sans risque : garder les données locales. */
export function defaultResolutions(analysis: ImportAnalysis): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const d of [...analysis.participants, ...analysis.events]) if (d.status === 'conflict') out[diffKey(d)] = 'local';
  out['team'] = 'local';
  out['settings'] = 'local';
  return out;
}

/** Résolution « le plus récent gagne » (à appliquer seulement sur demande explicite). */
export function newestResolutions(analysis: ImportAnalysis): Record<string, Resolution> {
  const out = defaultResolutions(analysis);
  for (const d of [...analysis.participants, ...analysis.events]) {
    if (d.status === 'conflict' && d.newer === 'remote') out[diffKey(d)] = 'remote';
  }
  return out;
}

function mergeList<T extends { id: string }>(
  kind: EntityKind,
  local: T[],
  remote: T[],
  resolutions: Record<string, Resolution>,
): T[] {
  const remoteById = new Map(remote.map((x) => [x.id, x]));
  const merged: T[] = local.map((l) => {
    const r = remoteById.get(l.id);
    if (!r) return l;
    if (stableStringify(l) === stableStringify(r)) return l;
    // Conflit éventuel : par défaut on garde la copie locale.
    return resolutions[`${kind}:${l.id}`] === 'remote' ? r : l;
  });
  const localIds = new Set(local.map((x) => x.id));
  for (const r of remote) {
    const deleted = (r as { deletedAt?: string | null }).deletedAt;
    if (!localIds.has(r.id) && !deleted) merged.push(r);
  }
  return merged;
}

/**
 * Applique la fusion. Les entités nouvelles sont ajoutées, les conflits suivent `resolutions`
 * (garder la locale par défaut), rien n'est jamais supprimé.
 */
export function applyImport(local: AppState, incoming: AppState, resolutions: Record<string, Resolution>): AppState {
  const now = nowIso();
  return {
    ...local,
    team: resolutions['team'] === 'remote' ? incoming.team : local.team,
    participants: mergeList('participant', local.participants, incoming.participants, resolutions),
    events: mergeList('event', local.events, incoming.events, resolutions),
    settings: resolutions['settings'] === 'remote' ? incoming.settings : local.settings,
    meta: { ...local.meta, updatedAt: now },
  };
}

/** Remplacement total (le appelant doit avoir créé une sauvegarde automatique juste avant). */
export function replaceAll(local: AppState, incoming: AppState): AppState {
  return {
    ...incoming,
    meta: { ...incoming.meta, deviceId: local.meta.deviceId, updatedAt: nowIso() },
  };
}
