// filepath: tests/data.test.ts
// Couche données : export/import JSON, validation, migrations, fusion sans écrasement, store, stockage.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../src/domain/types.ts';
import { createParticipant, createEvent, createAttendance } from '../src/domain/helpers.ts';
import { buildDemoState } from '../src/data/demo.ts';
import { CURRENT_SCHEMA_VERSION, createEmptyState, serializeExport } from '../src/data/schema.ts';
import { migrateData, parseImportText } from '../src/data/migrate.ts';
import { validateAppState } from '../src/data/validate.ts';
import {
  analyzeImport,
  applyImport,
  defaultResolutions,
  diffKey,
  newestResolutions,
  replaceAll,
  stableStringify,
} from '../src/data/merge.ts';
import * as A from '../src/data/actions.ts';
import { Store } from '../src/data/store.ts';
import { LocalStorageStorage, MAX_BACKUPS, MemoryStorage } from '../src/data/storage.ts';
import type { KeyValueStore, StorageAdapter } from '../src/data/storage.ts';

const demo = buildDemoState();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('export / import JSON', () => {
  test('aller-retour complet sans perte (24 participants, 9 événements, plans et historique)', () => {
    const text = serializeExport(demo);
    const res = parseImportText(text);
    assert.ok(res.ok, res.ok ? '' : res.errors.map((e) => e.message).join('; '));
    assert.equal(stableStringify(res.state.participants), stableStringify(demo.participants));
    assert.equal(stableStringify(res.state.events), stableStringify(demo.events));
    assert.equal(res.state.team.name, demo.team.name);
    assert.equal(res.fromVersion, CURRENT_SCHEMA_VERSION);
  });

  test('l’enveloppe contient format, version, date d’export et version de l’application', () => {
    const f = JSON.parse(serializeExport(demo)) as Record<string, unknown>;
    assert.equal(f['format'], 'covoiturage-equipe');
    assert.equal(f['schemaVersion'], CURRENT_SCHEMA_VERSION);
    assert.ok(typeof f['exportedAt'] === 'string' && !Number.isNaN(Date.parse(f['exportedAt'] as string)));
    assert.ok(typeof f['appVersion'] === 'string');
  });

  test('accepte aussi un état brut (sans enveloppe)', () => {
    assert.ok(parseImportText(JSON.stringify(demo)).ok);
  });
});

describe('validation des fichiers importés', () => {
  const reject = (text: string, expected: RegExp): void => {
    const res = parseImportText(text);
    assert.ok(!res.ok, 'devrait être refusé');
    if (!res.ok) assert.ok(res.errors.some((e) => expected.test(e.message) || expected.test(e.path)), res.errors.map((e) => e.message).join(' | '));
  };
  const mutated = (fn: (s: AppState) => void): string => {
    const s = clone(demo);
    fn(s);
    return serializeExport(s);
  };

  test('JSON invalide', () => reject('{ pas du json', /JSON/));
  test('tableau au lieu d’un objet', () => reject('[1,2]', /objet/));
  test('mauvais identifiant de format', () => reject(JSON.stringify({ format: 'autre', schemaVersion: 1, data: {} }), /format inconnu/));
  test('fichier quelconque', () => reject(JSON.stringify({ hello: 'world' }), /non reconnu/));
  test('version de format plus récente que l’application', () => {
    const f = JSON.parse(serializeExport(demo)) as Record<string, unknown>;
    f['schemaVersion'] = CURRENT_SCHEMA_VERSION + 1;
    reject(JSON.stringify(f), /plus récente/);
  });
  test('énumération invalide (préférence de conduite)', () =>
    reject(mutated((s) => { (s.participants[0] as unknown as Record<string, unknown>)['drivingPreference'] = 'jamais'; }), /valeur invalide/));
  test('latitude hors plage', () =>
    reject(mutated((s) => { (s.participants[0] as { home: { lat: number | null } }).home.lat = 123; }), /entre -90 et 90/));
  test('nombre de places négatif ou non entier', () => {
    reject(mutated((s) => { (s.participants[0] as { seats: number }).seats = -1; }), /≥ 0/);
    reject(mutated((s) => { (s.participants[0] as { seats: number }).seats = 2.5; }), /entier/);
  });
  test('identifiants en double', () =>
    reject(mutated((s) => { (s.participants[1] as { id: string }).id = (s.participants[0] as { id: string }).id; }), /double/));
  test('date d’événement invalide', () =>
    reject(mutated((s) => { (s.events[0] as { date: string }).date = '12/09/2026'; }), /date invalide/));
  test('heure invalide', () =>
    reject(mutated((s) => { (s.events[0] as { departureTime: string }).departureTime = '25:99'; }), /heure invalide/));
  test('type erroné (booléen attendu)', () =>
    reject(mutated((s) => { (s.participants[0] as unknown as Record<string, unknown>)['hasCar'] = 'oui'; }), /vrai ou faux/));
  test('champ obligatoire manquant', () =>
    reject(mutated((s) => { delete (s.participants[0] as unknown as Record<string, unknown>)['id']; }), /obligatoire/));
  test('texte démesuré', () =>
    reject(mutated((s) => { (s.participants[0] as { notes: string }).notes = 'x'.repeat(6000); }), /trop long/));

  test('champs inconnus supprimés (aucune pollution de l’état)', () => {
    const s = clone(demo) as unknown as { participants: Array<Record<string, unknown>> };
    (s.participants[0] as Record<string, unknown>)['__proto_pollution'] = { evil: true };
    const res = validateAppState(s);
    assert.ok(res.ok);
    assert.ok(!('__proto_pollution' in (res.value?.participants[0] ?? {})));
  });

  test('références inconnues : avertissement (pas d’erreur), disponibilités orphelines ignorées', () => {
    const s = clone(demo);
    (s.events[0] as { attendance: unknown[] }).attendance.push({ participantId: 'fantome', availability: 'yes', selfTransport: false, startOverride: null, seatsOverride: null, carAvailableOverride: null, note: '' });
    const res = validateAppState(s);
    assert.ok(res.ok);
    assert.ok(res.warnings.some((w) => /inconnu/.test(w.message)));
    assert.ok(!res.value?.events[0]?.attendance.some((a) => a.participantId === 'fantome'));
  });

  test('un fichier invalide ne modifie jamais l’état existant (analyse seule)', () => {
    const before = stableStringify(demo);
    parseImportText('pas du json');
    assert.equal(stableStringify(demo), before);
  });
});

