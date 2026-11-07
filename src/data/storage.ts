// filepath: src/data/storage.ts
// Persistance locale. Aucun réseau : IndexedDB en priorité, puis localStorage, puis mémoire
// (dernier recours, signalé à l'utilisateur car les données ne survivent pas à la fermeture).

import type { AppState } from '../domain/types.ts';
import { newId, nowIso } from '../domain/helpers.ts';
import { validateAppState } from './validate.ts';

export interface BackupMeta {
  id: string;
  createdAt: string;
  label: string;
  participants: number;
  events: number;
  bytes: number;
}

export interface StorageAdapter {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  /** Données persistantes ? (faux pour la mémoire seule) */
  readonly durable: boolean;
  /** Message si les données stockées étaient illisibles au dernier chargement (une copie brute est alors conservée). */
  lastLoadIssue: string | null;
  load(): Promise<AppState | null>;
  /** Copie brute de données illisibles, pour récupération manuelle. */
  loadCorruptedRaw(): Promise<string | null>;
  save(state: AppState): Promise<void>;
  listBackups(): Promise<BackupMeta[]>;
  createBackup(state: AppState, label: string): Promise<BackupMeta>;
  loadBackup(id: string): Promise<AppState | null>;
  deleteBackup(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const MAX_BACKUPS = 10;

const metaOf = (id: string, createdAt: string, label: string, state: AppState, bytes: number): BackupMeta => ({
  id,
  createdAt,
  label,
  participants: state.participants.filter((p) => p.deletedAt === null).length,
  events: state.events.filter((e) => e.deletedAt === null).length,
  bytes,
});

/** Relit un état stocké en le revalidant : un stockage corrompu ne doit jamais faire planter l'application. */
function revive(raw: unknown): AppState | null {
  const result = validateAppState(raw);
  return result.ok ? result.value : null;
}

/** Résumé lisible des erreurs de validation d'un état stocké. */
function issueOf(raw: unknown): string {
  const result = validateAppState(raw);
  const first = result.errors[0];
  return `Les données enregistrées sur cet appareil sont illisibles${first ? ` (${first.path || 'racine'} : ${first.message})` : ''}. Une copie brute a été conservée.`;
}

// ───────────────────────── Mémoire ─────────────────────────

export class MemoryStorage implements StorageAdapter {
  readonly kind = 'memory' as const;
  readonly durable = false;
  private current: string | null = null;
  private corrupted: string | null = null;
  private backups = new Map<string, { meta: BackupMeta; json: string }>();
  lastLoadIssue: string | null = null;

  async load(): Promise<AppState | null> {
    if (!this.current) return null;
    const state = revive(JSON.parse(this.current));
    if (!state) {
      this.corrupted = this.current;
      this.lastLoadIssue = issueOf(JSON.parse(this.current));
    }
    return state;
  }
  async loadCorruptedRaw(): Promise<string | null> {
    return this.corrupted;
  }
  async save(state: AppState): Promise<void> {
    this.current = JSON.stringify(state);
  }
  async listBackups(): Promise<BackupMeta[]> {
    return [...this.backups.values()].map((b) => b.meta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async createBackup(state: AppState, label: string): Promise<BackupMeta> {
    const json = JSON.stringify(state);
    const meta = metaOf(newId('bk'), nowIso(), label, state, json.length);
    this.backups.set(meta.id, { meta, json });
    await pruneBackups(this);
    return meta;
  }
  async loadBackup(id: string): Promise<AppState | null> {
    const b = this.backups.get(id);
    return b ? revive(JSON.parse(b.json)) : null;
  }
  async deleteBackup(id: string): Promise<void> {
    this.backups.delete(id);
  }
  async clear(): Promise<void> {
    this.current = null;
    this.corrupted = null;
    this.backups.clear();
  }
}

// ───────────────────────── localStorage ─────────────────────────

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

const LS_STATE = 'covoiturage:state';
const LS_CORRUPTED = 'covoiturage:corrupted';
const LS_BACKUP_PREFIX = 'covoiturage:backup:';

export class LocalStorageStorage implements StorageAdapter {
  readonly kind = 'localstorage' as const;
  readonly durable = true;
  private readonly kv: KeyValueStore;

  constructor(kv: KeyValueStore) {
    this.kv = kv;
  }

  lastLoadIssue: string | null = null;

  async load(): Promise<AppState | null> {
    const raw = this.kv.getItem(LS_STATE);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.kv.setItem(LS_CORRUPTED, raw);
      this.lastLoadIssue = 'Les données enregistrées sur cet appareil sont illisibles (JSON invalide). Une copie brute a été conservée.';
      return null;
    }
    const state = revive(parsed);
    if (!state) {
      this.kv.setItem(LS_CORRUPTED, raw);
      this.lastLoadIssue = issueOf(parsed);
    }
    return state;
  }
  async loadCorruptedRaw(): Promise<string | null> {
    return this.kv.getItem(LS_CORRUPTED);
  }
  async save(state: AppState): Promise<void> {
    this.kv.setItem(LS_STATE, JSON.stringify(state));
  }
  private backupKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < this.kv.length; i++) {
      const k = this.kv.key(i);
      if (k && k.startsWith(LS_BACKUP_PREFIX)) keys.push(k);
    }
    return keys;
  }
  async listBackups(): Promise<BackupMeta[]> {
    const out: BackupMeta[] = [];
    for (const k of this.backupKeys()) {
      try {
        const parsed = JSON.parse(this.kv.getItem(k) ?? '') as { meta: BackupMeta };
        out.push(parsed.meta);
      } catch {
        /* sauvegarde illisible : ignorée */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async createBackup(state: AppState, label: string): Promise<BackupMeta> {
    const json = JSON.stringify(state);
    const meta = metaOf(newId('bk'), nowIso(), label, state, json.length);
    this.kv.setItem(LS_BACKUP_PREFIX + meta.id, JSON.stringify({ meta, state }));
    await pruneBackups(this);
    return meta;
  }
  async loadBackup(id: string): Promise<AppState | null> {
    const raw = this.kv.getItem(LS_BACKUP_PREFIX + id);
    if (!raw) return null;
    try {
      return revive((JSON.parse(raw) as { state: unknown }).state);
    } catch {
      return null;
    }
  }
  async deleteBackup(id: string): Promise<void> {
    this.kv.removeItem(LS_BACKUP_PREFIX + id);
  }
  async clear(): Promise<void> {
    this.kv.removeItem(LS_STATE);
    this.kv.removeItem(LS_CORRUPTED);
    for (const k of this.backupKeys()) this.kv.removeItem(k);
  }
}

// ───────────────────────── IndexedDB ─────────────────────────

const DB_NAME = 'covoiturage-equipe';
const DB_VERSION = 1;
const STORE_STATE = 'state';
const STORE_BACKUPS = 'backups';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('Erreur IndexedDB'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Transaction IndexedDB en erreur'));
    tx.onabort = () => reject(tx.error ?? new Error('Transaction IndexedDB annulée'));
  });
}

export class IndexedDbStorage implements StorageAdapter {
  readonly kind = 'indexeddb' as const;
  readonly durable = true;
  private readonly db: IDBDatabase;
  lastLoadIssue: string | null = null;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static open(factory: IDBFactory = indexedDB): Promise<IndexedDbStorage> {
    return new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
        if (!db.objectStoreNames.contains(STORE_BACKUPS)) db.createObjectStore(STORE_BACKUPS, { keyPath: 'meta.id' });
      };
      request.onsuccess = () => resolve(new IndexedDbStorage(request.result));
      request.onerror = () => reject(request.error ?? new Error('Ouverture IndexedDB impossible'));
      request.onblocked = () => reject(new Error('Ouverture IndexedDB bloquée par un autre onglet'));
    });
  }

  async load(): Promise<AppState | null> {
    const tx = this.db.transaction(STORE_STATE, 'readonly');
    const raw = await req(tx.objectStore(STORE_STATE).get('current'));
    if (!raw) return null;
    const state = revive(raw);
    if (!state) {
      const wtx = this.db.transaction(STORE_STATE, 'readwrite');
      wtx.objectStore(STORE_STATE).put(JSON.stringify(raw), 'corrupted');
      await txDone(wtx);
      this.lastLoadIssue = issueOf(raw);
    }
    return state;
  }
  async loadCorruptedRaw(): Promise<string | null> {
    const tx = this.db.transaction(STORE_STATE, 'readonly');
    const raw = (await req(tx.objectStore(STORE_STATE).get('corrupted'))) as string | undefined;
    return raw ?? null;
  }
  async save(state: AppState): Promise<void> {
    const tx = this.db.transaction(STORE_STATE, 'readwrite');
    tx.objectStore(STORE_STATE).put(state, 'current');
    await txDone(tx);
  }
  async listBackups(): Promise<BackupMeta[]> {
    const tx = this.db.transaction(STORE_BACKUPS, 'readonly');
    const all = (await req(tx.objectStore(STORE_BACKUPS).getAll())) as Array<{ meta: BackupMeta }>;
    return all.map((b) => b.meta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async createBackup(state: AppState, label: string): Promise<BackupMeta> {
    const meta = metaOf(newId('bk'), nowIso(), label, state, JSON.stringify(state).length);
    const tx = this.db.transaction(STORE_BACKUPS, 'readwrite');
    tx.objectStore(STORE_BACKUPS).put({ meta, state });
    await txDone(tx);
    await pruneBackups(this);
    return meta;
  }
  async loadBackup(id: string): Promise<AppState | null> {
    const tx = this.db.transaction(STORE_BACKUPS, 'readonly');
    const rec = (await req(tx.objectStore(STORE_BACKUPS).get(id))) as { state: unknown } | undefined;
    return rec ? revive(rec.state) : null;
  }
  async deleteBackup(id: string): Promise<void> {
    const tx = this.db.transaction(STORE_BACKUPS, 'readwrite');
    tx.objectStore(STORE_BACKUPS).delete(id);
    await txDone(tx);
  }
  async clear(): Promise<void> {
    const tx = this.db.transaction([STORE_STATE, STORE_BACKUPS], 'readwrite');
    tx.objectStore(STORE_STATE).clear();
    tx.objectStore(STORE_BACKUPS).clear();
    await txDone(tx);
  }
}

/** Ne conserve que les MAX_BACKUPS sauvegardes les plus récentes. */
export async function pruneBackups(storage: StorageAdapter, keep: number = MAX_BACKUPS): Promise<void> {
  const list = await storage.listBackups();
  for (const old of list.slice(keep)) await storage.deleteBackup(old.id);
}

/** Choisit le meilleur stockage disponible dans l'environnement courant. */
export async function createBestStorage(): Promise<StorageAdapter> {
  const g = globalThis as { indexedDB?: IDBFactory; localStorage?: KeyValueStore };
  if (g.indexedDB) {
    try {
      return await IndexedDbStorage.open(g.indexedDB);
    } catch {
      /* IndexedDB indisponible (navigation privée, politique…) : repli. */
    }
  }
  try {
    if (g.localStorage) {
      g.localStorage.setItem('covoiturage:probe', '1');
      g.localStorage.removeItem('covoiturage:probe');
      return new LocalStorageStorage(g.localStorage);
    }
  } catch {
    /* localStorage refusé */
  }
  return new MemoryStorage();
}
