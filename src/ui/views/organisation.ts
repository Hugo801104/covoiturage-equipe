// filepath: src/ui/views/organisation.ts
// Écran Organisation : stratégie, calcul, véhicules, édition manuelle, explications, alternatives, carte.

import type { AppState, Participant, Plan, SportEvent, StrategyConfig, StrategyMode, Vehicle, Weights } from '../../domain/types.ts';
import { STRATEGY_LABELS, STRATEGY_PRESETS, attendanceOf, effectiveDrivingProfile, fullName } from '../../domain/helpers.ts';
import {
  EditError, addVehicle, comparePlans, computeHistory, excludeParticipant, explainPlan, fmt, historyEventsFor, includeParticipant,
  lockAll, movePassenger, recompute, removeVehicle, reorderStops, setDriver, solve, unlockAll,
} from '../../engine/index.ts';
import { projectedImbalance } from '../../engine/fairness.ts';
import { activeEvents, completeEvent, reopenEvent, setPlan, updateSettings, upcomingEvents } from '../../data/actions.ts';
import { findEvent, planContextFor } from '../context.ts';
import type { AppContext, ComparisonRow } from '../context.ts';
import { confirmDialog, h, toast } from '../dom.ts';
import { badge, card, checkField, emptyState, pageHeader } from '../components.ts';
import { eventTitle, fmtDay, fmtKm, fmtNum, MODE_SHORT, nameFor, participantMap, placeText } from '../format.ts';
import { colorOf, renderMap } from '../map.ts';
import { routeHash } from '../context.ts';

let computing = false;

const WEIGHT_LABELS: Array<[keyof Weights, string, string]> = [
  ['volunteer', 'Priorité aux volontaires', '0 = les préférences sont ignorées · 10 = les volontaires conduisent d’abord'],
  ['tripEquity', 'Équité du nombre de trajets', 'Plus c’est haut, plus on évite de faire conduire souvent les mêmes'],
  ['distanceEquity', 'Équité des kilomètres', 'Compense aussi les longs trajets conduits dans le passé'],
  ['consecutive', 'Limite des trajets consécutifs', 'Pénalise ceux qui ont conduit les derniers événements de suite'],
  ['compactness', 'Kilomètres et détours réduits', 'Importance de la compacité géographique des voitures'],
  ['fewCars', 'Nombre de voitures réduit', 'Plus c’est haut, plus on évite d’ajouter des voitures'],
];

export function renderOrganisation(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  const state = store.state;
  const root = h('div', { class: 'view' });
  const events = activeEvents(state);
  if (events.length === 0) {
    root.append(pageHeader('Organisation'), emptyState('Aucun événement à organiser', 'Créez d’abord un événement et saisissez les disponibilités.', h('a', { class: 'btn btn-primary', href: routeHash('events') }, 'Aller aux événements')));
    return root;
  }
  const upcoming = upcomingEvents(state, ctx.today());
  const event = findEvent(state, ctx.route.param) ?? upcoming[0] ?? [...events].sort((a, b) => b.date.localeCompare(a.date))[0] as SportEvent;
  const names = participantMap(state);

  root.append(
    pageHeader('Organisation', `${eventTitle(event)} → ${placeText(event.destination)}`, eventSelector(ctx, events, event)),
    attendanceSummary(event),
    strategyCard(ctx),
    computeCard(ctx, event),
  );
  const plan = event.plan;
  if (!plan) {
    root.appendChild(emptyState('Pas encore d’organisation', 'Choisissez une stratégie puis lancez le calcul.'));
    return root;
  }
  root.append(planSummary(ctx, event, plan, state), ...planBody(ctx, event, plan, state, names));
  return root;
}

function eventSelector(ctx: AppContext, events: SportEvent[], current: SportEvent): HTMLElement {
  const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date));
  return h('div', { class: 'field inline' },
    h('label', { for: 'org-event' }, 'Événement'),
    h('select', { id: 'org-event', value: current.id, onchange: (e: Event) => ctx.navigate('organisation', (e.target as HTMLSelectElement).value) },
      sorted.map((e) => h('option', { value: e.id, selected: e.id === current.id }, `${fmtDay(e.date, false)} · ${e.name}${e.status === 'done' ? ' (terminé)' : ''}`))));
}

