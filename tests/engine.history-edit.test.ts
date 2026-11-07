// filepath: tests/engine.history-edit.test.ts
// Historique, correction manuelle d'événements terminés, édition de plans, explications.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Participant, Plan, SportEvent } from '../src/domain/types.ts';
import { computeHistory, doneEventsSorted } from '../src/engine/history.ts';
import {
  EditError,
  addVehicle,
  excludeParticipant,
  includeParticipant,
  lockAll,
  movePassenger,
  recompute,
  removeVehicle,
  reorderStops,
  setDriver,
} from '../src/engine/plan-edit.ts';
import { comparePlans, explainPlan } from '../src/engine/explain.ts';
import { solve } from '../src/engine/solver.ts';
import { ctx, driversOf, makeEvent, person, runSeason, strategyOf } from './fixtures.ts';

function team(): Participant[] {
  return [
    person('A', { seats: 3, city: 'Rezé', pref: 'volunteer' }),
    person('B', { seats: 3, city: 'Vertou', pref: 'volunteer' }),
    person('R', { seats: 3, city: 'Nantes', pref: 'refuse' }),
    person('N', { city: 'Nantes' }), // sans voiture
    person('C', { city: 'Carquefou' }),
    person('D', { city: 'Orvault' }),
    person('E', { city: 'Saint-Herblain' }),
  ];
}

function planFor(ps: Participant[]): { event: SportEvent; plan: Plan } {
  const event = makeEvent('ev', 'Angers', '2026-11-01', ps);
  return { event, plan: solve(ctx(event, ps)) };
}

describe('historique', () => {
  const ps = team();
  const events = runSeason(
    ps,
    ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22'].map((d, i) => makeEvent(`h${i}`, i % 2 ? 'Rennes' : 'Angers', d, ps)),
    strategyOf('mixed'),
  );
  const hist = computeHistory(ps, doneEventsSorted(events));

  test('conducteur + passager = participation réelle', () => {
    for (const p of ps) {
      const h = hist.get(p.id);
      assert.ok(h);
      assert.equal(h.timesDriver + h.timesPassenger + h.timesSelfTransport, h.eventsAttended, p.id);
    }
  });

  test('kilomètres conducteur = somme des longueurs d’itinéraire des plans', () => {
    const total = [...hist.values()].reduce((s, h) => s + h.kmDriver, 0);
    const fromPlans = events.reduce((s, e) => s + (e.plan?.metrics.totalKm ?? 0), 0);
    assert.ok(Math.abs(total - fromPlans) < 1e-6);
  });

  test('chaque trajet conduit est un trajet de moins à répartir : le total des dettes est nul', () => {
    const sum = [...hist.values()].reduce((s, h) => s + h.driveBalance, 0);
    assert.ok(Math.abs(sum) < 1e-9, `somme des dettes = ${sum}`);
  });

  test('kilomètres passager renseignés et « avec qui » enregistré', () => {
    const passengers = [...hist.values()].filter((h) => h.timesPassenger > 0);
    assert.ok(passengers.length > 0);
    assert.ok(passengers.every((h) => h.kmPassenger > 0));
    assert.ok(Object.keys(hist.get('N')?.rodeWith ?? {}).length > 0);
  });

  test('correction manuelle d’un événement terminé : les statistiques suivent la réalité', () => {
    const target = events[0] as SportEvent;
    const plan = target.plan as Plan;
    const original = plan.vehicles[0]?.driverId as string;
    const newDriver = ['A', 'B'].find((d) => d !== original) as string;
    const before = computeHistory(ps, doneEventsSorted(events));

    // Dans la réalité, c'est l'autre qui a conduit : on corrige le plan de l'événement terminé.
    const vehicle = plan.vehicles.find((v) => v.driverId === original);
    assert.ok(vehicle);
    const alreadyDriving = plan.vehicles.some((v) => v.driverId === newDriver);
    const edited = alreadyDriving
      ? plan // les deux conduisaient déjà ce jour-là : le scénario ne s'applique pas
      : setDriver(ctx(target, ps, events), plan, vehicle.id, newDriver);
    if (!alreadyDriving) {
      const fixed = events.map((e) => (e.id === target.id ? { ...e, plan: edited } : e));
      const after = computeHistory(ps, doneEventsSorted(fixed));
      assert.equal((after.get(original)?.timesDriver ?? 0), (before.get(original)?.timesDriver ?? 0) - 1);
      assert.equal((after.get(newDriver)?.timesDriver ?? 0), (before.get(newDriver)?.timesDriver ?? 0) + 1);
      assert.equal((after.get(original)?.timesPassenger ?? 0), (before.get(original)?.timesPassenger ?? 0) + 1);
    }
  });

  test('un événement non terminé ne compte pas dans l’historique', () => {
    const planned = events.map((e, i) => (i === 0 ? { ...e, status: 'planned' as const } : e));
    const h = computeHistory(ps, doneEventsSorted(planned));
    const total = [...h.values()].reduce((s, x) => s + x.timesDriver, 0);
    const expected = planned.filter((e) => e.status === 'done').reduce((s, e) => s + (e.plan?.vehicles.length ?? 0), 0);
    assert.equal(total, expected);
  });
});

