// filepath: src/data/store.ts
// Conteneur d'état de l'application : abonnement, sauvegarde automatique, annulation, sauvegardes périodiques.
// Indépendant du DOM : testable avec MemoryStorage.

import type { AppState } from '../domain/types.ts';
import { nowIso } from '../domain/helpers.ts';
import { daysSince, markBackedUp } from './actions.ts';
import type { Action } from './actions.ts';
import { createEmptyState } from './schema.ts';
import type { StorageAdapter } from './storage.ts';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface StoreOptions {
  /** Délai de regroupement des sauvegardes (ms). 0 = immédiat. */
  autosaveDelayMs?: number;
  /** Nombre maximal d'annulations conservées. */
  maxUndo?: number;
}

type Listener = () => void;

export class Store {
  private current: AppState;
  private readonly storage: StorageAdapter;
  private readonly listeners = new Set<Listener>();
  private readonly undoStack: AppState[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly delay: number;
  private readonly maxUndo: number;

  saveStatus: SaveStatus = 'idle';
  lastError: string | null = null;
  /** Vrai si aucune donnée n'existait au démarrage. */
  isNew = false;
  /** Message d'information au démarrage (ex. sauvegarde automatique créée). */
  startupNotice: string | null = null;

  private constructor(storage: StorageAdapter, initial: AppState, options: StoreOptions) {
    this.storage = storage;
    this.current = initial;
    this.delay = options.autosaveDelayMs ?? 400;
    this.maxUndo = options.maxUndo ?? 20;
  }

  static async open(storage: StorageAdapter, options: StoreOptions = {}): Promise<Store> {
    const loaded = await storage.load();
    const store = new Store(storage, loaded ?? createEmptyState(), options);
    store.isNew = loaded === null;
    if (loaded === null && storage.lastLoadIssue) store.startupNotice = storage.lastLoadIssue;
    if (loaded) await store.autoBackupIfDue();
    return store;
  }

  get state(): AppState {
    return this.current;
  }

  get storageKind(): StorageAdapter['kind'] {
    return this.storage.kind;
  }

  get durable(): boolean {
    return this.storage.durable;
  }

  get adapter(): StorageAdapter {
    return this.storage;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Applique une action, notifie les abonnés et planifie la sauvegarde. */
  dispatch(action: Action, opts: { undoable?: boolean } = {}): void {
    const next = action(this.current);
    if (next === this.current) return;
    if (opts.undoable !== false) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    }
    this.current = next;
    this.emit();
    this.scheduleSave();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.current = prev;
    this.emit();
    this.scheduleSave();
    return true;
  }

  private scheduleSave(): void {
    this.saveStatus = 'saving';
    this.emit();
    if (this.timer) clearTimeout(this.timer);
    if (this.delay === 0) {
      this.timer = null;
      this.pending = this.persist();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = this.persist();
    }, this.delay);
  }

  private async persist(): Promise<void> {
    const snapshot = this.current;
    try {
      await this.storage.save(snapshot);
      if (this.current === snapshot) this.saveStatus = 'saved';
      this.lastError = null;
    } catch (e) {
      this.saveStatus = 'error';
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    this.emit();
  }

  /** Force l'écriture immédiate (fermeture de l'onglet, avant un import, dans les tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.pending = this.persist();
    }
    await this.pending;
  }

  /** Crée une sauvegarde interne horodatée de l'état courant. */
  async backupNow(label: string): Promise<void> {
    await this.flush();
    await this.storage.createBackup(this.current, label);
    this.dispatch(markBackedUp(), { undoable: false });
  }

  /** Sauvegarde automatique si la dernière date de plus que le délai configuré. */
  private async autoBackupIfDue(): Promise<void> {
    const s = this.current.settings;
    if (!s.autoBackupEnabled) return;
    const age = daysSince(this.current.meta.lastBackupAt);
    if (age !== null && age < s.backupEveryDays) return;
    if (this.current.participants.length === 0 && this.current.events.length === 0) return;
    try {
      await this.storage.createBackup(this.current, 'Sauvegarde automatique');
      this.current = markBackedUp(nowIso())(this.current);
      this.startupNotice = 'Une sauvegarde automatique de vos données vient d’être créée.';
      await this.storage.save(this.current);
    } catch {
      /* La sauvegarde automatique ne doit jamais empêcher d'ouvrir l'application. */
    }
  }

  /** Remplace l'état (import « tout remplacer » ou restauration), après une sauvegarde de sécurité. */
  async replaceWithBackup(next: AppState, safetyLabel: string): Promise<void> {
    await this.flush();
    await this.storage.createBackup(this.current, safetyLabel);
    this.dispatch(() => next);
    await this.flush();
  }
}
