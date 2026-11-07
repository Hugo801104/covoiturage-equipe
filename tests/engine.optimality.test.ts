// filepath: tests/engine.optimality.test.ts
// Qualité du solveur : comparaison à l'optimum exact (énumération de tous les ensembles de conducteurs)
// sur de petites instances aléatoires reproductibles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAZETTEER } from '../src/domain/gazetteer.ts';
import { prepareProblem } from '../src/engine/problem.ts';
import { createSolverState, solve } from '../src/engine/solver.ts';
import { ctx, makeEvent, person } from './fixtures.ts';

test('le solveur retrouve l’ensemble de conducteurs optimal sur 30 instances aléatoires', () => {
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  let checked = 0;
  for (let t = 0; t < 30; t++) {
    const nPeople = 10 + Math.floor(rnd() * 8);
    const nCars = 5 + Math.floor(rnd() * 4);
    const people = [];
    for (let i = 0; i < nPeople; i++) {
      const g = GAZETTEER[Math.floor(rnd() * 33)];
      assert.ok(g);
      people.push(
        person(`P${String(i).padStart(2, '0')}`, {
          city: g.name,
          seats: i < nCars ? 1 + Math.floor(rnd() * 4) : undefined,
          pref: (['priority', 'volunteer', 'indifferent'] as const)[Math.floor(rnd() * 3)],
        }),
      );
    }
    const dest = (['Angers', 'Rennes', 'Cholet', 'Le Mans'] as const)[Math.floor(rnd() * 4)] as string;
    const event = makeEvent(`opt${t}`, dest, '2026-11-01', people);
    const c = ctx(event, people);
    const plan = solve(c);
    if (plan.status !== 'ok') continue;

    const state = createSolverState(prepareProblem(c));
    let best = Number.POSITIVE_INFINITY;
    for (let mask = 1; mask < 1 << state.free.length; mask++) {
      const set = state.free.filter((_, i) => mask & (1 << i));
      const ev = state.evaluate(set, 'regret', true);
      if (ev && ev.leftover.length === 0 && ev.total < best) best = ev.total;
    }
    const got = plan.alternatives[0]?.score ?? Number.POSITIVE_INFINITY;
    assert.ok(got <= best * 1.001 + 1e-6, `instance ${t} : solveur ${got.toFixed(1)} vs optimum ${best.toFixed(1)}`);
    checked++;
  }
  assert.ok(checked >= 20, `seulement ${checked} instances faisables vérifiées`);
});