describe('versions du format et migrations', () => {
  test('migration en chaîne v1 → v3 avec registre injecté', () => {
    const registry = {
      1: (d: Record<string, unknown>) => ({ ...d, etape1: true }),
      2: (d: Record<string, unknown>) => ({ ...d, etape2: true }),
    };
    const r = migrateData({ participants: [] }, 1, registry, 3);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.data['etape1'], true);
      assert.equal(r.data['etape2'], true);
      assert.equal(r.data['schemaVersion'], 3);
    }
  });
  test('migration manquante : refus explicite', () => {
    const r = migrateData({}, 1, {}, 3);
    assert.ok(!r.ok);
  });
  test('version future refusée', () => {
    const r = migrateData({}, 9, {}, 1);
    assert.ok(!r.ok);
    if (!r.ok) assert.match(r.error, /plus récente/);
  });
  test('échec d’une migration : rapporté, sans exception', () => {
    const r = migrateData({}, 1, { 1: () => { throw new Error('boum'); } }, 2);
    assert.ok(!r.ok);
    if (!r.ok) assert.match(r.error, /boum/);
  });
  test('version déjà courante : inchangée', () => {
    const r = migrateData({ a: 1 }, CURRENT_SCHEMA_VERSION);
    assert.ok(r.ok);
  });
});

