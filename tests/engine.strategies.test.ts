// filepath: tests/engine.strategies.test.ts
// Modes de répartition (équité / volontaires / mixte) et équité sur plusieurs événements.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Participant, SportEvent } from '../src/domain/types.ts';
import { solve } from '../src/engine/solver.ts';
import { computeHistory, doneEventsSorted } from '../src/engine/history.ts';
import { fairnessReport } from '../src/engine/fairness.ts';
import { ctx, driversOf, makeEvent, person, runSeason, strategyOf } from './fixtures.ts';

/** Équipe où la géographie est neutre : tout le monde habite Nantes, une voiture suffit chaque fois. */
function neutralTeam(spec: Array<[string, Parameters<typeof person>[1]]>): Participant[] {
  return spec.map(([id, s]) => person(id, { city: 'Nantes', ...s }));
}

function seasonEvents(ps: Participant[], count: number, dest = 'Angers'): SportEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent(`e${String(i + 1).padStart(2, '0')}`, dest, `2026-10-${String(i + 1).padStart(2, '0')}`, ps),
  );
}

function drivesByPerson(events: SportEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of doneEventsSorted(events)) for (const v of e.plan?.vehicles ?? []) out[v.driverId] = (out[v.driverId] ?? 0) + 1;
  return out;
}

describe('Mode 1 — équité absolue', () => {
  test('5 conducteurs possibles, 10 tournois : chacun conduit exactement 2 fois', () => {
    const ps = neutralTeam([
      ['A', { seats: 5 }], ['B', { seats: 5 }], ['C', { seats: 5 }], ['D', { seats: 5 }], ['E', { seats: 5 }],
      ['F', {}],
    ]);
    const events = runSeason(ps, seasonEvents(ps, 10), strategyOf('equity'));
    const drives = drivesByPerson(events);
    for (const id of ['A', 'B', 'C', 'D', 'E']) assert.equal(drives[id], 2, `${id} devrait conduire 2 fois, a conduit ${drives[id]}`);
    assert.equal(drives['F'], undefined);
  });

  test('ignore les préférences de volontariat (hors refus) : un volontaire ne conduit pas plus qu’un indifférent', () => {
    const ps = neutralTeam([
      ['A', { seats: 5, pref: 'priority' }], ['B', { seats: 5, pref: 'volunteer' }],
      ['C', { seats: 5, pref: 'indifferent' }], ['D', { seats: 5, pref: 'indifferent' }],
      ['E', {}],
    ]);
    const drives = drivesByPerson(runSeason(ps, seasonEvents(ps, 8), strategyOf('equity')));
    assert.deepEqual(Object.values(drives).sort(), [2, 2, 2, 2]);
  });

  test('tient compte de l’historique : celui qui a le moins conduit est choisi', () => {
    const ps = neutralTeam([['A', { seats: 5 }], ['B', { seats: 5 }], ['C', { seats: 5 }], ['F', {}]]);
    const past = runSeason(ps, seasonEvents(ps, 3), strategyOf('equity'));
    // Tout le monde a conduit une fois ; l'événement 4 doit repartir à zéro d'inégalité (peu importe qui).
    const e4 = makeEvent('e04', 'Angers', '2026-10-04', ps);
    const plan = solve(ctx(e4, ps, [...past, e4], strategyOf('equity')));
    assert.equal(plan.vehicles.length, 1);
    const h = computeHistory(ps, doneEventsSorted(past));
    assert.equal(h.get('A')?.timesDriver, 1);
    assert.equal(h.get('B')?.timesDriver, 1);
    assert.equal(h.get('C')?.timesDriver, 1);
  });

  test('la participation réelle compte : un absent ne « doit » rien', () => {
    const ps = neutralTeam([['A', { seats: 5 }], ['B', { seats: 5 }], ['C', { seats: 5 }], ['F', {}]]);
    // C est absent aux 4 premiers événements ; A et B conduisent à tour de rôle (2 chacun).
    const evs = seasonEvents(ps, 4).map((e) => ({
      ...e,
      attendance: e.attendance.map((a) => (a.participantId === 'C' ? { ...a, availability: 'no' as const } : a)),
    }));
    const past = runSeason(ps, evs, strategyOf('equity'));
    const drives = drivesByPerson(past);
    assert.equal(drives['C'], undefined);
    assert.equal(drives['A'], 2);
    assert.equal(drives['B'], 2);
    // C n'a rien à rattraper : ni dette ni crédit.
    const h = computeHistory(ps, doneEventsSorted(past));
    assert.equal(h.get('C')?.driveBalance, 0);
    assert.equal(h.get('C')?.eventsAttended, 0);
  });
});

