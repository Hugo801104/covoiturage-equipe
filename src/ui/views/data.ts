// filepath: src/ui/views/data.ts
// Écran Données : export/import JSON versionné avec résolution des conflits, sauvegardes internes, démo, remise à zéro.

import type { AppState } from '../../domain/types.ts';
import { analyzeImport, applyImport, defaultResolutions, diffKey, newestResolutions, replaceAll } from '../../data/merge.ts';
import type { EntityDiff, ImportAnalysis, Resolution } from '../../data/merge.ts';
import { parseImportText } from '../../data/migrate.ts';
import { createEmptyState, serializeExport } from '../../data/schema.ts';
import { buildDemoState } from '../../data/demo.ts';
import { markExported, replaceState, updateSettings } from '../../data/actions.ts';
import type { BackupMeta } from '../../data/storage.ts';
import type { AppContext } from '../context.ts';
import { confirmDialog, downloadText, h, readFileAsText, slug, toast } from '../dom.ts';
import { badge, card, checkField, errorBox, pageHeader } from '../components.ts';
import { fmtBytes, fmtDateTime } from '../format.ts';

let resolutions: Record<string, Resolution> = {};
let backupsCache: BackupMeta[] | null = null;
let corruptedRaw: string | null = null;
let loadingBackups = false;

export function renderData(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  const root = h('div', { class: 'view' });
  root.appendChild(pageHeader('Données', 'Tout reste sur cet appareil. Exportez un fichier JSON pour sauvegarder ou partager avec d’autres appareils.'));

  if (!store.durable) {
    root.appendChild(h('div', { class: 'alert alert-error', role: 'alert' }, h('strong', null, 'Stockage non durable. '), 'Votre navigateur n’autorise aucun stockage local : les données seront perdues à la fermeture. Exportez régulièrement un fichier JSON.'));
  }
  if (store.lastError) root.appendChild(h('div', { class: 'alert alert-error', role: 'alert' }, `La dernière sauvegarde automatique a échoué : ${store.lastError}`));

  root.append(exportCard(ctx), importCard(ctx), backupsCard(ctx), settingsCard(ctx), dangerCard(ctx));
  void ensureBackups(ctx);
  return root;
}

async function ensureBackups(ctx: AppContext): Promise<void> {
  if (loadingBackups || backupsCache !== null) return;
  loadingBackups = true;
  try {
    backupsCache = await ctx.store.adapter.listBackups();
    corruptedRaw = await ctx.store.adapter.loadCorruptedRaw();
  } catch {
    backupsCache = [];
  } finally {
    loadingBackups = false;
    if (ctx.route.name === 'data') ctx.refresh();
  }
}

function invalidateBackups(): void { backupsCache = null; }

// ───────────────────────── Export ─────────────────────────

function exportCard(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  const doExport = (): void => {
    const state = store.state;
    const date = new Date().toISOString().slice(0, 10);
    downloadText(`covoiturage-${slug(state.team.name)}-${date}.json`, serializeExport(state));
    store.dispatch(markExported(), { undoable: false });
    toast('Fichier exporté. Conservez-le ou transmettez-le à un autre appareil.', { kind: 'success' });
  };
  return card('Exporter',
    h('p', null, 'Un fichier JSON versionné contenant participants, événements, organisations, historique et réglages.'),
    h('p', { class: 'muted' }, `Dernier export : ${fmtDateTime(store.state.meta.lastExportAt)}`),
    h('button', { type: 'button', class: 'btn btn-primary', onclick: doExport }, 'Télécharger le fichier JSON'));
}

// ───────────────────────── Import ─────────────────────────