function attendanceSummary(event: SportEvent): HTMLElement {
  const yes = event.attendance.filter((a) => a.availability === 'yes').length;
  const unknown = event.attendance.filter((a) => a.availability === 'unknown').length;
  const self = event.attendance.filter((a) => a.availability === 'yes' && a.selfTransport).length;
  return h('p', { class: 'summary-line' },
    badge(`${yes} disponible${yes > 1 ? 's' : ''}`, yes ? 'ok' : 'warn'), ' ',
    self ? [badge(`${self} en transport autonome`, 'info'), ' '] : null,
    unknown ? [badge(`${unknown} sans réponse`, 'warn', 'Ces personnes ne sont pas organisées tant qu’elles n’ont pas répondu'), ' '] : null,
    h('a', { href: routeHash('events', event.id) }, 'Modifier les disponibilités'));
}

// ───────────────────────── Stratégie ─────────────────────────

function strategyCard(ctx: AppContext): HTMLElement {
  const { store, ui } = ctx;
  const strategy = store.state.settings.strategy;
  const setStrategy = (s: StrategyConfig): void => store.dispatch(updateSettings({ strategy: s }));
  const modes: StrategyMode[] = ['mixed', 'equity', 'volunteer'];
  const options = modes.map((m) =>
    h('button', {
      type: 'button', class: `strategy${strategy.mode === m ? ' selected' : ''}`, role: 'radio', 'aria-checked': String(strategy.mode === m),
      onclick: () => setStrategy({ ...strategy, mode: m, weights: { ...STRATEGY_PRESETS[m] } }),
    }, h('strong', null, STRATEGY_LABELS[m].title), h('span', null, STRATEGY_LABELS[m].description)));

  const advanced = ui.orgShowAdvanced
    ? h('div', { class: 'advanced' },
        WEIGHT_LABELS.map(([key, label, hint]) => {
          const id = `w-${key}`;
          return h('div', { class: 'field slider' },
            h('label', { for: id }, label, ' : ', h('output', { for: id }, String(strategy.weights[key]))),
            h('input', { id, type: 'range', min: 0, max: 10, step: 1, value: String(strategy.weights[key]), 'aria-describedby': `${id}-h`,
              onchange: (e: Event) => setStrategy({ ...strategy, weights: { ...strategy.weights, [key]: Number((e.target as HTMLInputElement).value) } }) }),
            h('small', { id: `${id}-h`, class: 'hint' }, hint));
        }),
        numberSetting('maxConsecutive', 'Trajets consécutifs maximum avant perte de priorité', strategy.maxConsecutive, 1, 8, (v) => setStrategy({ ...strategy, maxConsecutive: v })),
        numberSetting('maxDetourKm', 'Détour toléré par conducteur (km à vol d’oiseau)', strategy.maxDetourKm, 0, 200, (v) => setStrategy({ ...strategy, maxDetourKm: v })),
        numberSetting('extraCars', 'Voitures supplémentaires explorées au-delà du minimum', strategy.extraCars, 0, 3, (v) => setStrategy({ ...strategy, extraCars: v })),
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => setStrategy({ ...strategy, weights: { ...STRATEGY_PRESETS[strategy.mode] } }) }, 'Rétablir les pondérations du mode'))
    : null;

  return card('Stratégie',
    h('div', { class: 'strategies', role: 'radiogroup', 'aria-label': 'Stratégie d’organisation' }, options),
    h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'aria-expanded': String(ui.orgShowAdvanced), onclick: () => { ui.orgShowAdvanced = !ui.orgShowAdvanced; ctx.refresh(); } }, ui.orgShowAdvanced ? 'Masquer les réglages avancés' : 'Réglages avancés (pondérations)'),
    advanced);
}