describe('Mode 2 — priorité aux volontaires', () => {
  const team = (): Participant[] =>
    neutralTeam([
      ['P', { seats: 5, pref: 'priority' }],
      ['V1', { seats: 5, pref: 'volunteer' }],
      ['V2', { seats: 5, pref: 'volunteer' }],
      ['I1', { seats: 5, pref: 'indifferent' }],
      ['I2', { seats: 5, pref: 'indifferent' }],
      ['X', {}],
    ]);

  test('les indifférents ne sont jamais sollicités tant que des volontaires suffisent', () => {
    const ps = team();
    const drives = drivesByPerson(runSeason(ps, seasonEvents(ps, 9), strategyOf('volunteer')));
    assert.equal(drives['I1'], undefined);
    assert.equal(drives['I2'], undefined);
    assert.equal((drives['P'] ?? 0) + (drives['V1'] ?? 0) + (drives['V2'] ?? 0), 9);
  });

  test('on tourne entre volontaires : personne ne conduit systématiquement', () => {
    const ps = team();
    const drives = drivesByPerson(runSeason(ps, seasonEvents(ps, 12), strategyOf('volunteer')));
    for (const id of ['P', 'V1', 'V2']) {
      assert.ok((drives[id] ?? 0) >= 2, `${id} devrait conduire au moins 2 fois (a conduit ${drives[id] ?? 0})`);
      assert.ok((drives[id] ?? 0) <= 6, `${id} conduit trop souvent (${drives[id]})`);
    }
  });

  test('le prioritaire est sollicité en premier (premier événement sans historique)', () => {
    const ps = team();
    const plan = solve(ctx(makeEvent('e1', 'Angers', '2026-10-01', ps), ps, [], strategyOf('volunteer')));
    assert.deepEqual(driversOf(plan), ['P']);
  });

  test('si les volontaires ne suffisent pas, un indifférent est sollicité en complément (un seul)', () => {
    // 8 personnes : V (2 places) ne suffit pas ; il faut compléter par un indifférent (6 places).
    const ps = neutralTeam([
      ['V', { seats: 1, pref: 'volunteer' }],
      ['I1', { seats: 5, pref: 'indifferent' }],
      ['I2', { seats: 5, pref: 'indifferent' }],
      ['A', {}], ['B', {}], ['C', {}], ['D', {}], ['E', {}],
    ]);
    const plan = solve(ctx(makeEvent('e1', 'Angers', '2026-10-01', ps), ps, [], strategyOf('volunteer')));
    assert.equal(plan.status, 'ok');
    const drivers = driversOf(plan);
    assert.ok(drivers.includes('V'), 'le volontaire conduit en priorité');
    assert.equal(drivers.filter((d) => d.startsWith('I')).length, 1, 'un seul indifférent est sollicité');
  });

  test('conducteur prioritaire désigné par le responsable : favorisé sur un simple volontaire', () => {
    const ps = neutralTeam([
      ['V', { seats: 5, pref: 'volunteer' }],
      ['D', { seats: 5, pref: 'volunteer', priorityDriver: true }],
      ['X', {}],
    ]);
    const plan = solve(ctx(makeEvent('e1', 'Angers', '2026-10-01', ps), ps, [], strategyOf('volunteer')));
    assert.deepEqual(driversOf(plan), ['D']);
  });
});

