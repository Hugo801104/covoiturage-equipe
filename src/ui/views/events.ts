// filepath: src/ui/views/events.ts
// Écran Événements : liste, formulaire, tableau des disponibilités (avec exceptions par événement).

import type { Attendance, Availability, SportEvent } from '../../domain/types.ts';
import { createEvent, effectiveDrivingProfile, fullName } from '../../domain/helpers.ts';
import { activeEvents, activeParticipants, deleteEvent, reopenEvent, setAttendance, upsertEvent, withCompleteAttendance } from '../../data/actions.ts';
import type { AppContext } from '../context.ts';
import { h, toast } from '../dom.ts';
import { badge, card, emptyState, errorBox, field, gazetteerDatalist, pageHeader, placeFields, readPlace, textarea } from '../components.ts';
import { compareNames, fmtDay } from '../format.ts';
import { routeHash } from '../context.ts';

const AVAILABILITY: Array<[Availability, string]> = [['yes', 'Disponible'], ['no', 'Absent'], ['unknown', 'Sans réponse']];

export function renderEvents(ctx: AppContext): HTMLElement {
  const { store, ui } = ctx;
  const state = store.state;
  const root = h('div', { class: 'view' });
  const events = activeEvents(state).sort((a, b) => b.date.localeCompare(a.date));
  root.appendChild(
    pageHeader('Événements', 'Matchs, tournois, entraînements : chaque événement est organisé indépendamment.',
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { ui.eventEditId = 'new'; ctx.refresh(); } }, '+ Nouvel événement')),
  );

  if (ui.eventEditId === 'new') root.appendChild(eventForm(ctx, null));

  if (events.length === 0 && ui.eventEditId !== 'new') {
    root.appendChild(emptyState('Aucun événement', 'Créez un premier événement pour saisir les disponibilités puis organiser les voitures.', h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { ui.eventEditId = 'new'; ctx.refresh(); } }, 'Créer un événement')));
    return root;
  }

  const today = ctx.today();
  for (const e of events) {
    const open = ui.eventEditId === e.id || ctx.route.param === e.id;
    root.appendChild(eventCard(ctx, e, today, open));
  }
  return root;
}

function counts(e: SportEvent): { yes: number; no: number; unknown: number } {
  const c = { yes: 0, no: 0, unknown: 0 };
  for (const a of e.attendance) c[a.availability]++;
  return c;
}

function eventCard(ctx: AppContext, e: SportEvent, today: string, open: boolean): HTMLElement {
  const { store, ui } = ctx;
  const c = counts(e);
  const past = e.status === 'done' || e.date < today;
  const planBadge = e.plan
    ? e.status === 'done' ? badge('Terminé', 'ok') : e.plan.status === 'ok' ? badge('Organisé', 'info') : badge('Organisation incomplète', 'warn')
    : badge('À organiser', past ? 'neutral' : 'warn');
  const head = h(
    'div', { class: 'event-head' },
    h('div', null,
      h('h2', null, e.name || 'Événement sans nom'),
      h('p', { class: 'muted' }, `${fmtDay(e.date)} · départ ${e.departureTime}${e.returnTime ? ` · retour ${e.returnTime}` : ''} · ${e.destination.label || e.destination.address || 'destination ?'}`),
      h('p', null, planBadge, ' ', badge(`${c.yes} dispo`, 'ok'), ' ', badge(`${c.unknown} sans réponse`, c.unknown ? 'warn' : 'neutral'), ' ', badge(`${c.no} absents`, 'neutral')),
    ),
    h('div', { class: 'row-wrap' },
      h('a', { class: 'btn btn-primary', href: routeHash('organisation', e.id) }, e.plan ? 'Voir l’organisation' : 'Organiser'),
      h('button', { type: 'button', class: 'btn', 'aria-expanded': String(open), onclick: () => { ui.eventEditId = open ? null : e.id; if (ctx.route.param) ctx.navigate('events'); else ctx.refresh(); } }, open ? 'Fermer' : 'Modifier / disponibilités'),
    ),
  );
  const box = h('section', { class: 'card event' }, head);
  if (open) {
    box.append(eventForm(ctx, e), attendanceTable(ctx, e));
    box.append(
      h('div', { class: 'row-wrap' },
        e.status === 'done' ? h('button', { type: 'button', class: 'btn', onclick: () => { store.dispatch(reopenEvent(e.id)); toast('Événement rouvert : il n’entre plus dans l’historique tant qu’il n’est pas terminé.'); } }, 'Rouvrir l’événement') : null,
        h('button', {
          type: 'button', class: 'btn btn-danger-ghost',
          onclick: () => {
            store.dispatch(deleteEvent(e.id));
            ui.eventEditId = null;
            toast(`« ${e.name} » supprimé.`, { action: { label: 'Annuler', run: () => store.undo() } });
          },
        }, 'Supprimer l’événement')),
    );
  }
  return box;
}

