// filepath: src/ui/views/history.ts
// Écran Historique : événements terminés, équité cumulée par participant, évolution, corrections.

import type { Participant, SportEvent } from '../../domain/types.ts';
import { fullName } from '../../domain/helpers.ts';
import { computeHistory, fairnessReport } from '../../engine/index.ts';
import type { ParticipantHistory } from '../../engine/index.ts';
import { doneEvents } from '../../data/actions.ts';
import { routeHash } from '../context.ts';
import type { AppContext, HistorySortKey } from '../context.ts';
import { h, s } from '../dom.ts';
import { badge, card, emptyState, pageHeader, stat } from '../components.ts';
import { fmtDay, fmtKm, fmtNum, fmtSigned, MODE_SHORT, nameFor, participantMap, placeText } from '../format.ts';

export function renderHistory(ctx: AppContext): HTMLElement {
  const { store, ui } = ctx;
  const state = store.state;
  const root = h('div', { class: 'view' });
  const done = doneEvents(state);
  root.appendChild(pageHeader('Historique et équité', `${done.length} événement${done.length > 1 ? 's' : ''} terminé${done.length > 1 ? 's' : ''}`));
  if (done.length === 0) {
    root.appendChild(emptyState('Aucun événement terminé', 'Quand vous validez une organisation avec « Valider et terminer l’événement », elle apparaît ici et alimente l’équité des prochains trajets.',
      h('a', { class: 'btn btn-primary', href: routeHash('organisation') }, 'Aller à l’organisation')));
    return root;
  }
  const names = participantMap(state);
  const history = computeHistory(state.participants, done);
  const poolIds = state.participants.map((p) => p.id);
  const report = fairnessReport(history, poolIds);

  root.append(
    card('Équité cumulée',
      h('div', { class: 'stats' },
        stat('Score d’équité', `${report.score}/100`, report.score >= 80 ? 'Charge bien répartie' : report.score >= 60 ? 'Répartition correcte' : 'Charge déséquilibrée'),
        stat('Trajets conduits au total', String(report.totalDrives)),
        stat('Écart max entre conducteurs', fmtNum(report.spread, 1), 'en trajets, par rapport à la part équitable'),
        stat('Conducteurs concernés', String(report.pool))),
      h('p', { class: 'hint' }, 'Le score compare, pour chaque conducteur possible, les trajets réellement conduits et sa part équitable (voitures ÷ conducteurs possibles présents). Être absent ne crée ni dette ni crédit.'),
      trendChart(ctx, done)),
    participantTable(ctx, history, names),
    eventsList(ctx, done, names),
  );
  void ui;
  return root;
}