function importCard(ctx: AppContext): HTMLElement {
  const { store, ui } = ctx;
  const messages = h('div', null, ui.importErrors.length > 0 ? errorBox(ui.importErrors) : null);
  const input = h('input', {
    type: 'file', id: 'import-file', accept: '.json,application/json', class: 'sr-only',
    onchange: async (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await readFileAsText(file);
        const parsed = parseImportText(text);
        if (!parsed.ok) {
          ui.importPreview = null;
          ui.importErrors = [`Fichier « ${file.name} » refusé — aucune donnée n’a été modifiée.`, ...parsed.errors.slice(0, 12).map((x) => (x.path ? `${x.path} : ${x.message}` : x.message)), ...(parsed.errors.length > 12 ? [`… et ${parsed.errors.length - 12} autre(s) erreur(s)`] : [])];
          ctx.refresh();
          return;
        }
        ui.importErrors = [];
        ui.importPreview = { fileName: file.name, incoming: parsed.state, warnings: parsed.warnings.map((w) => (w.path ? `${w.path} : ${w.message}` : w.message)), fromVersion: parsed.fromVersion };
        resolutions = defaultResolutions(analyzeImport(store.state, parsed.state));
        ctx.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Lecture impossible.', { kind: 'error' });
      }
    },
  });

  const body: Array<HTMLElement | null> = [
    h('p', null, 'L’import ', h('strong', null, 'n’écrase jamais'), ' vos données sans votre accord : le fichier est d’abord analysé, puis vous choisissez comment résoudre chaque différence.'),
    h('label', { class: 'btn btn-primary', for: 'import-file' }, 'Choisir un fichier JSON…'), input, messages,
  ];
  if (ui.importPreview) body.push(importPreview(ctx));
  return card('Importer', ...body);
}

function importPreview(ctx: AppContext): HTMLElement {
  const { store, ui } = ctx;
  const pv = ui.importPreview as NonNullable<typeof ui.importPreview>;
  const analysis = analyzeImport(store.state, pv.incoming);
  const c = analysis.counts;
  const conflicts = [...analysis.participants, ...analysis.events].filter((d) => d.status === 'conflict');

  const apply = async (): Promise<void> => {
    const next = applyImport(store.state, pv.incoming, resolutions);
    await store.replaceWithBackup(next, 'Avant import (fusion)');
    ui.importPreview = null;
    invalidateBackups();
    toast('Fusion appliquée. Une sauvegarde de l’état précédent a été créée.', { kind: 'success' });
    ctx.refresh();
  };
  const replace = async (): Promise<void> => {
    if (!(await confirmDialog({ title: 'Tout remplacer ?', message: 'Toutes vos données actuelles seront remplacées par celles du fichier. Une sauvegarde de sécurité est créée avant.', confirmLabel: 'Tout remplacer', danger: true }))) return;
    await store.replaceWithBackup(replaceAll(store.state, pv.incoming), 'Avant import (remplacement total)');
    ui.importPreview = null;
    invalidateBackups();
    toast('Données remplacées par le fichier.', { kind: 'success' });
    ctx.refresh();
  };

  return h('div', { class: 'import-preview' },
    h('h3', null, `Analyse de « ${pv.fileName} »`),
    pv.fromVersion < 0 ? null : h('p', { class: 'hint' }, `Version du format : ${pv.fromVersion}${pv.fromVersion < store.state.schemaVersion ? ' (migrée automatiquement)' : ''}`),
    h('ul', { class: 'plain' },
      h('li', null, badge(String(c.added), 'ok'), ' nouvel élément(s) à ajouter'),
      h('li', null, badge(String(c.unchanged), 'neutral'), ' identique(s)'),
      h('li', null, badge(String(c.conflicts), c.conflicts ? 'warn' : 'neutral'), ' conflit(s) à arbitrer'),
      h('li', null, badge(String(c.localOnly), 'neutral'), ' présent(s) uniquement ici (conservés)'),
      c.ignored ? h('li', null, badge(String(c.ignored), 'neutral'), ' supprimé(s) dans le fichier et inconnu(s) ici (ignorés)') : null),
    analysis.teamNameDiffers || analysis.settingsDiffer ? h('p', { class: 'hint' }, 'Le nom d’équipe et les réglages locaux sont conservés.') : null,
    pv.warnings.length ? h('details', null, h('summary', null, `${pv.warnings.length} avertissement(s)`), h('ul', null, pv.warnings.slice(0, 30).map((w) => h('li', null, w)))) : null,
    conflicts.length > 0 ? conflictTable(ctx, conflicts) : null,
    h('div', { class: 'row-wrap' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void apply() }, c.conflicts ? 'Appliquer la fusion avec ces choix' : 'Fusionner'),
      conflicts.length ? h('button', { type: 'button', class: 'btn', onclick: () => { resolutions = newestResolutions(analysis); ctx.refresh(); } }, 'Le plus récent gagne partout') : null,
      conflicts.length ? h('button', { type: 'button', class: 'btn', onclick: () => { resolutions = defaultResolutions(analysis); ctx.refresh(); } }, 'Tout garder en local') : null,
      h('button', { type: 'button', class: 'btn btn-danger-ghost', onclick: () => void replace() }, 'Tout remplacer par le fichier'),
      h('button', { type: 'button', class: 'btn', onclick: () => { ui.importPreview = null; ctx.refresh(); } }, 'Annuler l’import')));
}

