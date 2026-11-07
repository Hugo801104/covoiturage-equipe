// filepath: tests/scenario.test.ts
// Scénarios réalistes : 24 participants, voitures de capacités différentes, 6 événements successifs,
// comparaison des trois modes ; et test de performance avec 60 participants.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Participant, SportEvent, StrategyMode } from '../src/domain/types.ts';
import { buildDemoState } from '../src/data/demo.ts';
import { computeHistory, doneEventsSorted } from '../src/engine/history.ts';
import { fairnessReport } from '../src/engine/fairness.ts';
import { capacityOf, prepareProblem } from '../src/engine/problem.ts';
import { solve } from '../src/engine/solver.ts';
import { GAZETTEER } from '../src/domain/gazetteer.ts';
import { ctx, makeEvent, person, runSeason, strategyOf } from './fixtures.ts';

const demo = buildDemoState();
const pastIds = ['e_demo_1', 'e_demo_2', 'e_demo_3', 'e_demo_4', 'e_demo_5', 'e_demo_6'];
const pastEvents: SportEvent[] = demo.events
  .filter((e) => pastIds.includes(e.id))
  .map((e) => ({ ...e, plan: null, status: 'planned' as const }));

interface SeasonStats {
  events: SportEvent[];
  imbalance: number;
  spread: number;
  driveShareWanting: number;
  indifferentDrives: number;
  lastResortDrives: number;
  refusingDrives: number;
  totalDrives: number;
}

function season(mode: StrategyMode): SeasonStats {
  const events = runSeason(demo.participants, pastEvents, strategyOf(mode), 3);
  const hist = computeHistory(demo.participants, doneEventsSorted(events));
  const byId = new Map(demo.participants.map((p) => [p.id, p]));
  const regular = demo.participants
    .filter((p) => p.hasCar && p.carAvailable && !p.neverDrive && p.drivingPreference !== 'refuse' && p.drivingPreference !== 'prefer_passenger')
    .map((p) => p.id);
  const report = fairnessReport(hist, regular);
  let wanting = 0;
  let indiff = 0;
  let last = 0;
  let refusing = 0;
  let total = 0;
  for (const [id, h] of hist) {
    const p = byId.get(id) as Participant;
    total += h.timesDriver;
    if (p.drivingPreference === 'priority' || p.drivingPreference === 'volunteer') wanting += h.timesDriver;
    else if (p.drivingPreference === 'indifferent') indiff += h.timesDriver;
    else if (p.drivingPreference === 'prefer_passenger') last += h.timesDriver;
    if (p.drivingPreference === 'refuse' || p.neverDrive) refusing += h.timesDriver;
  }
  return {
    events,
    imbalance: report.imbalance,
    spread: report.spread,
    driveShareWanting: total > 0 ? wanting / total : 0,
    indifferentDrives: indiff,
    lastResortDrives: last,
    refusingDrives: refusing,
    totalDrives: total,
  };
}

