// filepath: src/ui/views/dashboard.ts
// Tableau de bord : prochain événement, état des réponses, équité, rappel de sauvegarde.

import { computeHistory, fairnessReport } from '../../engine/index.ts';
import { activeEvents, activeParticipants, daysSince, doneEvents, replaceState, upcomingEvents } from '../../data/actions.ts';
import { buildDemoState } from '../../data/demo.ts';
import { routeHash } from '../context.ts';
import type { AppContext } from '../context.ts';
import { h, toast } from '../dom.ts';
import { badge, card, emptyState, pageHeader, stat } from '../components.ts';
import { fmtDateTime, fmtDay, fmtKm, MODE_SHORT, placeText } from '../format.ts';

export function renderDashboard(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  const state = store.state;
  const root = h('div', { class: 'view' });
  const people = activeParticipants(state);
  const events = activeEvents(state);

  root.appendChild(pageHeader(state.team.name, 'Tableau de bord du covoiturage'));

  if (people.length === 0 && events.length === 0) {
    root.appendChild(emptyState('Bienvenue 👋', 'Commencez par ajouter vos participants et un événement, ou explorez l’application avec une équipe de démonstration (24 personnes, 9 événements).',
      [h('a', { class: 'btn btn-primary', href: routeHash('participants') }, 'Ajouter des participants'),
       h('button', { type: 'button', class: 'btn', onclick: () => { store.dispatch(replaceState(mergeDeviceMeta(buildDemoState(), store.state.meta.deviceId))); toast('Données de démonstration chargées.', { kind: 'success', action: { label: 'Annuler', run: () => store.undo() } }); } }, 'Charger la démo')]));
    return root;
  }

  const age = daysSince(state.meta.lastExportAt);
  if (state.settings.backupEveryDays > 0 && (age === null || age >= state.settings.backupEveryDays)) {
    root.appendChild(h('div', { class: 'alert alert-warn', role: 'status' },
      h('strong', null, 'Pensez à exporter vos données. '),
      age === null ? 'Aucun export n’a jamais été fait.' : `Dernier export il y a ${age} jour(s).`, ' ',
      h('a', { href: routeHash('data') }, 'Exporter maintenant')));
  }

  const upcoming = upcomingEvents(state, ctx.today());
  const next = upcoming[0];
  if (next) {
    const yes = next.attendance.filter((a) => a.availability === 'yes').length;
    const unknown = next.attendance.filter((a) => a.availability === 'unknown').length;
    root.appendChild(card('Prochain événement',
      h('h3', null, next.name), h('p', null, `${fmtDay(next.date)} · départ ${next.departureTime} · ${placeText(next.destination)}`),
      h('p', null, badge(`${yes} disponibles`, yes ? 'ok' : 'warn'), ' ', badge(`${unknown} sans réponse`, unknown ? 'warn' : 'neutral'), ' ',
        next.plan ? badge(next.plan.status === 'ok' ? `${next.plan.metrics.carsUsed} voiture(s) · ${fmtKm(next.plan.metrics.totalKm)}` : 'organisation incomplète', next.plan.status === 'ok' ? 'info' : 'warn') : badge('pas encore organisé', 'warn')),
      h('div', { class: 'row-wrap' },
        h('a', { class: 'btn btn-primary', href: routeHash('organisation', next.id) }, next.plan ? 'Voir l’organisation' : 'Organiser les voitures'),
        h('a', { class: 'btn', href: routeHash('events', next.id) }, 'Disponibilités'))));
  } else {
    root.appendChild(card('Prochain événement', h('p', { class: 'muted' }, 'Aucun événement à venir.'), h('a', { class: 'btn btn-primary', href: routeHash('events') }, 'Créer un événement')));
  }

  const done = doneEvents(state);
  const history = computeHistory(state.participants, done);
  const report = fairnessReport(history, state.participants.map((p) => p.id));
  const cars = people.filter((p) => p.hasCar && p.carAvailable).length;
  root.appendChild(card('Vue d’ensemble',
    h('div', { class: 'stats' },
      stat('Participants', String(people.length)), stat('Voitures disponibles', String(cars)),
      stat('Événements à venir', String(upcoming.length)), stat('Événements terminés', String(done.length)),
      stat('Équité', done.length ? `${report.score}/100` : '—', done.length ? undefined : 'après le premier événement terminé')),
    h('p', { class: 'hint' }, `Mode par défaut : ${MODE_SHORT[state.settings.strategy.mode]} · dernière modification : ${fmtDateTime(state.meta.updatedAt)}`)));
  return root;
}

function mergeDeviceMeta<T extends { meta: { deviceId: string } }>(s: T, deviceId: string): T {
  return { ...s, meta: { ...s.meta, deviceId } };
}
