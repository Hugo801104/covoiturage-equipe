// filepath: src/engine/index.ts
// API publique du moteur de covoiturage : indépendante de l'interface et du stockage.

export { haversineKm, straightLineProvider, roundKm } from './geo.ts';
export type { DistanceProvider, DistanceMatrix } from './geo.ts';
export { solve } from './solver.ts';
export type { SolveOptions } from './solver.ts';
export {
  addVehicle,
  excludeParticipant,
  includeParticipant,
  lockAll,
  movePassenger,
  recompute,
  removeVehicle,
  reorderStops,
  setDriver,
  unlockAll,
  EditError,
} from './plan-edit.ts';
export { explainPlan, comparePlans, fmt } from './explain.ts';
export type { Explanation } from './explain.ts';
export { computeHistory, historyEventsFor, doneEventsSorted } from './history.ts';
export type { ParticipantHistory } from './history.ts';
export { fairnessReport, gini, stdDev } from './fairness.ts';
export type { FairnessReport } from './fairness.ts';
export { prepareProblem } from './problem.ts';
export type { PlanContext, Problem } from './problem.ts';
export { finalizePlan, computeMetrics, validatePlan } from './plan-utils.ts';