function conflictTable(ctx: AppContext, conflicts: EntityDiff[]): HTMLElement {
  const rows = conflicts.map((d) => {
    const key = diffKey(d);
    const name = `choix-${key}`;
    const radio = (value: Resolution, label: string): HTMLElement => {
      const id = `${name}-${value}`;
      return h('label', { class: 'radio', for: id }, h('input', { id, type: 'radio', name, checked: (resolutions[key] ?? 'local') === value, onchange: () => { resolutions[key] = value; } }), label);
    };
    return h('tr', null,
      h('th', { scope: 'row' }, d.label, h('div', { class: 'hint' }, d.kind === 'participant' ? 'Participant' : 'Événement')),
      h('td', null, d.changedFields.join(', ') || '—', d.remoteDeleted ? badge('supprimé dans le fichier', 'warn') : null, d.localDeleted ? badge('supprimé ici', 'warn') : null),
      h('td', null, fmtDateTime(d.localUpdatedAt)), h('td', null, fmtDateTime(d.remoteUpdatedAt), d.newer === 'remote' ? h('span', null, ' ', badge('plus récent', 'info')) : null),
      h('td', { role: 'radiogroup', 'aria-label': `Résolution pour ${d.label}` }, radio('local', 'Garder ici'), radio('remote', 'Prendre le fichier')));
  });
  return h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Conflits à résoudre' }, h('table', { class: 'table' },
    h('caption', null, 'Conflits : choisissez la version à conserver pour chacun'),
    h('thead', null, h('tr', null, ['Élément', 'Champs différents', 'Modifié ici', 'Modifié (fichier)', 'Résolution'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', null, rows)));
}

// ───────────────────────── Sauvegardes internes ─────────────────────────

function backupsCard(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  const list = backupsCache;
  const body: Array<HTMLElement | null> = [
    h('p', null, 'Copies automatiques conservées sur cet appareil (les 10 plus récentes). Une copie de sécurité est aussi créée avant chaque import ou remise à zéro.'),
    h('div', { class: 'row-wrap' }, h('button', { type: 'button', class: 'btn', onclick: async () => { await store.backupNow('Sauvegarde manuelle'); invalidateBackups(); toast('Sauvegarde créée.', { kind: 'success' }); ctx.refresh(); } }, 'Créer une sauvegarde maintenant')),
  ];
  if (corruptedRaw) {
    body.push(h('div', { class: 'alert alert-error', role: 'alert' }, h('strong', null, 'Des données illisibles ont été détectées. '), 'Une copie brute est conservée.',
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => downloadText('donnees-illisibles.txt', corruptedRaw ?? '', 'text/plain') }, 'Télécharger la copie brute')));
  }
  if (list === null) body.push(h('p', { class: 'muted', role: 'status' }, 'Chargement des sauvegardes…'));
  else if (list.length === 0) body.push(h('p', { class: 'muted' }, 'Aucune sauvegarde pour le moment.'));
  else {
    body.push(h('ul', { class: 'plain backups' }, list.map((b) => h('li', { class: 'history-item' },
      h('div', { class: 'grow' }, h('strong', null, b.label), h('div', { class: 'hint' }, `${fmtDateTime(b.createdAt)} · ${b.participants} participants · ${b.events} événements · ${fmtBytes(b.bytes)}`)),
      h('span', { class: 'row-wrap tight' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: async () => {
          if (!(await confirmDialog({ title: 'Restaurer cette sauvegarde ?', message: `L’état actuel sera d’abord sauvegardé, puis remplacé par la sauvegarde du ${fmtDateTime(b.createdAt)}.`, confirmLabel: 'Restaurer' }))) return;
          const state = await store.adapter.loadBackup(b.id);
          if (!state) { toast('Cette sauvegarde est illisible.', { kind: 'error' }); return; }
          await store.replaceWithBackup(state, 'Avant restauration');
          invalidateBackups();
          toast('Sauvegarde restaurée.', { kind: 'success' });
          ctx.refresh();
        } }, 'Restaurer'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: async () => {
          const state = await store.adapter.loadBackup(b.id);
          if (state) downloadText(`sauvegarde-${slug(state.team.name)}-${b.createdAt.slice(0, 10)}.json`, serializeExport(state)); else toast('Sauvegarde illisible.', { kind: 'error' });
        } }, 'Télécharger'),
        h('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', onclick: async () => { await store.adapter.deleteBackup(b.id); invalidateBackups(); ctx.refresh(); } }, 'Supprimer')))))); 
  }
  return card('Sauvegardes sur cet appareil', ...body);
}