function trendChart(ctx: AppContext, done: SportEvent[]): HTMLElement {
  const state = ctx.store.state;
  const points = done.map((_, i) => {
    const hist = computeHistory(state.participants, done.slice(0, i + 1));
    return fairnessReport(hist, state.participants.map((p) => p.id)).score;
  });
  if (points.length < 2) return h('p', { class: 'hint' }, 'L’évolution du score apparaîtra à partir de deux événements terminés.');
  const W = 640, H = 160, pad = 28;
  const x = (i: number): number => pad + (i * (W - 2 * pad)) / (points.length - 1);
  const y = (v: number): number => H - pad - (v / 100) * (H - 2 * pad);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Évolution du score d’équité : ${points.join(', ')}` },
    s('line', { x1: pad, y1: y(0), x2: W - pad, y2: y(0), class: 'chart-axis' }),
    s('line', { x1: pad, y1: y(100), x2: W - pad, y2: y(100), class: 'chart-grid' }),
    s('text', { x: 4, y: y(100) + 4, class: 'chart-text' }, '100'), s('text', { x: 10, y: y(0) + 4, class: 'chart-text' }, '0'),
    s('polyline', { points: points.map((v, i) => `${x(i)},${y(v)}`).join(' '), fill: 'none', class: 'chart-line', 'stroke-width': 3 }),
    ...points.map((v, i) => s('circle', { cx: x(i), cy: y(v), r: 4, class: 'chart-dot' }, s('title', null, `${done[i]?.name ?? ''} : ${v}/100`))));
  return h('figure', null, svg, h('figcaption', { class: 'hint' }, 'Score d’équité après chaque événement terminé.'));
}

function participantTable(ctx: AppContext, history: Map<string, ParticipantHistory>, names: Map<string, Participant>): HTMLElement {
  const { ui } = ctx;
  const rows = [...history.values()].filter((hh) => hh.eventsAttended > 0 || hh.timesDriver > 0);
  const val = (hh: ParticipantHistory, key: HistorySortKey): number | string => {
    switch (key) {
      case 'name': return nameFor(names, hh.participantId);
      case 'attended': return hh.eventsAttended;
      case 'drives': return hh.timesDriver;
      case 'balance': return hh.driveBalance;
      case 'passenger': return hh.timesPassenger;
      case 'km': return hh.kmDriver;
      case 'streak': return hh.currentStreak;
    }
  };
  const { key, dir } = ui.historySort;
  rows.sort((a, b) => {
    const va = val(a, key), vb = val(b, key);
    return (typeof va === 'string' ? va.localeCompare(String(vb), 'fr') : (va as number) - (vb as number)) * dir;
  });
  const maxDrives = Math.max(1, ...rows.map((r) => Math.max(r.timesDriver, r.expectedDrives)));
  const th = (label: string, k: HistorySortKey, num = true): HTMLElement =>
    h('th', { scope: 'col', class: num ? 'num' : '', 'aria-sort': key === k ? (dir === 1 ? 'ascending' : 'descending') : 'none' },
      h('button', { type: 'button', class: 'th-btn', onclick: () => { ui.historySort = { key: k, dir: key === k ? ((dir * -1) as 1 | -1) : k === 'name' ? 1 : -1 }; ctx.refresh(); } }, label, key === k ? (dir === 1 ? ' ▲' : ' ▼') : ''));

  return card('Statistiques par participant',
    h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Statistiques par participant' }, h('table', { class: 'table' },
      h('caption', { class: 'sr-only' }, 'Trajets conduits, en passager et kilomètres par participant'),
      h('thead', null, h('tr', null, th('Participant', 'name', false), th('Présences', 'attended'), th('Conducteur', 'drives'), h('th', { scope: 'col' }, 'Conduits vs part équitable'), th('Écart', 'balance'), th('Passager', 'passenger'), th('Km conduits', 'km'), h('th', { scope: 'col', class: 'num' }, 'Km passager'), th('Série', 'streak'))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('th', { scope: 'row' }, nameFor(names, r.participantId)),
        h('td', { class: 'num' }, String(r.eventsAttended)), h('td', { class: 'num' }, String(r.timesDriver)),
        h('td', null, bar(r.timesDriver, r.expectedDrives, maxDrives)),
        h('td', { class: 'num' }, fmtSigned(r.driveBalance)), h('td', { class: 'num' }, String(r.timesPassenger)),
        h('td', { class: 'num' }, fmtKm(r.kmDriver)), h('td', { class: 'num' }, fmtKm(r.kmPassenger)),
        h('td', { class: 'num' }, r.currentStreak > 0 ? `${r.currentStreak} de suite` : '—'))))),
    ),
    h('p', { class: 'hint' }, 'La barre pleine = trajets conduits ; le trait = part équitable. Écart positif = a conduit plus que sa part.'));
}

function bar(value: number, expected: number, max: number): HTMLElement {
  const pct = (v: number): string => `${Math.min(100, (v / max) * 100).toFixed(1)}%`;
  return h('div', { class: 'bar', role: 'img', 'aria-label': `${value} conduits, part équitable ${fmtNum(expected, 1)}` },
    h('div', { class: 'bar-fill', style: `width:${pct(value)}` }), h('div', { class: 'bar-mark', style: `left:${pct(expected)}` }));
}

function eventsList(ctx: AppContext, done: SportEvent[], names: Map<string, Participant>): HTMLElement {
  const items = [...done].reverse().map((e) => {
    const plan = e.plan;
    return h('li', { class: 'history-item' },
      h('div', { class: 'grow' },
        h('strong', null, e.name), ` · ${fmtDay(e.date)} → ${placeText(e.destination)}`,
        plan ? h('div', { class: 'hint' }, `${plan.metrics.carsUsed} voiture(s) · ${fmtKm(plan.metrics.totalKm)} · mode ${MODE_SHORT[plan.strategy.mode]} · conducteurs : ${plan.vehicles.map((v) => nameFor(names, v.driverId)).join(', ') || 'aucun'}`) : null,
        plan && plan.status !== 'ok' ? badge('incomplet', 'warn') : null),
      h('a', { class: 'btn btn-small', href: routeHash('organisation', e.id), 'aria-label': `Voir ou corriger ${e.name}` }, 'Voir / corriger'));
  });
  return card('Événements terminés', h('ul', { class: 'plain' }, items), h('p', { class: 'hint' }, 'Une correction manuelle d’un événement terminé met à jour les statistiques ci-dessus.'));
}
void fullName;