describe('Mode 3 — mixte', () => {
  test('est le mode par défaut recommandé', () => {
    assert.equal(strategyOf('mixed').mode, 'mixed');
  });

  test('favorise les volontaires, mais un volontaire qui a beaucoup conduit perd sa priorité', () => {
    const ps = neutralTeam([
      ['V1', { seats: 5, pref: 'volunteer' }],
      ['V2', { seats: 5, pref: 'volunteer' }],
      ['I', { seats: 5, pref: 'indifferent' }],
      ['X', {}],
    ]);
    const drives = drivesByPerson(runSeason(ps, seasonEvents(ps, 12), strategyOf('mixed')));
    // Les volontaires conduisent davantage que l'indifférent…
    assert.ok((drives['V1'] ?? 0) + (drives['V2'] ?? 0) > (drives['I'] ?? 0));
    // …mais l'indifférent finit par conduire (les volontaires ne sont pas épuisés) :
    assert.ok((drives['I'] ?? 0) >= 1, 'l’indifférent devrait conduire quand les volontaires ont beaucoup conduit');
    // …et les deux volontaires se partagent la charge.
    assert.ok(Math.abs((drives['V1'] ?? 0) - (drives['V2'] ?? 0)) <= 1);
  });

  test('plus la dette de conduite est forte, plus la priorité chute (progressif)', () => {
    const ps = neutralTeam([
      ['V1', { seats: 5, pref: 'volunteer' }],
      ['V2', { seats: 5, pref: 'volunteer' }],
      ['X', {}],
    ]);
    // V1 a déjà conduit 3 fois seul : V2 doit être prioritaire.
    const past = runSeason([person('V1', { seats: 5, pref: 'volunteer', city: 'Nantes' }), person('X', { city: 'Nantes' })], seasonEvents(ps, 3), strategyOf('mixed'));
    const e4 = makeEvent('e04', 'Angers', '2026-10-04', ps);
    const plan = solve(ctx(e4, ps, [...past, e4], strategyOf('mixed')));
    assert.deepEqual(driversOf(plan), ['V2']);
  });

  test('limitation des trajets consécutifs : la série fait chuter la priorité', () => {
    const ps = neutralTeam([
      ['A', { seats: 5, pref: 'priority' }],
      ['B', { seats: 5, pref: 'volunteer' }],
      ['X', {}],
    ]);
    // Poids « consécutifs » à 10 et limite à 1 : A ne peut pas conduire 2 fois de suite.
    const strat = strategyOf('mixed', { maxConsecutive: 1 });
    strat.weights = { ...strat.weights, consecutive: 10, tripEquity: 0, distanceEquity: 0 };
    const events = runSeason(ps, seasonEvents(ps, 6), strat);
    const seq = doneEventsSorted(events).map((e) => e.plan?.vehicles[0]?.driverId);
    for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `série consécutive : ${seq.join(',')}`);
  });

  test('l’équité des distances est prise en compte (poids distance)', () => {
    // A et B peuvent conduire ; l'historique contient un long trajet de A.
    const ps = neutralTeam([['A', { seats: 5 }], ['B', { seats: 5 }], ['X', {}]]);
    const strat = strategyOf('equity');
    strat.weights = { ...strat.weights, tripEquity: 0, distanceEquity: 10 };
    const far = makeEvent('far', 'Paris', '2026-09-01', ps);
    const past = runSeason(ps, [far], strat);
    const near = makeEvent('near', 'Angers', '2026-09-08', ps);
    const plan = solve(ctx(near, ps, [...past, near], strat));
    const first = past[0]?.plan?.vehicles[0]?.driverId;
    assert.notEqual(driversOf(plan)[0], first, 'celui qui a fait le long trajet ne reconduit pas aussitôt');
  });
});

describe('Équité sur la durée : comparaison des modes', () => {
  test('en équité, l’écart de conduite reste ≤ 1 trajet ; en volontaires, les indifférents conduisent moins', () => {
    const ps = neutralTeam([
      ['A', { seats: 5, pref: 'priority' }], ['B', { seats: 5, pref: 'volunteer' }],
      ['C', { seats: 5, pref: 'volunteer' }], ['D', { seats: 5, pref: 'indifferent' }],
      ['E', { seats: 5, pref: 'indifferent' }], ['X', {}],
    ]);
    const evs = seasonEvents(ps, 10);
    const eq = drivesByPerson(runSeason(ps, evs, strategyOf('equity')));
    const vol = drivesByPerson(runSeason(ps, evs, strategyOf('volunteer')));
    const eqVals = ['A', 'B', 'C', 'D', 'E'].map((id) => eq[id] ?? 0);
    assert.ok(Math.max(...eqVals) - Math.min(...eqVals) <= 1, `équité : ${eqVals}`);
    const volIndiff = (vol['D'] ?? 0) + (vol['E'] ?? 0);
    const eqIndiff = (eq['D'] ?? 0) + (eq['E'] ?? 0);
    assert.ok(volIndiff < eqIndiff, `indifférents : volontaires=${volIndiff}, équité=${eqIndiff}`);
  });

  test('rapport d’équité : le score est maximal quand la charge est parfaitement partagée', () => {
    const ps = neutralTeam([['A', { seats: 5 }], ['B', { seats: 5 }], ['X', {}]]);
    const evs = runSeason(ps, seasonEvents(ps, 6), strategyOf('equity'));
    const h = computeHistory(ps, doneEventsSorted(evs));
    const r = fairnessReport(h, ['A', 'B']);
    assert.equal(r.score, 100);
    assert.equal(r.totalDrives, 6);
  });
});