function eventForm(ctx: AppContext, existing: SportEvent | null): HTMLElement {
  const { store, ui } = ctx;
  const base = existing ?? createEvent({ date: ctx.today(), departureTime: '08:00' });
  const errors = h('div');
  const form = h('form', { class: existing ? 'form' : 'card form', novalidate: '', 'aria-label': existing ? `Modifier ${base.name}` : 'Nouvel événement' });
  form.append(
    existing ? h('h3', null, 'Informations') : h('h2', null, 'Nouvel événement'),
    gazetteerDatalist(),
    field('name', 'Nom', { value: base.name, required: true, placeholder: 'Tournoi de Vannes' }),
    h('div', { class: 'row' },
      field('date', 'Date', { type: 'date', value: base.date, required: true }),
      field('departureTime', 'Heure de départ', { type: 'time', value: base.departureTime, required: true }),
      field('returnTime', 'Heure de retour (facultatif)', { type: 'time', value: base.returnTime ?? '' })),
    placeFields('dest', 'Destination', base.destination, true),
    textarea('constraints', 'Contraintes de l’événement', base.constraints, 'Ex. : arrivée avant 9 h, matériel volumineux…'),
    errors,
    h('div', { class: 'row-wrap' }, h('button', { type: 'submit', class: 'btn btn-primary' }, existing ? 'Enregistrer l’événement' : 'Créer l’événement'),
      !existing ? h('button', { type: 'button', class: 'btn', onclick: () => { ui.eventEditId = null; ctx.refresh(); } }, 'Annuler') : null),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const messages: string[] = [];
    const name = String(fd.get('name') ?? '').trim();
    if (name === '') messages.push('Le nom de l’événement est obligatoire.');
    const date = String(fd.get('date') ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) messages.push('La date est invalide.');
    const dep = String(fd.get('departureTime') ?? '');
    if (!/^\d{2}:\d{2}$/.test(dep)) messages.push('L’heure de départ est invalide.');
    const ret = String(fd.get('returnTime') ?? '');
    if (ret !== '' && !/^\d{2}:\d{2}$/.test(ret)) messages.push('L’heure de retour est invalide.');
    const dest = readPlace(fd, 'dest', true);
    if (dest.error) messages.push(dest.error);
    if (dest.place.lat === null) messages.push('La destination n’a pas de coordonnées : renseignez latitude/longitude ou choisissez une commune connue.');
    errors.replaceChildren(...(errorBox(messages) ? [errorBox(messages) as HTMLElement] : []));
    if (messages.length > 0) return;
    const next: SportEvent = { ...base, name, date, departureTime: dep, returnTime: ret === '' ? null : ret, destination: dest.place, constraints: String(fd.get('constraints') ?? '').trim() };
    store.dispatch(upsertEvent(next));
    ui.eventEditId = existing ? existing.id : next.id;
    toast(existing ? 'Événement enregistré.' : 'Événement créé : renseignez maintenant les disponibilités.', { kind: 'success' });
  });
  return form;
}

