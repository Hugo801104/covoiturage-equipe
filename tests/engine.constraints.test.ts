// filepath: tests/engine.constraints.test.ts
// Contraintes dures : capacités, disponibilités, préférences/refus, situations impossibles.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStrategy } from '../src/domain/helpers.ts';
import { solve } from '../src/engine/solver.ts';
import { capacityOf, prepareProblem } from '../src/engine/problem.ts';
import { ctx, driversOf, makeEvent, person } from './fixtures.ts';

describe('capacités des véhicules', () => {
  test('le conducteur compte dans la capacité : 3 places passagers + conducteur = 4 occupants dans une seule voiture', () => {
    // Conducteur + 3 passagers = 4 occupants pour seats=3.
    const ps = [person('A', { seats: 3 }), person('B'), person('C'), person('D')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'ok');
    assert.equal(plan.vehicles.length, 1);
    assert.equal(plan.vehicles[0]?.passengerIds.length, 3);
  });

  test('un cinquième occupant impose une seconde voiture', () => {
    const ps = [person('A', { seats: 3 }), person('B', { seats: 2 }), person('C'), person('D'), person('E')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'ok');
    assert.ok(plan.vehicles.length >= 2);
  });

  test('aucun véhicule ne dépasse sa capacité (sur un scénario plus grand)', () => {
    const ps = [
      person('A', { seats: 4 }), person('B', { seats: 2 }), person('C', { seats: 3 }), person('D', { seats: 1 }),
      ...'EFGHIJKLM'.split('').map((c) => person(c)),
    ];
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps);
    const plan = solve(ctx(ev, ps));
    const problem = prepareProblem(ctx(ev, ps));
    for (const v of plan.vehicles) {
      assert.ok(v.passengerIds.length + 1 <= capacityOf(problem, v.driverId), `véhicule ${v.driverId} surchargé`);
    }
    assert.equal(plan.status, 'ok');
  });

  test('un participant n’est affecté qu’à un seul véhicule et tout le monde est placé', () => {
    const ps = [person('A', { seats: 3 }), person('B', { seats: 3 }), ...'CDEFG'.split('').map((c) => person(c))];
    const plan = solve(ctx(makeEvent('e', 'Rennes', '2026-11-01', ps), ps));
    const all = plan.vehicles.flatMap((v) => [v.driverId, ...v.passengerIds]);
    assert.equal(all.length, new Set(all).size);
    assert.equal(all.length, ps.length);
    assert.equal(plan.unassigned.length, 0);
  });

  test('seats = 0 : la voiture ne transporte personne et ne suffit pas à elle seule', () => {
    const ps = [person('A', { seats: 0 }), person('B')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'incomplete');
    assert.deepEqual(plan.unassigned.map((u) => u.participantId), ['B']);
  });

  test('capacité propre à l’événement (seatsOverride) prise en compte', () => {
    const ps = [person('A', { seats: 1 }), person('B'), person('C')];
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps);
    const att = ev.attendance.find((a) => a.participantId === 'A');
    if (att) att.seatsOverride = 2;
    const plan = solve(ctx(ev, ps));
    assert.equal(plan.status, 'ok');
    assert.equal(plan.vehicles.length, 1);
  });
});

describe('disponibilités', () => {
  test('un conducteur indisponible ne conduit jamais', () => {
    const ps = [person('A', { seats: 4 }), person('B', { seats: 4 }), person('C'), person('D')];
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps, { A: 'no' });
    const plan = solve(ctx(ev, ps));
    assert.ok(!driversOf(plan).includes('A'));
    assert.ok(!plan.vehicles.some((v) => v.passengerIds.includes('A')), 'A absent ne doit pas être passager');
    assert.equal(plan.status, 'ok');
  });

  test('« sans réponse » n’est pas traité comme disponible', () => {
    const ps = [person('A', { seats: 4 }), person('B', { seats: 4 }), person('C')];
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps, { B: 'unknown' });
    const plan = solve(ctx(ev, ps));
    assert.deepEqual(driversOf(plan), ['A']);
    assert.ok(!plan.attendeeIds.includes('B'));
  });

  test('transport autonome : compté comme présent mais pas placé', () => {
    const ps = [person('A', { seats: 3 }), person('B'), person('C')];
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps);
    const att = ev.attendance.find((a) => a.participantId === 'C');
    if (att) att.selfTransport = true;
    const plan = solve(ctx(ev, ps));
    assert.deepEqual(plan.selfTransportIds, ['C']);
    assert.ok(!plan.vehicles.some((v) => v.passengerIds.includes('C') || v.driverId === 'C'));
    assert.equal(plan.status, 'ok');
  });

  test('voiture non mise à disposition pour cet événement (carAvailableOverride=false)', () => {
    const ps = [person('A', { seats: 4 }), person('B', { seats: 4 }), person('C')];
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps);
    const att = ev.attendance.find((a) => a.participantId === 'A');
    if (att) att.carAvailableOverride = false;
    const plan = solve(ctx(ev, ps));
    assert.ok(!driversOf(plan).includes('A'));
  });

  test('lieu de départ modifié pour un événement : le regroupement suit le nouveau départ', () => {
    // 2 voitures de 2 places : A (Nantes) et B (Rennes). C et D habitent Nantes…
    const ps = [
      person('A', { seats: 1, city: 'Nantes' }),
      person('B', { seats: 1, city: 'Rennes' }),
      person('C', { city: 'Nantes' }),
      person('D', { city: 'Nantes' }),
    ];
    // …mais C part de Rennes pour cet événement : il doit monter avec B, et D avec A.
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps);
    const att = ev.attendance.find((a) => a.participantId === 'C');
    if (att) att.startOverride = { label: 'Rennes', address: '', lat: 48.1173, lng: -1.6778 };
    const plan = solve(ctx(ev, ps));
    assert.equal(plan.status, 'ok');
    assert.equal(plan.vehicles.length, 2);
    assert.deepEqual(plan.vehicles.find((v) => v.driverId === 'B')?.passengerIds, ['C']);
    assert.deepEqual(plan.vehicles.find((v) => v.driverId === 'A')?.passengerIds, ['D']);
  });
});

