// filepath: src/engine/explain.ts
// Explications en français de l'organisation proposée : le moteur n'est pas une boîte noire.
// Toutes les phrases s'appuient sur des chiffres réellement calculés (scores, km, dette de conduite),
// y compris des contre-exemples (« si X conduisait à la place de Y, ce serait … »).

import type { Plan, StrategyMode } from '../domain/types.ts';
import { DRIVING_PREFERENCE_LABELS, STRATEGY_LABELS } from '../domain/helpers.ts';
import { fairnessReport, projectedImbalance } from './fairness.ts';
import { computeHistory, historyEventsFor } from './history.ts';
import { capacityOf, findDriverCandidates, nameOf, prepareProblem } from './problem.ts';
import type { PlanContext, Problem } from './problem.ts';
import { createSolverState } from './solver.ts';
import type { Evaluation } from './solver.ts';
import type { DriverScore } from './scoring.ts';

export interface Explanation {
  id: string;
  kind: 'summary' | 'driver' | 'passenger' | 'unchosen' | 'fairness';
  subjectId: string | null;
  vehicleId: string | null;
  title: string;
  text: string;
  details: string[];
}

export const fmt = (x: number, digits = 1): string => {
  const f = 10 ** digits;
  return String(Math.round(x * f) / f).replace('.', ',');
};

const signed = (x: number, digits = 1): string => `${x >= 0 ? '+' : '−'}${fmt(Math.abs(x), digits)}`;

function placeLabelOf(problem: Problem, id: string): string {
  const att = problem.attendance.get(id);
  const p = problem.participants.get(id);
  const place = att?.startOverride && att.startOverride.label ? att.startOverride : p?.home;
  return place?.label || place?.address || 'lieu non renseigné';
}

/** Phrase décrivant ce qui distingue deux scores de conducteurs (la plus grosse composante). */
function scoreDifference(a: DriverScore, b: DriverScore, problem: Problem): string {
  const diffs: Array<{ label: string; delta: number }> = [
    { label: 'préférence de conduite', delta: a.parts.preference + a.parts.priorityBonus - b.parts.preference - b.parts.priorityBonus },
    { label: 'nombre de trajets déjà conduits', delta: a.parts.tripFairness - b.parts.tripFairness },
    { label: 'distances déjà conduites', delta: a.parts.distanceFairness - b.parts.distanceFairness },
    { label: 'trajets consécutifs', delta: a.parts.streak - b.parts.streak },
    { label: 'dernier recours', delta: a.parts.lastResort - b.parts.lastResort },
  ];
  diffs.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const top = diffs[0];
  void problem;
  if (!top || Math.abs(top.delta) < 1e-6) return 'priorités quasi identiques (départage reproductible)';
  return `écart principal : ${top.label}`;
}