describe('modifications manuelles : contraintes revérifiées', () => {
  test('déplacer un passager vers une voiture pleine → plan invalide (capacité) et explicite', () => {
    const ps = [
      person('A', { seats: 1, city: 'Rezé' }), person('B', { seats: 1, city: 'Vertou' }),
      person('N1', { city: 'Nantes' }), person('N2', { city: 'Nantes' }),
    ];
    const { event, plan } = planFor(ps);
    assert.equal(plan.vehicles.length, 2);
    const full = plan.vehicles[0];
    const other = plan.vehicles[1];
    assert.ok(full && other);
    const mover = other.passengerIds[0] as string;
    const edited = movePassenger(ctx(event, ps), plan, mover, full.id);
    assert.equal(edited.status, 'invalid');
    assert.ok(edited.issues.some((i) => i.code === 'OVER_CAPACITY'));
    assert.equal(edited.source, 'manual');
  });

  test('un participant ne peut pas être affecté à deux véhicules (déplacer = retirer de l’ancien)', () => {
    const ps = team();
    const { event, plan } = planFor(ps);
    const first = plan.vehicles[0];
    assert.ok(first);
    const pid = first.passengerIds[0];
    if (!pid) return;
    const target = plan.vehicles.find((v) => v.id !== first.id);
    if (!target) return;
    const edited = movePassenger(ctx(event, ps), plan, pid, target.id);
    const all = edited.vehicles.flatMap((v) => [v.driverId, ...v.passengerIds]);
    assert.equal(all.length, new Set(all).size);
  });

  test('changer de conducteur vers quelqu’un qui refuse de conduire → erreur DRIVER_REFUSES', () => {
    const ps = team();
    const { event, plan } = planFor(ps);
    const v = plan.vehicles[0];
    assert.ok(v);
    const edited = setDriver(ctx(event, ps), plan, v.id, 'R');
    assert.ok(edited.issues.some((i) => i.code === 'DRIVER_REFUSES'));
    assert.equal(edited.status, 'invalid');
  });

  test('changer de conducteur vers quelqu’un sans voiture → erreur DRIVER_NO_CAR', () => {
    const ps = team();
    const { event, plan } = planFor(ps);
    const v = plan.vehicles[0];
    assert.ok(v);
    const edited = setDriver(ctx(event, ps), plan, v.id, 'N');
    assert.ok(edited.issues.some((i) => i.code === 'DRIVER_NO_CAR'));
  });

  test('changer de conducteur : l’ancien conducteur devient passager', () => {
    const ps = [person('A', { seats: 3 }), person('B', { seats: 3 }), person('C')];
    const { event, plan } = planFor(ps);
    const v = plan.vehicles[0];
    assert.ok(v);
    const old = v.driverId;
    const next = old === 'A' ? 'B' : 'A';
    const edited = setDriver(ctx(event, ps), plan, v.id, next);
    const nv = edited.vehicles[0];
    assert.equal(nv?.driverId, next);
    assert.ok(nv?.passengerIds.includes(old));
    assert.equal(edited.status, 'ok');
  });

  test('conduire deux véhicules est refusé', () => {
    const ps = [person('A', { seats: 1, city: 'Rezé' }), person('B', { seats: 1, city: 'Vertou' }), person('C', { city: 'Nantes' }), person('D', { city: 'Nantes' })];
    const { event, plan } = planFor(ps);
    assert.equal(plan.vehicles.length, 2);
    const [v1, v2] = plan.vehicles;
    assert.ok(v1 && v2);
    assert.throws(() => setDriver(ctx(event, ps), plan, v1.id, v2.driverId), EditError);
    assert.throws(() => addVehicle(ctx(event, ps), plan, v1.driverId), EditError);
  });

  test('exclure un participant : retiré des véhicules, pas compté comme non affecté ; réintégrable', () => {
    const ps = team();
    const { event, plan } = planFor(ps);
    const pid = plan.vehicles.flatMap((v) => v.passengerIds)[0] as string;
    const ex = excludeParticipant(ctx(event, ps), plan, pid);
    assert.ok(ex.excluded.includes(pid));
    assert.ok(!ex.vehicles.some((v) => v.passengerIds.includes(pid)));
    assert.ok(!ex.unassigned.some((u) => u.participantId === pid));
    assert.equal(ex.status, 'ok');
    const back = includeParticipant(ctx(event, ps), ex, pid);
    assert.ok(back.unassigned.some((u) => u.participantId === pid));
    assert.equal(back.status, 'incomplete');
  });

  test('supprimer un véhicule : ses occupants redeviennent non affectés (plan incomplet, jamais silencieux)', () => {
    const ps = [person('A', { seats: 1, city: 'Rezé' }), person('B', { seats: 1, city: 'Vertou' }), person('C', { city: 'Nantes' }), person('D', { city: 'Nantes' })];
    const { event, plan } = planFor(ps);
    const v = plan.vehicles[0];
    assert.ok(v);
    const edited = removeVehicle(ctx(event, ps), plan, v.id);
    assert.equal(edited.vehicles.length, 1);
    assert.equal(edited.status, 'incomplete');
    assert.ok(edited.unassigned.length >= 1);
  });

  test('ajouter un véhicule', () => {
    const ps = [person('A', { seats: 3 }), person('B', { seats: 3 }), person('C')];
    const { event, plan } = planFor(ps);
    const spare = plan.vehicles[0]?.driverId === 'A' ? 'B' : 'A';
    const edited = addVehicle(ctx(event, ps), plan, spare);
    assert.equal(edited.vehicles.length, 2);
    assert.ok(edited.locks.drivers.includes(spare));
  });

  test('réordonner les points de récupération : recalcule les distances ; refuse un ordre incohérent', () => {
    const ps = [person('D', { seats: 3, city: 'Nantes' }), person('S', { city: 'Les Sorinières' }), person('C', { city: 'Carquefou' })];
    const { event, plan } = planFor(ps);
    const v = plan.vehicles[0];
    assert.ok(v);
    assert.deepEqual(v.passengerIds, ['S', 'C']);
    const reversed = reorderStops(ctx(event, ps), plan, v.id, ['C', 'S']);
    assert.deepEqual(reversed.vehicles[0]?.passengerIds, ['C', 'S']);
    assert.ok(reversed.metrics.totalKm > plan.metrics.totalKm, 'un mauvais ordre allonge le trajet');
    assert.throws(() => reorderStops(ctx(event, ps), plan, v.id, ['C']), EditError);
  });

  test('un conducteur déplacé comme passager est refusé', () => {
    const ps = [person('A', { seats: 3 }), person('B', { seats: 3 }), person('C')];
    const { event, plan } = planFor(ps);
    const v = plan.vehicles[0];
    assert.ok(v);
    assert.throws(() => movePassenger(ctx(event, ps), plan, v.driverId, null), EditError);
  });
});