function numberSetting(name: string, label: string, value: number, min: number, max: number, onChange: (v: number) => void): HTMLElement {
  const id = `n-${name}`;
  return h('div', { class: 'field' }, h('label', { for: id }, label),
    h('input', { id, type: 'number', min, max, step: 1, value: String(value), class: 'narrow',
      onchange: (e: Event) => { const n = Math.round(Number((e.target as HTMLInputElement).value)); if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n))); } }));
}

// ───────────────────────── Calcul ─────────────────────────

function computeCard(ctx: AppContext, event: SportEvent): HTMLElement {
  const { store, ui } = ctx;
  const plan = event.plan;
  const yes = event.attendance.filter((a) => a.availability === 'yes').length;
  const hasLocks = !!plan && (plan.locks.drivers.length > 0 || Object.keys(plan.locks.assignments).length > 0 || plan.excluded.length > 0);

  const run = async (): Promise<void> => {
    if (computing) return;
    if (event.status === 'done' && !(await confirmDialog({ title: 'Recalculer un événement terminé ?', message: 'Cet événement est dans l’historique : un recalcul modifiera aussi les statistiques d’équité.', confirmLabel: 'Recalculer', danger: true }))) return;
    computing = true;
    ctx.refresh();
    await new Promise((r) => setTimeout(r, 30)); // laisse le navigateur afficher l'état « Calcul en cours »
    try {
      const state = store.state;
      const current = findEvent(state, event.id) ?? event;
      const pctx = planContextFor(state, current, state.settings.strategy);
      const next = recompute(pctx, current.plan, ui.orgKeepLocked && !!current.plan);
      store.dispatch(setPlan(event.id, next));
      ui.orgComparison = null;
      toast(next.status === 'ok' ? `Organisation calculée : ${next.metrics.carsUsed} voiture(s), ${fmtKm(next.metrics.totalKm)}.` : 'Organisation incomplète : consultez les problèmes signalés.', { kind: next.status === 'ok' ? 'success' : 'error' });
    } catch (e) {
      toast(`Le calcul a échoué : ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
    } finally {
      computing = false;
      ctx.refresh();
    }
  };

  return card(null,
    h('div', { class: 'row-wrap' },
      h('button', { type: 'button', class: 'btn btn-primary btn-large', disabled: computing || yes === 0, 'aria-busy': String(computing), onclick: () => void run() },
        computing ? 'Calcul en cours…' : plan ? 'Recalculer l’organisation' : 'Calculer l’organisation'),
      plan ? checkField('keepLocked', 'Conserver mes modifications manuelles', ui.orgKeepLocked, hasLocks ? 'Conducteurs et affectations modifiés à la main restent en place.' : 'Aucune modification manuelle pour l’instant.') : null),
    yes === 0 ? h('p', { class: 'alert alert-warn', role: 'status' }, 'Aucun participant disponible pour cet événement : saisissez d’abord les disponibilités.') : null,
  );
}

// ───────────────────────── Synthèse ─────────────────────────

function planSummary(ctx: AppContext, event: SportEvent, plan: Plan, state: AppState): HTMLElement {
  const m = plan.metrics;
  const statusBadge = plan.status === 'ok' ? badge('Organisation valide', 'ok') : plan.status === 'incomplete' ? badge('Organisation incomplète', 'warn') : badge('Organisation invalide', 'error');
  const saved = m.soloKm - m.totalKm;
  const history = computeHistory(state.participants, historyEventsFor(event, activeEvents(state)));
  const drivers = plan.vehicles.map((v) => v.driverId);
  const imbalance = projectedImbalance(history, plan.eligibleDriverIds, drivers);
  const issues = [...plan.issues].sort((a, b) => rank(a.severity) - rank(b.severity));
  const names = participantMap(state);

  return card('Résultat',
    h('p', null, statusBadge, ' ', plan.validated ? badge('Terminé', 'ok') : null, ' ', badge(plan.source === 'manual' ? 'Modifié à la main' : 'Calculé par le moteur', 'neutral'), ' ', badge(`Mode ${MODE_SHORT[plan.strategy.mode]}`, 'info')),
    h('div', { class: 'stats' },
      statBox('Voitures', String(m.carsUsed)),
      statBox('Distance totale', fmtKm(m.totalKm)),
      statBox('Détours', fmtKm(m.totalDetourKm)),
      statBox('Sans covoiturage', fmtKm(m.soloKm), saved > 0 ? `${fmtKm(saved)} économisés` : undefined),
      statBox('Déséquilibre projeté', fmtNum(imbalance, 2), 'écart-type de la dette de conduite après cet événement')),
    h('p', { class: 'hint' }, 'Distances à vol d’oiseau : ce sont des estimations, pas des temps de trajet routier. Aucun horaire d’arrivée n’est calculé.'),
    issues.length > 0 ? h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: `issue issue-${i.severity}` },
      h('span', { class: 'sr-only' }, i.severity === 'error' ? 'Erreur : ' : i.severity === 'warning' ? 'Attention : ' : 'Information : '), i.message,
      i.participantIds.length ? h('small', { class: 'hint' }, ` (${i.participantIds.map((id) => nameFor(names, id)).join(', ')})`) : null))) : null,
    plan.suggestions.length > 0 ? h('div', { class: 'alert alert-info' }, h('strong', null, 'Pistes pour résoudre :'), h('ul', null, plan.suggestions.map((s) => h('li', null, s)))) : null,
  );
}

const rank = (s: string): number => (s === 'error' ? 0 : s === 'warning' ? 1 : 2);

function statBox(label: string, value: string, hint?: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), hint ? h('div', { class: 'hint' }, hint) : null);
}

// ───────────────────────── Corps du plan ─────────────────────────

function planBody(ctx: AppContext, event: SportEvent, plan: Plan, state: AppState, names: Map<string, Participant>): HTMLElement[] {
  const { store, ui } = ctx;
  const pctx = planContextFor(state, event, plan.strategy);
  const edit = (fn: () => Plan): void => {
    try { store.dispatch(setPlan(event.id, fn())); }
    catch (e) { toast(e instanceof EditError ? e.message : `Modification impossible : ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' }); }
  };

  const drivingIds = new Set(plan.vehicles.map((v) => v.driverId));
  const attendees = plan.attendeeIds.map((id) => names.get(id)).filter((p): p is Participant => !!p);
  const canDriveList = attendees.filter((p) => effectiveDrivingProfile(p, attendanceOf(event, p.id)).canDrive);
  const vehicleLabel = (v: Vehicle): string => `Voiture ${plan.vehicles.indexOf(v) + 1} (${nameFor(names, v.driverId)})`;
  const metricsOf = (id: string) => plan.metrics.vehicles.find((x) => x.vehicleId === id);
  const startLabel = (id: string): string => {
    const att = attendanceOf(event, id);
    const p = names.get(id);
    return att?.startOverride?.label || p?.home.label || 'départ inconnu';
  };

  const vehicleCards = plan.vehicles.map((v, i) => {
    const vm = metricsOf(v.id);
    const driver = names.get(v.driverId);
    const free = vm ? vm.seatsTotal - vm.seatsUsed : 0;
    const locked = plan.locks.drivers.includes(v.driverId);
    const otherDrivers = canDriveList.filter((p) => p.id === v.driverId || !drivingIds.has(p.id));
    const passengers = v.passengerIds.map((pid, idx) => {
      const lockedP = plan.locks.assignments[pid] === v.driverId;
      const label = nameFor(names, pid);
      const moveOptions = plan.vehicles.filter((o) => o.id !== v.id);
      return h('li', { class: 'passenger' },
        h('span', { class: 'stop-n' }, String(idx + 1)),
        h('span', { class: 'grow' }, h('strong', null, label), lockedP ? h('span', { title: 'Affectation imposée (conservée au recalcul)' }, ' 🔒') : null, h('small', { class: 'hint' }, ` · ${startLabel(pid)}`)),
        h('span', { class: 'row-wrap tight' },
          h('button', { type: 'button', class: 'btn btn-small btn-icon', disabled: idx === 0, 'aria-label': `Récupérer ${label} plus tôt`, onclick: () => edit(() => reorderStops(pctx, plan, v.id, swap(v.passengerIds, idx, idx - 1))) }, '↑'),
          h('button', { type: 'button', class: 'btn btn-small btn-icon', disabled: idx === v.passengerIds.length - 1, 'aria-label': `Récupérer ${label} plus tard`, onclick: () => edit(() => reorderStops(pctx, plan, v.id, swap(v.passengerIds, idx, idx + 1))) }, '↓'),
          h('select', { class: 'compact', 'aria-label': `Déplacer ${label}`, onchange: (e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              if (val === '') return;
              edit(() => movePassenger(pctx, plan, pid, val === '__none' ? null : val));
            } },
            h('option', { value: '' }, 'Déplacer…'),
            moveOptions.map((o) => h('option', { value: o.id }, vehicleLabel(o))),
            h('option', { value: '__none' }, 'Retirer (non affecté)')),
          h('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'aria-label': `Exclure ${label} de l’organisation`, onclick: () => edit(() => excludeParticipant(pctx, plan, pid)) }, 'Exclure')));
    });
    return h('article', { class: 'vehicle', style: `--vehicle:${colorOf(i)}`, 'aria-label': vehicleLabel(v) },
      h('header', null,
        h('h3', null, h('span', { class: 'swatch', 'aria-hidden': 'true' }), `Voiture ${i + 1}`),
        h('span', { class: 'row-wrap tight' },
          badge(`${vm?.seatsUsed ?? v.passengerIds.length}/${vm?.seatsTotal ?? '?'} places`, free < 0 ? 'error' : free === 0 ? 'neutral' : 'info'),
          vm ? badge(fmtKm(vm.routeKm), 'neutral', `Trajet à vol d’oiseau ; direct : ${fmtKm(vm.directKm)} ; détour : ${fmtKm(vm.detourKm)}`) : null)),
      h('div', { class: 'field inline' },
        h('label', { for: `drv-${v.id}` }, 'Conducteur', locked ? ' 🔒' : ''),
        h('select', { id: `drv-${v.id}`, value: v.driverId, onchange: (e: Event) => { const id = (e.target as HTMLSelectElement).value; if (id !== v.driverId) edit(() => setDriver(pctx, plan, v.id, id)); } },
          otherDrivers.map((p) => h('option', { value: p.id, selected: p.id === v.driverId }, `${fullName(p)} (${effectiveDrivingProfile(p, attendanceOf(event, p.id)).seats} pl.)`)),
          driver && !otherDrivers.includes(driver) ? h('option', { value: driver.id, selected: true }, fullName(driver)) : null)),
      h('p', { class: 'route' }, h('strong', null, 'Départ : '), startLabel(v.driverId)),
      passengers.length > 0 ? h('ol', { class: 'passengers', 'aria-label': 'Ramassages dans l’ordre' }, passengers) : h('p', { class: 'muted' }, 'Aucun passager : le conducteur voyage seul.'),
      h('p', { class: 'route' }, h('strong', null, 'Arrivée : '), placeText(event.destination)),
      vm && vm.detourKm > plan.strategy.maxDetourKm ? h('p', { class: 'alert alert-warn' }, `Détour de ${fmtKm(vm.detourKm)} (seuil ${plan.strategy.maxDetourKm} km).`) : null,
      h('div', { class: 'row-wrap' }, h('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', onclick: () => edit(() => removeVehicle(pctx, plan, v.id)) }, 'Supprimer ce véhicule')));
  });

  const sections: HTMLElement[] = [];
  sections.push(card('Véhicules', plan.vehicles.length === 0 ? h('p', { class: 'muted' }, 'Aucun véhicule.') : h('div', { class: 'vehicles' }, vehicleCards), addVehicleForm(plan, canDriveList, drivingIds, (id) => edit(() => addVehicle(pctx, plan, id)))));

  // Non affectés / exclus / transport autonome
  const sideBlocks: Array<HTMLElement | null> = [];
  if (plan.unassigned.length > 0) {
    sideBlocks.push(h('div', { class: 'alert alert-error' }, h('h3', null, `${plan.unassigned.length} personne(s) sans place`),
      h('ul', { class: 'plain' }, plan.unassigned.map((u) => h('li', { class: 'row-wrap' }, h('span', { class: 'grow' }, h('strong', null, nameFor(names, u.participantId)), ` — ${u.reason}`),
        plan.vehicles.length ? h('select', { class: 'compact', 'aria-label': `Affecter ${nameFor(names, u.participantId)}`, onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; if (val) edit(() => movePassenger(pctx, plan, u.participantId, val)); } },
          h('option', { value: '' }, 'Affecter à…'), plan.vehicles.map((o) => h('option', { value: o.id }, vehicleLabel(o)))) : null)))));
  }
  if (plan.excluded.length > 0) {
    sideBlocks.push(h('div', null, h('h3', null, 'Exclus de l’organisation'),
      h('ul', { class: 'plain' }, plan.excluded.map((id) => h('li', { class: 'row-wrap' }, h('span', { class: 'grow' }, nameFor(names, id)),
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => edit(() => includeParticipant(pctx, plan, id)) }, 'Réintégrer'))))));
  }
  if (plan.selfTransportIds.length > 0) {
    sideBlocks.push(h('div', null, h('h3', null, 'Transport autonome'), h('p', { class: 'muted' }, plan.selfTransportIds.map((id) => nameFor(names, id)).join(', '))));
  }
  if (sideBlocks.length > 0) sections.push(card(null, sideBlocks));

  // Carte
  const mapToggles = plan.vehicles.map((v, i) => h('label', { class: 'chip', style: `--vehicle:${colorOf(i)}` },
    h('input', { type: 'checkbox', checked: !ui.orgHiddenVehicles.has(v.id), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) ui.orgHiddenVehicles.delete(v.id); else ui.orgHiddenVehicles.add(v.id); ctx.refresh(); } }),
    h('span', { class: 'swatch', 'aria-hidden': 'true' }), `Voiture ${i + 1}`));
  sections.push(card('Carte', h('div', { class: 'row-wrap' }, mapToggles),
    h('div', { class: 'map-wrap' }, renderMap({ event, plan, participants: names, hiddenVehicleIds: ui.orgHiddenVehicles })),
    h('p', { class: 'hint' }, 'Fond de carte volontairement absent (application hors ligne). Carré = conducteur, cercle = ramassage, étoile = destination.')));

  // Alternatives
  sections.push(alternativesCard(ctx, event, plan, state, names, pctx));
  sections.push(comparisonCard(ctx, event, plan, state, names));

  // Explications
  const explainBody = ui.orgShowExplain ? explanationBlock(pctx, plan) : null;
  sections.push(card('Pourquoi cette organisation ?',
    h('button', { type: 'button', class: 'btn', 'aria-expanded': String(ui.orgShowExplain), onclick: () => { ui.orgShowExplain = !ui.orgShowExplain; ctx.refresh(); } }, ui.orgShowExplain ? 'Masquer les explications' : 'Afficher les explications'),
    explainBody));

  // Actions finales
  const hasLocks = plan.locks.drivers.length > 0 || Object.keys(plan.locks.assignments).length > 0;
  sections.push(card('Validation',
    h('div', { class: 'row-wrap' },
      h('button', { type: 'button', class: 'btn', onclick: () => edit(() => (hasLocks ? unlockAll(pctx, plan) : lockAll(pctx, plan))) }, hasLocks ? 'Déverrouiller tout' : 'Verrouiller toute l’organisation'),
      event.status === 'done'
        ? h('button', { type: 'button', class: 'btn', onclick: () => { store.dispatch(reopenEvent(event.id)); toast('Événement rouvert.'); } }, 'Rouvrir l’événement')
        : h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
            if (plan.status !== 'ok' && !(await confirmDialog({ title: 'Terminer avec une organisation incomplète ?', message: 'Des problèmes subsistent. L’historique intégrera cette organisation telle quelle.', confirmLabel: 'Terminer quand même', danger: true }))) return;
            store.dispatch(completeEvent(event.id));
            toast('Événement terminé : il compte désormais dans l’équité et l’historique.', { kind: 'success', action: { label: 'Annuler', run: () => store.undo() } });
          } }, 'Valider et terminer l’événement')),
    h('p', { class: 'hint' }, event.status === 'done' ? 'Cet événement est dans l’historique : toute correction manuelle ci-dessus met à jour les statistiques.' : 'Terminer l’événement l’ajoute à l’historique : il influencera les prochaines organisations.')));
  return sections;
}