describe('préférences et refus de conduire', () => {
  test('capacité ≠ volonté : un propriétaire de voiture qui refuse ne conduit pas', () => {
    const ps = [person('A', { seats: 4, pref: 'refuse' }), person('B', { seats: 4, pref: 'volunteer' }), person('C'), person('D')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.deepEqual(driversOf(plan), ['B']);
  });

  test('neverDrive est une contrainte dure, même pour un volontaire', () => {
    const ps = [person('A', { seats: 4, pref: 'priority', neverDrive: true }), person('B', { seats: 4 }), person('C')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.ok(!driversOf(plan).includes('A'));
  });

  test('un refus n’est jamais violé, même si cela rend le plan incomplet', () => {
    const ps = [person('A', { seats: 4, pref: 'refuse' }), person('B'), person('C')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.vehicles.length, 0);
    assert.equal(plan.status, 'incomplete');
    assert.ok(plan.issues.some((i) => i.code === 'NO_DRIVER_AVAILABLE'));
    // …et l’application propose de demander à A (qui refuse mais a une voiture).
    assert.ok(plan.suggestions.some((s) => s.includes('A Test')));
  });

  test('« préfère être passager » ne conduit qu’en dernier recours', () => {
    const ps = [
      person('A', { seats: 3, pref: 'prefer_passenger', lastResort: true }),
      person('B', { seats: 3, pref: 'indifferent' }),
      person('C'), person('D'),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.deepEqual(driversOf(plan), ['B']);
  });

  test('…mais conduit si c’est nécessaire et accepté (dernier recours)', () => {
    const ps = [
      person('A', { seats: 3, pref: 'prefer_passenger', lastResort: true }),
      person('B', { seats: 1, pref: 'indifferent' }),
      person('C'), person('D'), person('E'),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'ok');
    assert.ok(driversOf(plan).includes('A'));
    assert.ok(plan.issues.some((i) => i.code === 'LAST_RESORT_DRIVER'));
  });

  test('…et ne conduit pas s’il n’a pas accepté le dernier recours', () => {
    const ps = [
      person('A', { seats: 3, pref: 'prefer_passenger', lastResort: false }),
      person('B', { seats: 1 }),
      person('C'), person('D'), person('E'),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.ok(!driversOf(plan).includes('A'));
    assert.equal(plan.status, 'incomplete');
  });
});

describe('situations impossibles', () => {
  test('places insuffisantes : détecté, nombre exact de places manquantes, non affectés, pistes', () => {
    // 8 personnes ; A (4 places avec conducteur) + B (3 places) = 7 → 1 place manquante.
    const ps = [
      person('A', { seats: 3 }), person('B', { seats: 2 }),
      person('C'), person('D'), person('E'), person('F'), person('G'), person('H'),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'incomplete');
    const issue = plan.issues.find((i) => i.code === 'INSUFFICIENT_SEATS');
    assert.ok(issue, 'INSUFFICIENT_SEATS attendu');
    assert.match(issue.message, /1 place\(s\) manquante\(s\)/);
    assert.equal(plan.unassigned.length, 1);
    assert.ok(plan.unassigned[0]?.reason.length);
    assert.ok(plan.suggestions.some((s) => s.includes('véhicule supplémentaire')));
    // Tout ce qui est placé respecte les capacités.
    const placed = plan.vehicles.flatMap((v) => [v.driverId, ...v.passengerIds]);
    assert.equal(placed.length, 7);
  });

  test('personne ne conduit : aucun plan silencieux', () => {
    const ps = [person('A'), person('B'), person('C')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'incomplete');
    assert.equal(plan.unassigned.length, 3);
    assert.ok(plan.issues.some((i) => i.severity === 'error'));
  });

  test('suggestions : propriétaire de voiture indisponible', () => {
    const ps = [person('A', { seats: 1 }), person('B', { seats: 4 }), person('C'), person('D')];
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps, { B: 'no' });
    const plan = solve(ctx(ev, ps));
    assert.equal(plan.status, 'incomplete');
    assert.ok(plan.suggestions.some((s) => s.includes('B Test')));
  });

  test('aucun participant : plan vide valide', () => {
    const ev = makeEvent('e', 'Angers', '2026-11-01', []);
    const plan = solve(ctx(ev, []));
    assert.equal(plan.status, 'ok');
    assert.equal(plan.vehicles.length, 0);
  });

  test('coordonnées manquantes : avertissement explicite, pas de plan trompeur', () => {
    const ps = [person('A', { seats: 3 }), person('B')];
    const b = ps[1];
    if (b) b.home = { label: 'Inconnu', address: '', lat: null, lng: null };
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'ok');
    assert.ok(plan.issues.some((i) => i.code === 'MISSING_COORDS' && i.participantIds.includes('B')));
  });

  test('le moteur ne prétend jamais produire un temps de trajet routier', () => {
    const ps = [person('A', { seats: 3 }), person('B')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.metrics.distanceKind, 'straight_line');
    assert.ok(!('durationMin' in plan.metrics));
    assert.equal(defaultStrategy('mixed').mode, 'mixed');
  });
});