describe('recalcul sans perdre les modifications validées', () => {
  const ps = [
    person('A', { seats: 3, city: 'Rezé', pref: 'volunteer' }),
    person('B', { seats: 3, city: 'Vertou', pref: 'volunteer' }),
    person('C', { seats: 3, city: 'Orvault', pref: 'volunteer' }),
    ...['Nantes', 'Carquefou', 'Saint-Herblain', 'Couëron'].map((c, i) => person(`P${i}`, { city: c })),
  ];
  // 7 personnes, voitures de 4 places : 2 voitures suffisent, la 3e est disponible mais non nécessaire.
  const event = makeEvent('ev', 'Angers', '2026-11-01', ps);

  test('conducteur imposé conservé au recalcul, supprimé si on demande « tout recalculer »', () => {
    const base = solve(ctx(event, ps));
    const unlikely = ['A', 'B', 'C'].find((d) => !driversOf(base).includes(d));
    assert.ok(unlikely, 'un des trois conducteurs possibles ne conduit pas');
    const forced = addVehicle(ctx(event, ps), base, unlikely);
    const kept = recompute(ctx(event, ps), lockAll(ctx(event, ps), forced), true);
    assert.ok(driversOf(kept).includes(unlikely), 'le conducteur imposé reste');
    const fresh = recompute(ctx(event, ps), lockAll(ctx(event, ps), forced), false);
    assert.deepEqual(driversOf(fresh), driversOf(base));
  });

  test('affectation imposée conservée', () => {
    const base = solve(ctx(event, ps));
    const [v1, v2] = base.vehicles;
    assert.ok(v1 && v2, 'deux voitures attendues');
    assert.ok(v1.passengerIds.length > 0 && v2.passengerIds.length + 1 < 4, 'place disponible dans la 2e voiture');
    const pid = v1.passengerIds[0] as string;
    const moved = movePassenger(ctx(event, ps), base, pid, v2.id);
    const again = recompute(ctx(event, ps), lockAll(ctx(event, ps), moved), true);
    const holder = again.vehicles.find((v) => v.passengerIds.includes(pid));
    assert.equal(holder?.driverId, v2.driverId);
  });

  test('exclusion conservée au recalcul', () => {
    const base = solve(ctx(event, ps));
    const pid = base.vehicles.flatMap((v) => v.passengerIds)[0] as string;
    const ex = excludeParticipant(ctx(event, ps), base, pid);
    const again = recompute(ctx(event, ps), ex, true);
    assert.ok(again.excluded.includes(pid));
    assert.ok(!again.vehicles.some((v) => v.passengerIds.includes(pid) || v.driverId === pid));
  });
});