function attendanceTable(ctx: AppContext, event: SportEvent): HTMLElement {
  const { store, ui } = ctx;
  const state = store.state;
  const complete = withCompleteAttendance(state, event);
  const people = activeParticipants(state).sort(compareNames);
  const byId = new Map(complete.attendance.map((a) => [a.participantId, a]));
  const filter = ui.attendanceFilter.trim().toLowerCase();

  const save = (next: Attendance[]): void => store.dispatch(setAttendance(event.id, next));
  const update = (id: string, patch: Partial<Attendance>): void => {
    save(complete.attendance.map((a) => (a.participantId === id ? { ...a, ...patch } : a)));
  };
  const setAll = (availability: Availability): void => save(complete.attendance.map((a) => ({ ...a, availability })));

  const rows = people
    .filter((p) => !filter || fullName(p).toLowerCase().includes(filter))
    .map((p) => {
      const a = byId.get(p.id);
      if (!a) return null;
      const prof = effectiveDrivingProfile(p, a);
      const label = fullName(p);
      return h('tr', null,
        h('th', { scope: 'row' }, label, p.hasCar ? h('span', { class: 'hint' }, ` · 🚗 ${prof.canDrive ? prof.seats + ' pl.' : 'indispo'}`) : null),
        h('td', null, h('select', { 'aria-label': `Disponibilité de ${label}`, value: a.availability, onchange: (e: Event) => update(p.id, { availability: (e.target as HTMLSelectElement).value as Availability }) },
          AVAILABILITY.map(([v, l]) => h('option', { value: v, selected: v === a.availability }, l)))),
        h('td', null, h('input', { type: 'checkbox', 'aria-label': `${label} se déplace par ses propres moyens`, checked: a.selfTransport, onchange: (e: Event) => update(p.id, { selfTransport: (e.target as HTMLInputElement).checked }) })),
        h('td', null, p.hasCar ? h('select', { 'aria-label': `Voiture de ${label} pour cet événement`, onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; update(p.id, { carAvailableOverride: v === 'default' ? null : v === 'yes' }); } },
          [['default', 'Habituel'], ['yes', 'Disponible'], ['no', 'Indisponible']].map(([v, l]) => h('option', { value: v, selected: v === (a.carAvailableOverride === null ? 'default' : a.carAvailableOverride ? 'yes' : 'no') }, l))) : h('span', { class: 'muted' }, '—')),
        h('td', null, p.hasCar ? h('input', { type: 'number', min: 0, max: 15, step: 1, class: 'narrow', 'aria-label': `Places de ${label} pour cet événement`, placeholder: String(p.seats), value: a.seatsOverride === null ? '' : String(a.seatsOverride),
          onchange: (e: Event) => { const raw = (e.target as HTMLInputElement).value; const n = Number(raw); update(p.id, { seatsOverride: raw === '' || !Number.isInteger(n) || n < 0 ? null : n }); } }) : h('span', { class: 'muted' }, '—')),
        h('td', null, h('input', { type: 'text', list: 'gazetteer', 'aria-label': `Départ spécifique de ${label}`, placeholder: p.home.label || 'domicile', value: a.startOverride?.label ?? '',
          onchange: (e: Event) => {
            const raw = (e.target as HTMLInputElement).value.trim();
            if (raw === '') { update(p.id, { startOverride: null }); return; }
            const fd = new FormData();
            fd.set('o_label', raw);
            const r = readPlace(fd, 'o');
            if (r.place.lat === null) toast(`« ${raw} » : commune inconnue, le départ habituel est conservé pour le calcul.`, { kind: 'error' });
            update(p.id, { startOverride: r.place });
          } })),
      );
    })
    .filter((r): r is HTMLTableRowElement => r !== null);

  return h('div', { class: 'attendance' },
    h('h3', null, 'Disponibilités'),
    h('p', { class: 'hint' }, 'Les modifications sont enregistrées immédiatement. « Sans réponse » n’est pas considéré comme présent. Les colonnes de droite servent aux exceptions pour cet événement.'),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Filtrer', 'aria-label': 'Filtrer les disponibilités', value: ui.attendanceFilter, id: 'att-filter',
        oninput: (e: Event) => { ui.attendanceFilter = (e.target as HTMLInputElement).value; ctx.refresh(); const i = document.getElementById('att-filter') as HTMLInputElement | null; i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); } }),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => setAll('yes') }, 'Tous disponibles'),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => setAll('unknown') }, 'Tout remettre « sans réponse »')),
    rows.length === 0
      ? emptyState('Aucun participant', 'Ajoutez des participants pour saisir leurs disponibilités.')
      : card(null, h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Disponibilités' },
          h('table', { class: 'table' }, h('caption', { class: 'sr-only' }, `Disponibilités pour ${event.name}`),
            h('thead', null, h('tr', null, ['Participant', 'Disponibilité', 'Transport autonome', 'Voiture (cet événement)', 'Places (cet événement)', 'Départ (cet événement)'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, rows)))),
  );
}