describe('scénario réaliste : équipe de 24 personnes, 6 événements successifs', () => {
  const results = {
    equity: season('equity'),
    volunteer: season('volunteer'),
    mixed: season('mixed'),
  };

  test('taille du scénario : ≥ 20 participants, capacités variées, plusieurs conducteurs possibles', () => {
    assert.ok(demo.participants.length >= 20);
    const seats = new Set(demo.participants.filter((p) => p.hasCar).map((p) => p.seats));
    assert.ok(seats.size >= 4, `capacités distinctes : ${[...seats]}`);
    assert.ok(demo.participants.filter((p) => p.hasCar).length >= 10);
    assert.equal(pastEvents.length, 6);
  });

  for (const mode of ['equity', 'volunteer', 'mixed'] as const) {
    test(`[${mode}] toutes les organisations sont complètes et respectent capacités et refus`, () => {
      for (const e of results[mode].events) {
        const plan = e.plan;
        assert.ok(plan);
        assert.equal(plan.status, 'ok', `${e.name} : ${plan.issues.map((i) => i.message).join(' | ')}`);
        assert.equal(plan.unassigned.length, 0);
        const problem = prepareProblem(ctx(e, demo.participants, results[mode].events));
        const seen = new Set<string>();
        for (const v of plan.vehicles) {
          assert.ok(v.passengerIds.length + 1 <= capacityOf(problem, v.driverId));
          for (const id of [v.driverId, ...v.passengerIds]) {
            assert.ok(!seen.has(id), `${id} affecté deux fois`);
            seen.add(id);
          }
        }
        const present = e.attendance.filter((a) => a.availability === 'yes').length;
        assert.equal(seen.size, present, 'tous les présents ont une place');
      }
      assert.equal(results[mode].refusingDrives, 0, 'un refus de conduire a été violé');
      assert.equal(results[mode].lastResortDrives, 0, 'le dernier recours ne doit pas servir quand ce n’est pas nécessaire');
    });
  }

  test('le mode équité répartit effectivement la conduite (écart le plus faible)', () => {
    const { equity, volunteer, mixed } = results;
    assert.ok(equity.imbalance < volunteer.imbalance, `équité ${equity.imbalance} vs volontaires ${volunteer.imbalance}`);
    assert.ok(equity.imbalance <= mixed.imbalance + 1e-9, `équité ${equity.imbalance} vs mixte ${mixed.imbalance}`);
    assert.ok(equity.imbalance < 0.75, `écart trop élevé en équité : ${equity.imbalance}`);
    assert.ok(equity.spread <= 2.5, `amplitude trop élevée en équité : ${equity.spread}`);
  });

  test('le mode volontariat donne bien la priorité aux personnes qui souhaitent conduire', () => {
    const { equity, volunteer, mixed } = results;
    assert.equal(volunteer.indifferentDrives, 0, 'aucun indifférent ne devrait conduire : les volontaires suffisent');
    assert.equal(volunteer.driveShareWanting, 1);
    assert.ok(volunteer.driveShareWanting > equity.driveShareWanting);
    // Le mixte favorise aussi les volontaires, mais moins strictement.
    assert.ok(mixed.driveShareWanting >= equity.driveShareWanting - 1e-9);
    assert.ok(mixed.driveShareWanting <= volunteer.driveShareWanting + 1e-9);
  });

  test('le mixte se place entre l’équité absolue et le volontariat pur', () => {
    const { equity, volunteer, mixed } = results;
    assert.ok(mixed.imbalance < volunteer.imbalance);
    assert.ok(mixed.imbalance >= equity.imbalance - 1e-9);
  });

  test('le covoiturage réduit nettement les kilomètres par rapport à des trajets individuels', () => {
    for (const e of results.mixed.events) {
      const m = e.plan?.metrics;
      assert.ok(m && m.totalKm < m.soloKm * 0.5, `${e.name} : ${m?.totalKm} km vs ${m?.soloKm} km seuls`);
    }
  });

  test('événement à venir sur les données de démonstration : plan complet à partir de l’historique', () => {
    const next = demo.events.find((e) => e.id === 'e_demo_7') as SportEvent;
    const plan = solve(ctx(next, demo.participants, demo.events, demo.settings.strategy));
    assert.equal(plan.status, 'ok');
    // « Sans réponse » (6 et 17) et absent (10) ne sont pas dans les voitures.
    const placed = plan.vehicles.flatMap((v) => [v.driverId, ...v.passengerIds]);
    assert.ok(!placed.includes('p_demo_10'));
    assert.ok(!placed.includes('p_demo_06'));
    assert.ok(!placed.includes('p_demo_17'));
  });

  test('l’historique des données de démonstration contient 6 événements terminés cohérents', () => {
    const done = doneEventsSorted(demo.events);
    assert.equal(done.length, 6);
    assert.ok(done.every((e) => e.plan?.status === 'ok'));
  });
});

describe('performance', () => {
  test('60 participants, 28 voitures : calcul en moins de 5 secondes', () => {
    const ps: Participant[] = [];
    for (let i = 0; i < 60; i++) {
      const g = GAZETTEER[i % 33];
      assert.ok(g);
      ps.push(
        person(`P${String(i).padStart(2, '0')}`, {
          city: g.name,
          seats: i % 2 === 0 ? 3 + (i % 4) : undefined,
          pref: (['priority', 'volunteer', 'indifferent', 'indifferent'] as const)[i % 4],
        }),
      );
    }
    const ev = makeEvent('big', 'Angers', '2026-11-01', ps);
    const t0 = performance.now();
    const plan = solve(ctx(ev, ps));
    const ms = performance.now() - t0;
    assert.equal(plan.status, 'ok');
    assert.ok(ms < 5000, `trop lent : ${Math.round(ms)} ms`);
  });
});