describe('import sans écrasement silencieux', () => {
  const base = (): AppState => clone(demo);

  test('participant nouveau dans le fichier : ajouté ; conflit : local conservé par défaut', () => {
    const local = base();
    const incoming = base();
    incoming.participants.push(createParticipant({ id: 'p_new', firstName: 'Nouveau', lastName: 'Venu' }));
    (incoming.participants[0] as { notes: string }).notes = 'modifié ailleurs';
    (incoming.participants[0] as { updatedAt: string }).updatedAt = '2030-01-01T00:00:00.000Z';

    const analysis = analyzeImport(local, incoming);
    assert.equal(analysis.counts.added, 1);
    assert.equal(analysis.counts.conflicts, 1);
    const conflict = analysis.participants.find((d) => d.status === 'conflict');
    assert.deepEqual(conflict?.changedFields, ['notes']);
    assert.equal(conflict?.newer, 'remote');

    const merged = applyImport(local, incoming, defaultResolutions(analysis));
    assert.equal(merged.participants.find((p) => p.id === 'p_new')?.firstName, 'Nouveau');
    assert.equal(merged.participants[0]?.notes, local.participants[0]?.notes, 'la version locale n’est PAS écrasée par défaut');
  });

  test('résolution « prendre le fichier » appliquée seulement sur demande explicite', () => {
    const local = base();
    const incoming = base();
    (incoming.participants[2] as { seats: number }).seats = 6;
    const analysis = analyzeImport(local, incoming);
    const key = diffKey({ kind: 'participant', id: (incoming.participants[2] as { id: string }).id });
    const merged = applyImport(local, incoming, { ...defaultResolutions(analysis), [key]: 'remote' });
    assert.equal(merged.participants[2]?.seats, 6);
  });

  test('« le plus récent gagne » : choisit la copie la plus récente conflit par conflit', () => {
    const local = base();
    const incoming = base();
    (local.participants[0] as { notes: string }).notes = 'local récent';
    (local.participants[0] as { updatedAt: string }).updatedAt = '2031-01-01T00:00:00.000Z';
    (incoming.participants[1] as { notes: string }).notes = 'distant récent';
    (incoming.participants[1] as { updatedAt: string }).updatedAt = '2032-01-01T00:00:00.000Z';
    const analysis = analyzeImport(local, incoming);
    const merged = applyImport(local, incoming, newestResolutions(analysis));
    assert.equal(merged.participants[0]?.notes, 'local récent');
    assert.equal(merged.participants[1]?.notes, 'distant récent');
  });

  test('un import ne supprime rien : les entités seulement locales sont conservées', () => {
    const local = base();
    const incoming = base();
    incoming.participants = incoming.participants.slice(0, 5);
    incoming.events = incoming.events.slice(0, 2);
    const analysis = analyzeImport(local, incoming);
    assert.ok(analysis.counts.localOnly > 0);
    const merged = applyImport(local, incoming, defaultResolutions(analysis));
    assert.equal(merged.participants.length, local.participants.length);
    assert.equal(merged.events.length, local.events.length);
  });

  test('suppression propagée comme conflit (tombstone), jamais appliquée silencieusement', () => {
    const local = base();
    const incoming = base();
    const victim = incoming.participants[3] as { id: string; deletedAt: string | null; updatedAt: string };
    victim.deletedAt = '2030-05-05T00:00:00.000Z';
    victim.updatedAt = '2030-05-05T00:00:00.000Z';
    const analysis = analyzeImport(local, incoming);
    const d = analysis.participants.find((x) => x.id === victim.id);
    assert.equal(d?.status, 'conflict');
    assert.ok(d?.remoteDeleted);
    assert.ok(d?.changedFields.includes('deletedAt'));
    const keep = applyImport(local, incoming, defaultResolutions(analysis));
    assert.equal(keep.participants.find((p) => p.id === victim.id)?.deletedAt, null);
    const take = applyImport(local, incoming, { ...defaultResolutions(analysis), [diffKey(d as { kind: 'participant'; id: string })]: 'remote' });
    assert.ok(take.participants.find((p) => p.id === victim.id)?.deletedAt);
  });

  test('entité supprimée dans le fichier et absente en local : ignorée', () => {
    const local = base();
    const incoming = base();
    incoming.participants.push(createParticipant({ id: 'p_ghost', firstName: 'Fantôme', deletedAt: '2030-01-01T00:00:00.000Z' }));
    const analysis = analyzeImport(local, incoming);
    assert.equal(analysis.counts.ignored, 1);
    const merged = applyImport(local, incoming, defaultResolutions(analysis));
    assert.ok(!merged.participants.some((p) => p.id === 'p_ghost'));
  });

  test('conflit sur un événement (organisation différente) détecté champ par champ', () => {
    const local = base();
    const incoming = base();
    const ev = incoming.events.find((e) => e.id === 'e_demo_7') as { plan: unknown; constraints: string };
    ev.constraints = 'Prévoir les maillots';
    const analysis = analyzeImport(local, incoming);
    const d = analysis.events.find((x) => x.id === 'e_demo_7');
    assert.equal(d?.status, 'conflict');
    assert.deepEqual(d?.changedFields, ['constraints']);
  });

  test('fichiers identiques : aucun conflit, rien d’ajouté', () => {
    const analysis = analyzeImport(base(), base());
    assert.equal(analysis.counts.conflicts, 0);
    assert.equal(analysis.counts.added, 0);
    assert.equal(analysis.teamNameDiffers, false);
  });

  test('scénario multi-appareils : modifier sur un autre appareil puis réimporter', () => {
    // Appareil A exporte ; appareil B ajoute une personne et change un événement ; A réimporte.
    const a = base();
    const exported = serializeExport(a);
    const b = (parseImportText(exported) as { ok: true; state: AppState }).state;
    const withNew = A.upsertParticipant(createParticipant({ id: 'p_b', firstName: 'Ajouté', lastName: 'Sur B' }))(b);
    const edited = A.upsertEvent({ ...(withNew.events[6] as AppState['events'][number]), constraints: 'RDV 7h devant le gymnase' })(withNew);
    const back = parseImportText(serializeExport(edited));
    assert.ok(back.ok);
    if (!back.ok) return;
    const analysis = analyzeImport(a, back.state);
    assert.equal(analysis.counts.added, 1);
    // Les 3 événements à venir reçoivent la ligne « sans réponse » du nouveau participant.
    assert.equal(analysis.counts.conflicts, 3);
    const merged = applyImport(a, back.state, newestResolutions(analysis));
    assert.ok(merged.participants.some((p) => p.id === 'p_b'));
    assert.equal(merged.events[6]?.constraints, 'RDV 7h devant le gymnase');
    assert.ok(validateAppState(merged).ok, 'l’état fusionné reste valide');
  });

  test('remplacer tout : conserve l’identité de l’appareil local', () => {
    const local = base();
    const incoming = base();
    incoming.meta.deviceId = 'dev_autre';
    const replaced = replaceAll(local, incoming);
    assert.equal(replaced.meta.deviceId, local.meta.deviceId);
  });
});

