// filepath: src/ui/views/participants.ts
// Écran Participants : liste filtrable, statistiques de conduite, formulaire d'ajout/édition.

import type { Participant, DrivingPreference } from '../../domain/types.ts';
import { DRIVING_PREFERENCE_LABELS, DRIVING_PREFERENCE_SHORT, createParticipant, fullName, hasCoords } from '../../domain/helpers.ts';
import { computeHistory } from '../../engine/index.ts';
import { activeParticipants, deleteParticipant, doneEvents, restoreParticipant, upsertParticipant } from '../../data/actions.ts';
import type { AppContext } from '../context.ts';
import { h, toast } from '../dom.ts';
import {
  badge, card, checkField, emptyState, errorBox, field, gazetteerDatalist, pageHeader, placeFields, readPlace, selectField, textarea,
} from '../components.ts';
import { compareNames, fmtKm, fmtNum, fmtSigned } from '../format.ts';

const PREFERENCES = Object.entries(DRIVING_PREFERENCE_LABELS) as Array<[DrivingPreference, string]>;

export function renderParticipants(ctx: AppContext): HTMLElement {
  const { store, ui } = ctx;
  const state = store.state;
  const people = activeParticipants(state).sort(compareNames);
  const history = computeHistory(state.participants, doneEvents(state));
  const filter = ui.participantFilter.trim().toLowerCase();
  const shown = filter ? people.filter((p) => fullName(p).toLowerCase().includes(filter) || p.home.label.toLowerCase().includes(filter)) : people;

  const root = h('div', { class: 'view' });
  root.appendChild(
    pageHeader(
      'Participants',
      `${people.length} personne${people.length > 1 ? 's' : ''} · ${people.filter((p) => p.hasCar && p.carAvailable).length} voiture(s) disponible(s)`,
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { ui.participantEditId = 'new'; ctx.refresh(); } }, '+ Ajouter un participant'),
    ),
  );

  if (ui.participantEditId !== null) {
    const editing = ui.participantEditId === 'new' ? null : state.participants.find((p) => p.id === ui.participantEditId) ?? null;
    root.appendChild(participantForm(ctx, editing));
  }

  if (people.length === 0) {
    root.appendChild(emptyState('Aucun participant', 'Ajoutez les membres de l’équipe, ou chargez les données de démonstration depuis l’écran « Données ».', h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { ui.participantEditId = 'new'; ctx.refresh(); } }, 'Ajouter le premier participant')));
    return root;
  }

  const search = h('input', {
    type: 'search', id: 'p-filter', value: ui.participantFilter, placeholder: 'Filtrer par nom ou commune', 'aria-label': 'Filtrer les participants',
    oninput: (e: Event) => {
      ui.participantFilter = (e.target as HTMLInputElement).value;
      ctx.refresh();
      const again = document.getElementById('p-filter') as HTMLInputElement | null;
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    },
  });
  root.appendChild(h('div', { class: 'toolbar' }, search));

  if (shown.length === 0) {
    root.appendChild(emptyState('Aucun résultat', 'Aucun participant ne correspond à ce filtre.'));
    return root;
  }

  const rows = shown.map((p) => {
    const hist = history.get(p.id);
    const noCoords = !hasCoords(p.home);
    return h(
      'tr',
      null,
      h('th', { scope: 'row' }, fullName(p), p.priorityDriver ? h('span', null, ' ', badge('prioritaire', 'info')) : null, p.neverDrive ? h('span', null, ' ', badge('ne conduit jamais', 'warn')) : null),
      h('td', null, p.home.label || '—', noCoords ? h('span', null, ' ', badge('sans coordonnées', 'warn', 'Le participant sera placé en dernier dans les trajets')) : null),
      h('td', null, p.hasCar ? `${p.carAvailable ? '🚗' : '🚗 indisponible'} ${p.seats} pl.` : '—'),
      h('td', null, DRIVING_PREFERENCE_SHORT[p.drivingPreference]),
      h('td', { class: 'num' }, hist ? `${hist.timesDriver} / ${hist.eventsAttended}` : '0 / 0'),
      h('td', { class: 'num' }, hist ? fmtSigned(hist.driveBalance) : '0', ),
      h('td', { class: 'num' }, hist ? fmtKm(hist.kmDriver) : '0 km'),
      h(
        'td',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Modifier ${fullName(p)}`, onclick: () => { ui.participantEditId = p.id; ctx.refresh(); window.scrollTo({ top: 0 }); } }, 'Modifier'),
        h('button', {
          type: 'button', class: 'btn btn-small btn-danger-ghost', 'aria-label': `Supprimer ${fullName(p)}`,
          onclick: () => {
            store.dispatch(deleteParticipant(p.id));
            toast(`${fullName(p)} supprimé(e). Son historique est conservé.`, { action: { label: 'Annuler', run: () => store.dispatch(restoreParticipant(p.id)) } });
          },
        }, 'Supprimer'),
      ),
    );
  });

  root.appendChild(
    card(
      null,
      h(
        'div',
        { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Liste des participants' },
        h(
          'table',
          { class: 'table' },
          h('caption', { class: 'sr-only' }, 'Participants, capacités de conduite et statistiques'),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, 'Nom'), h('th', { scope: 'col' }, 'Départ'), h('th', { scope: 'col' }, 'Voiture'), h('th', { scope: 'col' }, 'Conduite'),
            h('th', { scope: 'col', class: 'num', title: 'Trajets conduits / événements auxquels il a participé' }, 'Conduits'),
            h('th', { scope: 'col', class: 'num', title: 'Écart à la part équitable : positif = a plus conduit que sa part' }, 'Écart'),
            h('th', { scope: 'col', class: 'num' }, 'Km conduits'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
          h('tbody', null, rows),
        ),
      ),
      h('p', { class: 'hint' }, `Écart = trajets conduits − part équitable (${fmtNum(1)} = un trajet de plus que sa part). Calculé sur les événements terminés.`),
    ),
  );
  return root;
}

function participantForm(ctx: AppContext, existing: Participant | null): HTMLElement {
  const { store, ui } = ctx;
  const base = existing ?? createParticipant();
  const errors = h('div');
  const form = h('form', { class: 'card form', novalidate: '', 'aria-label': existing ? 'Modifier un participant' : 'Nouveau participant' });

  const cancel = (): void => { ui.participantEditId = null; ctx.refresh(); };

  form.append(
    h('h2', null, existing ? `Modifier ${fullName(base)}` : 'Nouveau participant'),
    gazetteerDatalist(),
    h('div', { class: 'row' }, field('firstName', 'Prénom', { value: base.firstName, required: true, autocomplete: 'given-name' }), field('lastName', 'Nom', { value: base.lastName, autocomplete: 'family-name' })),
    placeFields('home', 'Lieu de départ habituel', base.home, true),
    h(
      'fieldset', { class: 'fieldset' },
      h('legend', null, 'Voiture'),
      checkField('hasCar', 'Possède une voiture', base.hasCar),
      checkField('carAvailable', 'Peut la mettre à disposition de l’équipe', base.carAvailable, 'Avoir une voiture n’oblige pas à conduire : la volonté se règle ci-dessous.'),
      field('seats', 'Places passagers (hors conducteur)', { type: 'number', min: 0, max: 15, step: 1, value: base.seats, inputmode: 'numeric' }),
    ),
    h(
      'fieldset', { class: 'fieldset' },
      h('legend', null, 'Volonté de conduire'),
      selectField('drivingPreference', 'Préférence', PREFERENCES, base.drivingPreference),
      checkField('priorityDriver', 'Conducteur prioritaire (désigné par le responsable)', base.priorityDriver),
      checkField('neverDrive', 'Ne doit jamais conduire (contrainte absolue)', base.neverDrive),
      checkField('acceptLastResort', 'Si « préfère être passager » : accepte de conduire en dernier recours', base.acceptLastResort),
    ),
    textarea('notes', 'Notes / contraintes', base.notes, 'Ex. : ne peut pas partir avant 8 h, mineur accompagné…'),
    errors,
    h('div', { class: 'row-wrap' }, h('button', { type: 'submit', class: 'btn btn-primary' }, existing ? 'Enregistrer' : 'Ajouter'), h('button', { type: 'button', class: 'btn', onclick: cancel }, 'Annuler')),
  );

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const messages: string[] = [];
    const firstName = String(fd.get('firstName') ?? '').trim();
    const lastName = String(fd.get('lastName') ?? '').trim();
    if (firstName === '' && lastName === '') messages.push('Saisissez au moins un prénom ou un nom.');
    const place = readPlace(fd, 'home', true);
    if (place.error) messages.push(place.error);
    const seats = Number(String(fd.get('seats') ?? '0').replace(',', '.'));
    if (!Number.isInteger(seats) || seats < 0 || seats > 15) messages.push('Le nombre de places doit être un entier entre 0 et 15.');
    const hasCar = fd.has('hasCar');
    const carAvailable = fd.has('carAvailable');
    if (hasCar && carAvailable && seats === 0) messages.push('Une voiture disponible doit avoir au moins 1 place passager.');
    if (fd.has('neverDrive') && fd.get('drivingPreference') !== 'refuse' && fd.get('drivingPreference') !== 'prefer_passenger') {
      // Cohérence douce : on n'empêche pas, mais on avertit via toast après enregistrement.
    }
    errors.replaceChildren(...(errorBox(messages) ? [errorBox(messages) as HTMLElement] : []));
    if (messages.length > 0) {
      (errors.firstElementChild as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const next: Participant = {
      ...base,
      firstName,
      lastName,
      home: place.place,
      hasCar,
      carAvailable: hasCar && carAvailable,
      seats,
      drivingPreference: String(fd.get('drivingPreference')) as DrivingPreference,
      priorityDriver: fd.has('priorityDriver'),
      neverDrive: fd.has('neverDrive'),
      acceptLastResort: fd.has('acceptLastResort'),
      notes: String(fd.get('notes') ?? '').trim(),
    };
    store.dispatch(upsertParticipant(next));
    ui.participantEditId = null;
    toast(existing ? 'Participant mis à jour.' : `${fullName(next)} ajouté(e) à l’équipe.`, { kind: 'success' });
    if (!hasCoordsOf(next)) toast('Aucune coordonnée pour ce lieu : le participant sera difficile à placer. Précisez latitude/longitude.', { kind: 'error' });
  });

  queueMicrotask(() => (form.querySelector('input[name="firstName"]') as HTMLInputElement | null)?.focus());
  return form;
}

function hasCoordsOf(p: Participant): boolean {
  return hasCoords(p.home);
}