export function explainPlan(ctx: PlanContext, plan: Plan): Explanation[] {
  const problem = prepareProblem({ ...ctx, strategy: plan.strategy, locks: plan.locks, excluded: plan.excluded });
  const state = createSolverState(problem);
  const out: Explanation[] = [];
  const mode: StrategyMode = plan.strategy.mode;
  const manual = plan.source === 'manual';
  const m = problem.matrix;

  // ── Synthèse ──
  const n = problem.carpoolIds.length;
  const metrics = plan.metrics;
  const saved = metrics.soloKm - metrics.totalKm;
  out.push({
    id: 'summary',
    kind: 'summary',
    subjectId: null,
    vehicleId: null,
    title: 'Vue d’ensemble',
    text:
      `${plan.vehicles.length} voiture(s) pour ${n} personne(s) en covoiturage, stratégie « ${STRATEGY_LABELS[mode].short} ». ` +
      `Distance totale estimée à vol d’oiseau : ${fmt(metrics.totalKm)} km` +
      (metrics.soloKm > 0 ? ` (contre ${fmt(metrics.soloKm)} km si chacun venait seul, soit ${signed(-saved)} km).` : '.'),
    details: [
      'Les distances sont calculées à vol d’oiseau : ce sont des estimations, pas des distances ni des temps de trajet routiers.',
      ...(manual ? ['Cette organisation a été modifiée manuellement ; les explications ci-dessous décrivent l’état actuel.'] : []),
    ],
  });

  // ── Conducteurs ──
  const candidates = [...state.fixed, ...state.free];
  const ranked = [...candidates].sort(
    (a, b) => (state.scores.get(a)?.total ?? 0) - (state.scores.get(b)?.total ?? 0),
  );
  for (const v of plan.vehicles) {
    const id = v.driverId;
    const score = state.scores.get(id);
    const vm = metrics.vehicles.find((x) => x.vehicleId === v.id);
    const h = problem.history.get(id);
    const details: string[] = [];
    const prof = problem.participants.get(id);

    if (prof) details.push(`Préférence : ${DRIVING_PREFERENCE_LABELS[prof.drivingPreference]}${prof.priorityDriver ? ' (conducteur prioritaire désigné)' : ''}.`);
    if (h) {
      const exp = fmt(h.expectedDrives);
      details.push(
        h.eventsAttended === 0
          ? 'Aucun historique : départagé par les préférences et la géographie.'
          : `A conduit ${h.timesDriver} fois sur ${h.eventsAttended} événement(s) (≈ ${exp} attendu(s) pour une répartition égale, ${signed(h.driveBalance)} trajet).`,
      );
      if (h.currentStreak > 0) {
        details.push(
          `${h.currentStreak} trajet(s) consécutif(s) comme conducteur${h.currentStreak >= plan.strategy.maxConsecutive ? ` (limite : ${plan.strategy.maxConsecutive}, priorité réduite)` : ''}.`,
        );
      }
    }
    if (vm) {
      details.push(
        `Itinéraire de ${fmt(vm.routeKm)} km (direct : ${fmt(vm.directKm)} km), détour ${fmt(vm.detourKm)} km, ${v.passengerIds.length} passager(s).`,
      );
    }
    const rank = ranked.indexOf(id) + 1;
    let because = '';
    if (manual && plan.locks.drivers.includes(id)) because = 'Conducteur imposé manuellement.';
    else if (score && rank > 0) {
      const cars = plan.vehicles.length;
      because =
        rank <= cars
          ? `Fait partie des ${cars} conducteur(s) les plus prioritaires (rang ${rank}/${ranked.length}).`
          : `Rang ${rank}/${ranked.length} en priorité, retenu car sa position géographique ou la capacité de sa voiture évite des détours aux autres.`;
    }
    out.push({
      id: `driver_${id}`,
      kind: 'driver',
      subjectId: id,
      vehicleId: v.id,
      title: `Pourquoi ${nameOf(problem, id)} conduit`,
      text: because || 'Conducteur de ce véhicule.',
      details,
    });
  }

  // ── Pourquoi tel candidat n'a pas été retenu (contre-exemples calculés) ──
  const driverSet = new Set(plan.vehicles.map((v) => v.driverId));
  const notChosen = ranked.filter((id) => !driverSet.has(id)).slice(0, 4);
  const current = state.evaluate([...driverSet]);
  for (const cid of notChosen) {
    const cs = state.scores.get(cid);
    if (!cs || !current) continue;
    let bestSwap: { out: string; ev: Evaluation } | null = null;
    for (const d of driverSet) {
      if (state.fixed.includes(d)) continue;
      const ev = state.evaluate([...driverSet].filter((x) => x !== d).concat(cid));
      if (ev && ev.leftover.length === 0 && (!bestSwap || ev.total < bestSwap.ev.total)) bestSwap = { out: d, ev };
    }
    const details: string[] = [];
    let text: string;
    if (bestSwap) {
      const dOut = bestSwap.out;
      const outScore = state.scores.get(dOut);
      const dKm = bestSwap.ev.km - current.km;
      const dTotal = bestSwap.ev.total - current.total;
      text =
        `${nameOf(problem, cid)} n’a pas été retenu(e) : à la place de ${nameOf(problem, dOut)}, l’organisation serait ` +
        `${dTotal >= 0 ? 'moins bonne' : 'équivalente'} (${signed(dKm)} km au total).`;
      if (outScore) {
        const better = cs.total < outScore.total;
        details.push(
          better
            ? `${nameOf(problem, cid)} est plus prioritaire que ${nameOf(problem, dOut)}, mais sa position géographique alourdit l’ensemble (${signed(dKm)} km).`
            : `${nameOf(problem, cid)} est moins prioritaire que ${nameOf(problem, dOut)} : ${scoreDifference(cs, outScore, problem)}.`,
        );
      }
    } else {
      text = `${nameOf(problem, cid)} n’a pas été retenu(e) : ses places ne sont pas nécessaires ou ne permettent pas de transporter tout le monde.`;
    }
    details.push(
      `Historique : ${cs.timesDriver} trajet(s) conduit(s) sur ${cs.eventsAttended} événement(s), ${signed(cs.relativeTrips)} trajet par rapport à la moyenne des conducteurs possibles.`,
    );
    out.push({
      id: `unchosen_${cid}`,
      kind: 'unchosen',
      subjectId: cid,
      vehicleId: null,
      title: `Pourquoi pas ${nameOf(problem, cid)} ?`,
      text,
      details,
    });
  }

  // ── Passagers ──
  for (const v of plan.vehicles) {
    const startNode = problem.nodeOf.get(v.driverId);
    if (startNode === undefined) continue;
    const nodes = v.passengerIds.map((id) => problem.nodeOf.get(id) as number);
    const fullKm = problem.routes.get(startNode, nodes).km;
    for (const pid of v.passengerIds) {
      const without = nodes.filter((nd) => nd !== (problem.nodeOf.get(pid) as number));
      const marginal = fullKm - problem.routes.get(startNode, without).km;
      let bestAlt: { driver: string; delta: number } | null = null;
      let fullCars = 0;
      for (const w of plan.vehicles) {
        if (w.id === v.id) continue;
        if (w.passengerIds.length + 1 >= capacityOf(problem, w.driverId)) {
          fullCars++;
          continue;
        }
        const ws = problem.nodeOf.get(w.driverId) as number;
        const wn = w.passengerIds.map((id) => problem.nodeOf.get(id) as number);
        const delta =
          problem.routes.get(ws, [...wn, problem.nodeOf.get(pid) as number]).km - problem.routes.get(ws, wn).km;
        if (!bestAlt || delta < bestAlt.delta) bestAlt = { driver: w.driverId, delta };
      }
      const locked = plan.locks.assignments[pid] === v.driverId && manual;
      const text = `${nameOf(problem, pid)} est récupéré(e) à ${placeLabelOf(problem, pid)} par ${nameOf(problem, v.driverId)} (détour marginal estimé : ${fmt(marginal)} km).`;
      const details: string[] = [];
      if (bestAlt) {
        details.push(
          `Meilleure alternative : voiture de ${nameOf(problem, bestAlt.driver)} (${fmt(bestAlt.delta)} km de détour, soit ${signed(bestAlt.delta - marginal)} km par rapport au choix retenu).`,
        );
      } else if (plan.vehicles.length > 1) {
        details.push(`Les ${fullCars} autre(s) voiture(s) sont complètes.`);
      } else {
        details.push('Une seule voiture est utilisée.');
      }
      if (m.unlocated.includes(problem.nodeOf.get(pid) as number)) {
        details.push('Coordonnées manquantes : ce rattachement n’est pas optimisé géographiquement.');
      }
      if (locked) details.push('Affectation imposée manuellement.');
      out.push({
        id: `passenger_${pid}`,
        kind: 'passenger',
        subjectId: pid,
        vehicleId: v.id,
        title: `Pourquoi ${nameOf(problem, pid)} est dans cette voiture`,
        text,
        details,
      });
    }
  }

  // ── Équité ──
  const histEvents = historyEventsFor(ctx.event, ctx.allEvents);
  const before = fairnessReport(problem.history, plan.eligibleDriverIds);
  const simulated = computeHistory(ctx.participants, [
    ...histEvents,
    { ...ctx.event, status: 'done', plan, deletedAt: null },
  ]);
  const after = fairnessReport(simulated, plan.eligibleDriverIds);
  const eqDetails: string[] = [
    `Avant cet événement : écart de conduite ${fmt(before.imbalance, 2)} trajet (score d’équité ${before.score}/100).`,
    `Après cet événement : écart ${fmt(after.imbalance, 2)} trajet (score ${after.score}/100).`,
  ];
  plan.alternatives.slice(1).forEach((alt, i) => {
    const names = alt.driverIds.map((d) => nameOf(problem, d)).join(', ');
    const own = plan.alternatives[0];
    eqDetails.push(
      `Alternative ${i + 1} (conducteurs : ${names}) : équité projetée ${fmt(alt.projectedImbalance, 2)}` +
        (own ? ` contre ${fmt(own.projectedImbalance, 2)}` : '') +
        `, ${signed(alt.totalKm - (own?.totalKm ?? alt.totalKm))} km.`,
    );
  });
  out.push({
    id: 'fairness',
    kind: 'fairness',
    subjectId: null,
    vehicleId: null,
    title: 'Équité dans le temps',
    text:
      after.imbalance <= before.imbalance + 1e-9
        ? 'Cette organisation rapproche (ou maintient) l’équilibre de conduite entre les conducteurs possibles.'
        : 'Cette organisation creuse légèrement l’écart de conduite : la géographie ou les capacités l’emportent ici.',
    details: eqDetails,
  });

  return out;
}

