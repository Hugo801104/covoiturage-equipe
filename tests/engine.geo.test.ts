// filepath: tests/engine.geo.test.ts
// Calcul géographique local et optimisation des regroupements.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDistanceMatrix, haversineKm, straightLineProvider } from '../src/engine/geo.ts';
import type { DistanceProvider } from '../src/engine/geo.ts';
import { bestRoute, routeKmOfOrder } from '../src/engine/routing.ts';
import { solve } from '../src/engine/solver.ts';
import { ctx, coords, makeEvent, person } from './fixtures.ts';

describe('géométrie à vol d’oiseau', () => {
  test('haversine : Nantes–Angers ≈ 80 km, symétrique, nul sur place', () => {
    const d = haversineKm(coords('Nantes'), coords('Angers'));
    assert.ok(d > 77 && d < 84, `distance ${d}`);
    assert.equal(haversineKm(coords('Nantes'), coords('Nantes')), 0);
    assert.ok(Math.abs(haversineKm(coords('Nantes'), coords('Paris')) - haversineKm(coords('Paris'), coords('Nantes'))) < 1e-9);
  });

  test('fournisseur de distances substituable (architecture ouverte aux routes hors ligne)', () => {
    const roads: DistanceProvider = { name: 'Table routière', kind: 'road', distanceKm: (a, b) => haversineKm(a, b) * 1.3 };
    const pts = [coords('Nantes'), coords('Angers')];
    const m1 = buildDistanceMatrix(pts, straightLineProvider);
    const m2 = buildDistanceMatrix(pts, roads);
    assert.ok(Math.abs(m2.get(0, 1) / m1.get(0, 1) - 1.3) < 1e-9);
    assert.equal(m1.kind, 'straight_line');
    assert.equal(m2.kind, 'road');
    // Le plan expose l'origine des distances (jamais confondue avec un temps de trajet).
    const ps = [person('A', { seats: 3 }), person('B')];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps, undefined, undefined, { distance: roads }));
    assert.equal(plan.metrics.distanceKind, 'road');
  });

  test('nœud sans coordonnées : distance de repli, signalé comme non localisé', () => {
    const m = buildDistanceMatrix([coords('Nantes'), null, coords('Angers')], straightLineProvider);
    assert.deepEqual(m.unlocated, [1]);
    assert.ok(m.get(0, 1) > 0);
  });
});

describe('ordre de récupération', () => {
  test('exact : égal à la force brute sur des instances aléatoires', () => {
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 30; trial++) {
      const n = 2 + Math.floor(rnd() * 5);
      const pts = Array.from({ length: n + 2 }, () => ({ lat: 47 + rnd(), lng: -2 + rnd() * 2 }));
      const m = buildDistanceMatrix(pts, straightLineProvider);
      const stops = Array.from({ length: n }, (_, i) => i + 1);
      const best = bestRoute(m, 0, stops, n + 1);
      // Force brute
      let min = Infinity;
      const permute = (arr: number[], cur: number[]): void => {
        if (arr.length === 0) {
          min = Math.min(min, routeKmOfOrder(m, 0, cur, n + 1));
          return;
        }
        arr.forEach((x, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)], [...cur, x]));
      };
      permute(stops, []);
      assert.ok(Math.abs(best.km - min) < 1e-6, `essai ${trial} : ${best.km} vs ${min}`);
    }
  });

  test('plus de 10 arrêts : heuristique, ordre valide et pas pire que l’ordre d’entrée', () => {
    const pts = Array.from({ length: 14 }, (_, i) => ({ lat: 47 + Math.sin(i * 1.7) * 0.5, lng: -2 + Math.cos(i * 2.3) * 0.5 }));
    const m = buildDistanceMatrix(pts, straightLineProvider);
    const stops = Array.from({ length: 12 }, (_, i) => i + 1);
    const r = bestRoute(m, 0, stops, 13);
    assert.deepEqual([...r.order].sort((a, b) => a - b), stops);
    assert.ok(r.km <= routeKmOfOrder(m, 0, stops, 13) + 1e-9);
  });

  test('récupère d’abord le passager le plus éloigné de la destination, puis ceux sur la route', () => {
    // Départ Nantes, destination Angers : Les Sorinières (sud) avant Carquefou (nord-est, sur la route).
    const ps = [
      person('D', { seats: 3, city: 'Nantes' }),
      person('S', { city: 'Les Sorinières' }),
      person('C', { city: 'Carquefou' }),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.deepEqual(plan.vehicles[0]?.passengerIds, ['S', 'C']);
  });
});

