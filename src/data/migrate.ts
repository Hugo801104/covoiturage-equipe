// filepath: src/data/migrate.ts
// Versions du format JSON et migrations.
//
// Pour faire évoluer le format :
//   1. incrémenter CURRENT_SCHEMA_VERSION dans schema.ts ;
//   2. ajouter ici MIGRATIONS[ancienneVersion] = (data) => nouvelleData (v → v+1) ;
//   3. documenter le changement dans docs/FORMAT_JSON.md et ajouter un test.
// Un fichier plus récent que l'application est refusé (jamais interprété à moitié).

import type { AppState } from '../domain/types.ts';
import { CURRENT_SCHEMA_VERSION, FILE_FORMAT } from './schema.ts';
import { validateAppState } from './validate.ts';
import type { ValidationIssue } from './validate.ts';

export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/** Clé = version de départ ; la fonction produit la version suivante. */
export const MIGRATIONS: Record<number, Migration> = {};

export type ParseResult =
  | { ok: true; state: AppState; fromVersion: number; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function migrateData(
  data: Record<string, unknown>,
  fromVersion: number,
  registry: Record<number, Migration> = MIGRATIONS,
  target: number = CURRENT_SCHEMA_VERSION,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) return { ok: false, error: 'numéro de version invalide' };
  if (fromVersion > target) {
    return {
      ok: false,
      error: `ce fichier a été créé par une version plus récente de l’application (format ${fromVersion}, cette version comprend jusqu’au format ${target}). Mettez l’application à jour.`,
    };
  }
  let current = data;
  for (let v = fromVersion; v < target; v++) {
    const step = registry[v];
    if (!step) return { ok: false, error: `aucune migration disponible du format ${v} vers ${v + 1}` };
    try {
      current = { ...step(current), schemaVersion: v + 1 };
    } catch (e) {
      return { ok: false, error: `échec de la migration ${v} → ${v + 1} : ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { ok: true, data: { ...current, schemaVersion: target } };
}

/**
 * Analyse le texte d'un fichier d'import : JSON → enveloppe → migration → validation.
 * Accepte l'enveloppe d'export (`format`, `schemaVersion`, `data`) ou un état brut.
 */
export function parseImportText(text: string, registry: Record<number, Migration> = MIGRATIONS, target: number = CURRENT_SCHEMA_VERSION): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [{ path: '', message: `ce fichier n’est pas un JSON valide (${e instanceof Error ? e.message : 'erreur de syntaxe'})` }] };
  }
  if (!isObj(json)) return { ok: false, errors: [{ path: '', message: 'le fichier doit contenir un objet JSON' }] };

  let payload: Record<string, unknown>;
  let version: unknown;
  if ('format' in json) {
    if (json['format'] !== FILE_FORMAT) {
      return { ok: false, errors: [{ path: 'format', message: `format inconnu « ${String(json['format'])} » : ce n’est pas une sauvegarde de cette application` }] };
    }
    if (!isObj(json['data'])) return { ok: false, errors: [{ path: 'data', message: 'données manquantes dans le fichier' }] };
    payload = json['data'];
    version = json['schemaVersion'] ?? payload['schemaVersion'];
  } else if ('participants' in json && 'events' in json) {
    payload = json;
    version = json['schemaVersion'];
  } else {
    return { ok: false, errors: [{ path: '', message: 'fichier non reconnu : ce n’est pas une sauvegarde de cette application' }] };
  }

  if (typeof version !== 'number') return { ok: false, errors: [{ path: 'schemaVersion', message: 'version de format absente ou invalide' }] };
  const migrated = migrateData(payload, version, registry, target);
  if (!migrated.ok) return { ok: false, errors: [{ path: 'schemaVersion', message: migrated.error }] };

  const validated = validateAppState(migrated.data);
  if (!validated.ok || !validated.value) return { ok: false, errors: validated.errors };
  return { ok: true, state: validated.value, fromVersion: version, warnings: validated.warnings };
}