/**
 * Compare deux organisations du même événement et explique laquelle est la plus équitable.
 */
export function comparePlans(ctx: PlanContext, a: Plan, b: Plan, labelA = 'A', labelB = 'B'): string[] {
  const problem = prepareProblem({ ...ctx, strategy: a.strategy, locks: a.locks, excluded: a.excluded });
  const eligible = findDriverCandidates(problem).regular;
  const ia = projectedImbalance(problem.history, eligible, a.vehicles.map((v) => v.driverId));
  const ib = projectedImbalance(problem.history, eligible, b.vehicles.map((v) => v.driverId));
  const lines: string[] = [];
  const verdict =
    Math.abs(ia - ib) < 0.005
      ? `Les organisations ${labelA} et ${labelB} sont également équitables (écart projeté ${fmt(ia, 2)}).`
      : ia < ib
        ? `${labelA} est plus équitable que ${labelB} : écart de conduite projeté ${fmt(ia, 2)} contre ${fmt(ib, 2)} trajet.`
        : `${labelB} est plus équitable que ${labelA} : écart de conduite projeté ${fmt(ib, 2)} contre ${fmt(ia, 2)} trajet.`;
  lines.push(verdict);
  lines.push(
    `${labelA} : ${a.metrics.carsUsed} voiture(s), ${fmt(a.metrics.totalKm)} km — ${labelB} : ${b.metrics.carsUsed} voiture(s), ${fmt(b.metrics.totalKm)} km.`,
  );
  const onlyA = a.vehicles.map((v) => v.driverId).filter((d) => !b.vehicles.some((v) => v.driverId === d));
  const onlyB = b.vehicles.map((v) => v.driverId).filter((d) => !a.vehicles.some((v) => v.driverId === d));
  if (onlyA.length + onlyB.length > 0) {
    lines.push(
      `Conducteurs différents : ${labelA} → ${onlyA.map((d) => nameOf(problem, d)).join(', ') || '—'} ; ${labelB} → ${onlyB.map((d) => nameOf(problem, d)).join(', ') || '—'}.`,
    );
  }
  return lines;
}