describe('optimisation géographique', () => {
  test('exemple du cahier des charges : conducteur de Rezé → Angers, passagers de Nantes, Vertou, Saint-Sébastien', () => {
    const ps = [
      person('Conducteur', { seats: 3, city: 'Rezé' }),
      person('Nantes', { city: 'Nantes' }),
      person('Vertou', { city: 'Vertou' }),
      person('StSeb', { city: 'Saint-Sébastien-sur-Loire' }),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'ok');
    assert.equal(plan.vehicles.length, 1, 'une seule voiture suffit');
    const v = plan.vehicles[0];
    assert.equal(v?.driverId, 'Conducteur');
    assert.equal(v?.passengerIds.length, 3);
    const vm = plan.metrics.vehicles[0];
    assert.ok(vm && vm.detourKm < 25, `détour ${vm?.detourKm} km`);
    // Gain par rapport à 4 voitures séparées
    assert.ok(plan.metrics.totalKm < plan.metrics.soloKm / 2);
  });

  test('deux grappes géographiques : chaque passager rejoint le conducteur de sa grappe', () => {
    const ps = [
      person('A', { seats: 3, city: 'Saint-Nazaire' }),
      person('A1', { city: 'Montoir-de-Bretagne' }),
      person('A2', { city: 'Savenay' }),
      person('A3', { city: 'La Baule-Escoublac' }),
      person('B', { seats: 3, city: 'Rennes' }),
      person('B1', { city: 'Redon' }),
      person('B2', { city: 'Saint-Malo' }),
      person('B3', { city: 'Rennes' }),
    ];
    const plan = solve(ctx(makeEvent('e', 'Paris', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'ok');
    assert.equal(plan.vehicles.length, 2);
    const a = plan.vehicles.find((v) => v.driverId === 'A');
    const b = plan.vehicles.find((v) => v.driverId === 'B');
    assert.deepEqual([...(a?.passengerIds ?? [])].sort(), ['A1', 'A2', 'A3']);
    assert.deepEqual([...(b?.passengerIds ?? [])].sort(), ['B1', 'B2', 'B3']);
  });

  test('limite le nombre de véhicules : 4 personnes proches → une seule voiture', () => {
    const ps = [
      person('A', { seats: 3, city: 'Nantes' }),
      person('B', { seats: 3, city: 'Rezé' }),
      person('C', { city: 'Vertou' }),
      person('D', { city: 'Saint-Herblain' }),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.vehicles.length, 1);
  });

  test('à priorité égale, choisit le conducteur qui minimise les kilomètres', () => {
    // Destination Angers. D1 (Carquefou) est sur la route, D2 (Les Sorinières) est à l'opposé.
    const ps = [
      person('D1', { seats: 3, city: 'Carquefou' }),
      person('D2', { seats: 3, city: 'Les Sorinières' }),
      person('P1', { city: 'Nantes' }),
      person('P2', { city: 'Nantes' }),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.vehicles.length, 1);
    // Soit D1 ou D2 conduit : on vérifie que c'est bien celui qui donne le moins de km.
    const km = plan.metrics.totalKm;
    const alt = solve(ctx(makeEvent('e2', 'Angers', '2026-11-01', ps), ps, undefined, undefined, { locks: { drivers: [plan.vehicles[0]?.driverId === 'D1' ? 'D2' : 'D1'], assignments: {} } }));
    assert.ok(km <= alt.metrics.totalKm + 1e-6, `${km} > ${alt.metrics.totalKm}`);
  });

  test('deux conducteurs proches partent chacun avec leurs passagers plutôt que de multiplier les détours', () => {
    const ps = [
      person('A', { seats: 2, city: 'Rezé' }),
      person('B', { seats: 2, city: 'Vertou' }),
      person('A1', { city: 'Rezé' }),
      person('A2', { city: 'Bouguenais' }),
      person('B1', { city: 'Vertou' }),
      person('B2', { city: 'Basse-Goulaine' }),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'ok');
    assert.equal(plan.vehicles.length, 2);
    const a = plan.vehicles.find((v) => v.driverId === 'A');
    const b = plan.vehicles.find((v) => v.driverId === 'B');
    assert.deepEqual([...(a?.passengerIds ?? [])].sort(), ['A1', 'A2']);
    assert.deepEqual([...(b?.passengerIds ?? [])].sort(), ['B1', 'B2']);
  });

  test('un détour excédentaire est signalé (avertissement) sans bloquer le plan', () => {
    const ps = [
      person('A', { seats: 3, city: 'Nantes' }),
      person('Far', { city: 'La Roche-sur-Yon' }),
    ];
    const plan = solve(ctx(makeEvent('e', 'Angers', '2026-11-01', ps), ps));
    assert.equal(plan.status, 'ok');
    assert.ok(plan.issues.some((i) => i.code === 'LONG_DETOUR'));
  });

  test('résultat déterministe pour une même graine', () => {
    const ps = [
      person('A', { seats: 3, city: 'Rezé' }), person('B', { seats: 3, city: 'Vertou' }), person('C', { seats: 3, city: 'Orvault' }),
      ...['Nantes', 'Carquefou', 'Couëron', 'Sautron', 'Bouguenais', 'Clisson'].map((c, i) => person(`P${i}`, { city: c })),
    ];
    const ev = makeEvent('e', 'Angers', '2026-11-01', ps);
    const p1 = solve(ctx(ev, ps));
    const p2 = solve(ctx(ev, ps));
    assert.deepEqual(p1.vehicles, p2.vehicles);
  });
});
