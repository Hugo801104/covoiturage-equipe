// filepath: src/data/schema.ts
import type { AppState, Settings } from '../domain/types.ts';
import { defaultStrategy, newId, nowIso } from '../domain/helpers.ts';

/** Version courante du format JSON. À incrémenter à chaque changement de structure + ajouter une migration. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Identifiant du format : permet de refuser un fichier qui n'est pas une sauvegarde de cette application. */
export const FILE_FORMAT = 'covoiturage-equipe';

export function defaultSettings(): Settings {
  return {
    strategy: defaultStrategy('mixed'),
    backupEveryDays: 7,
    autoBackupEnabled: true,
  };
}

export function createEmptyState(teamName = 'Mon équipe'): AppState {
  const now = nowIso();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    team: { name: teamName },
    participants: [],
    events: [],
    settings: defaultSettings(),
    meta: {
      deviceId: newId('dev'),
      createdAt: now,
      updatedAt: now,
      lastExportAt: null,
      lastBackupAt: null,
    },
  };
}

/** Enveloppe d'un fichier d'export JSON. */
export interface ExportFile {
  format: typeof FILE_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  data: AppState;
}

export const APP_VERSION = '1.0.0';

export function toExportFile(state: AppState): ExportFile {
  return {
    format: FILE_FORMAT,
    schemaVersion: state.schemaVersion,
    exportedAt: nowIso(),
    appVersion: APP_VERSION,
    data: state,
  };
}

/** Contenu du fichier d'export (JSON lisible, indenté). */
export function serializeExport(state: AppState): string {
  return JSON.stringify(toExportFile(state), null, 2);
}