describe('démo déterministe', () => {
  test('deux chargements de la démo ne créent aucun conflit à l’import', () => {
    const a = buildDemoState();
    const b = buildDemoState();
    const analysis = analyzeImport(a, b);
    assert.equal(analysis.counts.conflicts, 0);
    assert.equal(analysis.counts.added, 0);
  });
});

describe('actions pures', () => {
  test('nouveau participant : ajouté « sans réponse » aux événements à venir, pas aux passés', () => {
    const s = A.upsertParticipant(createParticipant({ id: 'p_x', firstName: 'X' }))(clone(demo));
    const upcoming = s.events.find((e) => e.id === 'e_demo_7');
    const past = s.events.find((e) => e.id === 'e_demo_1');
    assert.equal(upcoming?.attendance.find((a) => a.participantId === 'p_x')?.availability, 'unknown');
    assert.ok(!past?.attendance.some((a) => a.participantId === 'p_x'));
  });

  test('suppression logique : le participant reste dans l’historique', () => {
    const s = A.deleteParticipant('p_demo_01')(clone(demo));
    assert.equal(A.activeParticipants(s).length, demo.participants.length - 1);
    assert.equal(s.participants.length, demo.participants.length);
    assert.ok(s.events[0]?.plan?.vehicles.length);
  });

  test('terminer un événement exige un plan ; la modification met à jour updatedAt', () => {
    const s0 = clone(demo);
    const s1 = A.completeEvent('e_demo_7')(s0);
    assert.equal(s1.events.find((e) => e.id === 'e_demo_7')?.status, 'planned');
    const s2 = A.upsertEvent({ ...(s0.events.find((e) => e.id === 'e_demo_7') as AppState['events'][number]), name: 'Renommé' }, '2040-01-01T00:00:00.000Z')(s0);
    assert.equal(s2.events.find((e) => e.id === 'e_demo_7')?.updatedAt, '2040-01-01T00:00:00.000Z');
  });

  test('les événements à venir et passés sont correctement classés', () => {
    assert.deepEqual(A.upcomingEvents(demo, '2026-11-06').map((e) => e.id), ['e_demo_7', 'e_demo_8', 'e_demo_9']);
    assert.equal(A.pastEvents(demo, '2026-11-06').length, 6);
  });

  test('createAttendance / createEvent produisent des objets valides', () => {
    const s = createEmptyState();
    s.participants.push(createParticipant({ id: 'p1', firstName: 'A' }));
    s.events.push(createEvent({ id: 'e1', name: 'T', attendance: [createAttendance('p1', 'yes')] }));
    assert.ok(validateAppState(s).ok);
  });
});

function fakeKv(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
  };
}

const adapters: Array<[string, () => StorageAdapter]> = [
  ['MemoryStorage', () => new MemoryStorage()],
  ['LocalStorageStorage', () => new LocalStorageStorage(fakeKv())],
];