describe('explications', () => {
  // Trois conducteurs possibles (A, B, T) pour 8 personnes : deux voitures suffisent, un candidat n'est pas retenu.
  const ps = [...team(), person('T', { seats: 3, city: 'Nantes', pref: 'indifferent' })];
  const events = runSeason(ps, [makeEvent('h1', 'Angers', '2026-10-01', ps)], strategyOf('mixed'));
  const event = makeEvent('now', 'Rennes', '2026-11-01', ps);
  const c = ctx(event, ps, [...events, event]);
  const plan = solve(c);
  const explanations = explainPlan(c, plan);

  test('une explication par conducteur, par passager, plus synthèse et équité', () => {
    assert.ok(explanations.some((e) => e.kind === 'summary'));
    assert.ok(explanations.some((e) => e.kind === 'fairness'));
    for (const v of plan.vehicles) {
      assert.ok(explanations.some((e) => e.kind === 'driver' && e.subjectId === v.driverId), `conducteur ${v.driverId}`);
      for (const p of v.passengerIds) assert.ok(explanations.some((e) => e.kind === 'passenger' && e.subjectId === p), `passager ${p}`);
    }
  });

  test('explique pourquoi tel conducteur n’a PAS été retenu, avec un contre-exemple chiffré', () => {
    const unchosen = explanations.filter((e) => e.kind === 'unchosen');
    assert.ok(unchosen.length >= 1);
    assert.ok(unchosen.every((e) => e.text.length > 20 && e.details.length >= 1));
    assert.ok(unchosen.some((e) => /km/.test(e.text) || e.details.some((d) => /km/.test(d))));
  });

  test('l’explication d’un conducteur cite son historique et son itinéraire', () => {
    const d = explanations.find((e) => e.kind === 'driver');
    assert.ok(d);
    const joined = d.details.join(' ');
    assert.match(joined, /Préférence/);
    assert.match(joined, /Itinéraire/);
    assert.match(joined, /A conduit|Aucun historique/);
  });

  test('rappelle que les distances sont à vol d’oiseau', () => {
    assert.ok(explanations[0]?.details.some((d) => /vol d’oiseau/.test(d)));
  });

  test('comparaison de deux organisations : désigne la plus équitable', () => {
    const [v1] = plan.vehicles;
    assert.ok(v1);
    const other = ['A', 'B'].find((d) => !driversOf(plan).includes(d));
    if (!other) return;
    const altPlan = setDriver(c, plan, v1.id, other);
    const lines = comparePlans(c, plan, altPlan, 'Proposition', 'Variante');
    assert.ok(lines.length >= 2);
    assert.match(lines[0] as string, /équitable/);
  });

  test('plan modifié manuellement : l’explication le signale', () => {
    const [v1] = plan.vehicles;
    assert.ok(v1);
    const other = ['A', 'B'].find((d) => !driversOf(plan).includes(d));
    if (!other) return;
    const altPlan = setDriver(c, plan, v1.id, other);
    const ex = explainPlan(c, altPlan);
    assert.ok(ex[0]?.details.some((d) => /modifiée manuellement/.test(d)));
    assert.ok(ex.some((e) => e.kind === 'driver' && /imposé manuellement/.test(e.text)));
  });
});