// ───────────────────────── Réglages / zone sensible ─────────────────────────

function settingsCard(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  const s = store.state.settings;
  const nameInput = h('input', { id: 'team-name', value: store.state.team.name, maxlength: 120, onchange: (e: Event) => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (v) store.dispatch((st: AppState) => ({ ...st, team: { name: v }, meta: { ...st.meta, updatedAt: new Date().toISOString() } }));
  } });
  return card('Réglages',
    h('div', { class: 'field' }, h('label', { for: 'team-name' }, 'Nom de l’équipe'), nameInput),
    wired(checkField('autoBackup', 'Sauvegarde automatique sur cet appareil', s.autoBackupEnabled), (checked) => store.dispatch(updateSettings({ autoBackupEnabled: checked }))),
    h('div', { class: 'field' }, h('label', { for: 'backup-days' }, 'Rappel d’export / sauvegarde tous les (jours)'),
      h('input', { id: 'backup-days', type: 'number', min: 0, max: 365, class: 'narrow', value: String(s.backupEveryDays), onchange: (e: Event) => {
        const n = Math.round(Number((e.target as HTMLInputElement).value));
        if (Number.isFinite(n) && n >= 0 && n <= 365) store.dispatch(updateSettings({ backupEveryDays: n }));
      } }), h('small', { class: 'hint' }, '0 désactive le rappel.')),
    h('p', { class: 'muted' }, `Stockage : ${storageLabel(store.storageKind)}.`, ' ', persistInfo()));
}

function wired(field: HTMLElement, onChange: (checked: boolean) => void): HTMLElement {
  field.querySelector('input')?.addEventListener('change', (e) => onChange((e.target as HTMLInputElement).checked));
  return field;
}

function storageLabel(kind: string): string {
  return kind === 'indexeddb' ? 'IndexedDB (navigateur)' : kind === 'localstorage' ? 'localStorage (navigateur)' : 'mémoire uniquement (non durable)';
}

const persistNode = h('span', null);
function persistInfo(): HTMLElement {
  const storage = (navigator as Navigator & { storage?: StorageManager }).storage;
  if (storage?.persisted) {
    storage.persisted().then((p) => { persistNode.textContent = p ? 'Stockage protégé contre l’effacement automatique.' : 'Le navigateur peut effacer ces données en cas de manque d’espace : exportez régulièrement.'; }).catch(() => undefined);
  }
  return persistNode;
}

function dangerCard(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  return card('Démonstration et remise à zéro',
    h('div', { class: 'row-wrap' },
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        const hasData = store.state.participants.length > 0 || store.state.events.length > 0;
        if (hasData && !(await confirmDialog({ title: 'Charger la démo ?', message: 'Vos données actuelles seront remplacées par l’équipe de démonstration (une sauvegarde de sécurité est créée avant).', confirmLabel: 'Charger la démo', danger: true }))) return;
        const demo = buildDemoState();
        await store.replaceWithBackup({ ...demo, meta: { ...demo.meta, deviceId: store.state.meta.deviceId } }, 'Avant chargement de la démo');
        invalidateBackups();
        toast('Équipe de démonstration chargée.', { kind: 'success' });
        ctx.refresh();
      } }, 'Charger l’équipe de démonstration'),
      h('button', { type: 'button', class: 'btn btn-danger-ghost', onclick: async () => {
        if (!(await confirmDialog({ title: 'Tout effacer ?', message: 'Toutes les données de cet appareil seront supprimées. Une sauvegarde de sécurité est créée avant : vous pourrez la restaurer.', confirmLabel: 'Tout effacer', danger: true }))) return;
        const fresh = createEmptyState();
        await store.replaceWithBackup({ ...fresh, meta: { ...fresh.meta, deviceId: store.state.meta.deviceId } }, 'Avant remise à zéro');
        invalidateBackups();
        toast('Données effacées. La sauvegarde de sécurité reste disponible ci-dessus.', { kind: 'success' });
        ctx.refresh();
      } }, 'Tout effacer')));
}
void replaceState;