for (const [name, make] of adapters) {
  describe(`stockage et store — ${name}`, () => {
    test('persistance entre deux ouvertures de l’application', async () => {
      const storage = make();
      const store = await Store.open(storage, { autosaveDelayMs: 0 });
      assert.ok(store.isNew);
      store.dispatch(A.upsertParticipant(createParticipant({ id: 'p1', firstName: 'Ana', lastName: 'Lyse' })));
      await store.flush();
      assert.equal(store.saveStatus, 'saved');
      const reopened = await Store.open(storage, { autosaveDelayMs: 0 });
      assert.ok(!reopened.isNew);
      assert.equal(reopened.state.participants[0]?.firstName, 'Ana');
    });

    test('sauvegarde automatique avec regroupement (debounce) : une seule écriture pour plusieurs changements', async () => {
      const storage = make();
      let saves = 0;
      const original = storage.save.bind(storage);
      storage.save = async (s) => { saves++; await original(s); };
      const store = await Store.open(storage, { autosaveDelayMs: 20 });
      for (let i = 0; i < 5; i++) store.dispatch(A.upsertParticipant(createParticipant({ id: `p${i}`, firstName: `N${i}` })));
      assert.equal(store.saveStatus, 'saving');
      await new Promise((r) => setTimeout(r, 60));
      await store.flush();
      assert.equal(saves, 1);
      assert.equal(store.saveStatus, 'saved');
    });

    test('annulation (undo)', async () => {
      const store = await Store.open(make(), { autosaveDelayMs: 0 });
      store.dispatch(A.upsertParticipant(createParticipant({ id: 'p1', firstName: 'A' })));
      assert.equal(store.state.participants.length, 1);
      assert.ok(store.undo());
      assert.equal(store.state.participants.length, 0);
      assert.ok(!store.undo());
    });

    test('sauvegardes : création, liste, restauration, purge au-delà de la limite', async () => {
      const storage = make();
      const store = await Store.open(storage, { autosaveDelayMs: 0 });
      store.dispatch(A.replaceState(clone(demo)));
      for (let i = 0; i < MAX_BACKUPS + 3; i++) await store.backupNow(`Sauvegarde ${i}`);
      const list = await storage.listBackups();
      assert.equal(list.length, MAX_BACKUPS);
      const restored = await storage.loadBackup((list[0] as { id: string }).id);
      assert.equal(restored?.participants.length, demo.participants.length);
      assert.ok((list[0] as { participants: number }).participants === 24);
    });

    test('sauvegarde automatique périodique : créée si la dernière est trop ancienne', async () => {
      const storage = make();
      const seed = clone(demo);
      seed.meta.lastBackupAt = '2020-01-01T00:00:00.000Z';
      await storage.save(seed);
      const store = await Store.open(storage, { autosaveDelayMs: 0 });
      assert.equal((await storage.listBackups()).length, 1);
      assert.ok(store.startupNotice?.includes('sauvegarde automatique'));
      const again = await Store.open(storage, { autosaveDelayMs: 0 });
      assert.equal((await storage.listBackups()).length, 1, 'pas de nouvelle sauvegarde le jour même');
      assert.equal(again.startupNotice, null);
    });

    test('import « tout remplacer » : sauvegarde de sécurité créée d’abord', async () => {
      const storage = make();
      const store = await Store.open(storage, { autosaveDelayMs: 0 });
      store.dispatch(A.upsertParticipant(createParticipant({ id: 'p1', firstName: 'Avant' })));
      await store.replaceWithBackup(clone(demo), 'Avant import');
      assert.equal(store.state.participants.length, 24);
      const backups = await storage.listBackups();
      assert.equal(backups[0]?.label, 'Avant import');
      assert.equal((await storage.loadBackup((backups[0] as { id: string }).id))?.participants[0]?.firstName, 'Avant');
    });
  });
}

describe('données stockées corrompues', () => {
  test('LocalStorage : copie brute conservée, aucun écrasement, message à l’utilisateur', async () => {
    const kv = fakeKv();
    const storage = new LocalStorageStorage(kv);
    kv.setItem('covoiturage:state', JSON.stringify({ schemaVersion: 1, participants: 'cassé', events: [] }));
    const store = await Store.open(storage, { autosaveDelayMs: 0 });
    assert.ok(store.isNew);
    assert.match(store.startupNotice ?? '', /illisibles/);
    const raw = await storage.loadCorruptedRaw();
    assert.ok(raw && raw.includes('cassé'));
    store.dispatch(A.upsertParticipant(createParticipant({ id: 'p1', firstName: 'Nouveau' })));
    await store.flush();
    assert.ok((await storage.loadCorruptedRaw())?.includes('cassé'), 'la copie brute survit aux sauvegardes suivantes');
  });

  test('JSON non analysable dans le stockage : même protection', async () => {
    const kv = fakeKv();
    kv.setItem('covoiturage:state', '{pas du json');
    const storage = new LocalStorageStorage(kv);
    const store = await Store.open(storage, { autosaveDelayMs: 0 });
    assert.ok(store.isNew);
    assert.equal(await storage.loadCorruptedRaw(), '{pas du json');
  });
});