function swap(list: string[], a: number, b: number): string[] {
  const copy = [...list];
  const x = copy[a] as string;
  copy[a] = copy[b] as string;
  copy[b] = x;
  return copy;
}

function addVehicleForm(plan: Plan, canDrive: Participant[], driving: Set<string>, onAdd: (id: string) => void): HTMLElement {
  const candidates = canDrive.filter((p) => !driving.has(p.id));
  if (candidates.length === 0) return h('p', { class: 'hint' }, 'Aucune autre voiture disponible à ajouter.');
  const select = h('select', { id: 'add-vehicle', 'aria-label': 'Conducteur du nouveau véhicule' }, candidates.map((p) => h('option', { value: p.id }, fullName(p))));
  return h('div', { class: 'row-wrap add-vehicle' }, h('label', { for: 'add-vehicle' }, 'Ajouter un véhicule :'), select,
    h('button', { type: 'button', class: 'btn btn-small', onclick: () => onAdd(select.value) }, 'Ajouter'));
}

// ───────────────────────── Alternatives / comparaison ─────────────────────────

function alternativesCard(ctx: AppContext, event: SportEvent, plan: Plan, state: AppState, names: Map<string, Participant>, pctx: ReturnType<typeof planContextFor>): HTMLElement {
  const { store, ui } = ctx;
  const current = new Set(plan.vehicles.map((v) => v.driverId));
  if (plan.alternatives.length === 0) return card('Autres organisations possibles', h('p', { class: 'muted' }, 'Aucune alternative pertinente trouvée.'));
  const rows = plan.alternatives.map((alt) => {
    const same = alt.driverIds.length === current.size && alt.driverIds.every((id) => current.has(id));
    return h('tr', null,
      h('td', null, alt.driverIds.map((id) => nameFor(names, id)).join(', '), same ? h('span', null, ' ', badge('actuelle', 'ok')) : null),
      h('td', { class: 'num' }, String(alt.carsUsed)), h('td', { class: 'num' }, fmtKm(alt.totalKm)), h('td', { class: 'num' }, fmtNum(alt.projectedImbalance, 2)),
      h('td', null, same ? null : h('button', { type: 'button', class: 'btn btn-small', onclick: () => {
        try {
          const forced: Plan = { ...plan, locks: { drivers: [...alt.driverIds], assignments: {} } };
          const next = recompute(pctx, forced, true);
          store.dispatch(setPlan(event.id, next));
          ui.orgComparison = null;
          toast('Alternative appliquée.', { kind: 'success', action: { label: 'Annuler', run: () => store.undo() } });
        } catch (e) { toast(`Impossible : ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' }); }
      } }, 'Utiliser')));
  });
  return card('Autres organisations possibles',
    h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Alternatives' }, h('table', { class: 'table' },
      h('caption', { class: 'sr-only' }, 'Conducteurs alternatifs et impact'),
      h('thead', null, h('tr', null, [['Conducteurs', ''], ['Voitures', 'num'], ['Distance', 'num'], ['Déséquilibre projeté', 'num'], ['', '']].map(([t, c]) => h('th', { scope: 'col', class: c ?? '' }, t)))),
      h('tbody', null, rows))),
    h('p', { class: 'hint' }, 'Le déséquilibre projeté mesure l’écart de charge de conduite entre les conducteurs possibles après cet événement (plus bas = plus équitable).'));
}

function comparisonCard(ctx: AppContext, event: SportEvent, plan: Plan, state: AppState, names: Map<string, Participant>): HTMLElement {
  const { ui } = ctx;
  const run = (): void => {
    const history = computeHistory(state.participants, historyEventsFor(event, activeEvents(state)));
    const rows: ComparisonRow[] = (['equity', 'volunteer', 'mixed'] as StrategyMode[]).map((mode) => {
      const strategy: StrategyConfig = { ...plan.strategy, mode, weights: { ...STRATEGY_PRESETS[mode] } };
      const pctx = planContextFor(state, event, strategy);
      const alt = solve(pctx);
      const drivers = alt.vehicles.map((v) => v.driverId);
      return {
        mode, driverNames: drivers.map((id) => nameFor(names, id)), cars: alt.metrics.carsUsed, totalKm: alt.metrics.totalKm,
        imbalance: projectedImbalance(history, alt.eligibleDriverIds, drivers), status: alt.status,
        lines: comparePlans(pctx, plan, alt, 'Actuelle', MODE_SHORT[mode]),
      };
    });
    ui.orgComparison = rows;
    ui.orgComparisonEventId = event.id;
    ctx.refresh();
  };
  const rows = ui.orgComparisonEventId === event.id ? ui.orgComparison : null;
  return card('Comparer les trois stratégies',
    h('button', { type: 'button', class: 'btn', onclick: run }, rows ? 'Relancer la comparaison' : 'Comparer sur cet événement'),
    rows ? h('div', null,
      h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Comparaison des stratégies' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Stratégie', 'Conducteurs', 'Voitures', 'Distance', 'Déséquilibre projeté'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows.map((r) => h('tr', null, h('th', { scope: 'row' }, MODE_SHORT[r.mode], r.status !== 'ok' ? h('span', null, ' ', badge('incomplet', 'warn')) : null), h('td', null, r.driverNames.join(', ')),
          h('td', { class: 'num' }, String(r.cars)), h('td', { class: 'num' }, fmtKm(r.totalKm)), h('td', { class: 'num' }, fmtNum(r.imbalance, 2))))))),
      rows.map((r) => r.lines.length ? h('details', null, h('summary', null, `Différences entre l’organisation actuelle et « ${MODE_SHORT[r.mode]} »`), h('ul', null, r.lines.map((l) => h('li', null, l)))) : null))
      : h('p', { class: 'hint' }, 'Calcule l’organisation que donnerait chaque stratégie sans modifier celle de l’événement.'));
}

function explanationBlock(pctx: ReturnType<typeof planContextFor>, plan: Plan): HTMLElement {
  let items;
  try { items = explainPlan(pctx, plan); }
  catch (e) { return h('p', { class: 'alert alert-error', role: 'alert' }, `Explications indisponibles : ${e instanceof Error ? e.message : String(e)}`); }
  const groups: Array<[string, string]> = [['summary', 'Vue d’ensemble'], ['driver', 'Pourquoi ces conducteurs'], ['unchosen', 'Pourquoi pas les autres'], ['passenger', 'Pourquoi ces voitures pour les passagers'], ['fairness', 'Équité']];
  return h('div', { class: 'explanations' }, groups.map(([kind, title]) => {
    const list = items.filter((i) => i.kind === kind);
    if (list.length === 0) return null;
    return h('section', null, h('h3', null, title), list.map((i) => h('details', { open: kind === 'summary' }, h('summary', null, i.title), h('p', null, i.text), i.details.length ? h('ul', null, i.details.map((d) => h('li', null, d))) : null)));
  }), h('p', { class: 'hint' }, `Valeurs calculées sur ${fmt(plan.metrics.totalKm)} km à vol d’oiseau ; « unité de trajet » = distance médiane des candidats à la destination.`));
}
