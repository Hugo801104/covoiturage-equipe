// filepath: src/ui/components.ts
// Composants réutilisables : champs de formulaire accessibles, saisie de lieu, états vides, badges.

import type { Child } from './dom.ts';
import { h } from './dom.ts';
import type { Place } from '../domain/types.ts';
import { GAZETTEER, lookupPlace } from '../domain/gazetteer.ts';

let uid = 0;
export const nextId = (prefix = 'f'): string => `${prefix}-${++uid}`;

export interface FieldOptions {
  hint?: string;
  required?: boolean;
  type?: string;
  value?: string | number;
  min?: number;
  max?: number;
  step?: number | string;
  placeholder?: string;
  list?: string;
  autocomplete?: string;
  inputmode?: string;
}

/** Champ texte/nombre avec étiquette et aide, correctement relié (for/id, aria-describedby). */
export function field(name: string, label: string, opts: FieldOptions = {}): HTMLElement {
  const id = nextId(name);
  const hintId = `${id}-hint`;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, label, opts.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    h('input', {
      id,
      name,
      type: opts.type ?? 'text',
      required: opts.required ? '' : null,
      value: opts.value !== undefined ? String(opts.value) : '',
      min: opts.min,
      max: opts.max,
      step: opts.step,
      placeholder: opts.placeholder,
      list: opts.list,
      autocomplete: opts.autocomplete ?? 'off',
      inputmode: opts.inputmode,
      'aria-describedby': opts.hint ? hintId : null,
    }),
    opts.hint ? h('small', { id: hintId, class: 'hint' }, opts.hint) : null,
  );
}

export function textarea(name: string, label: string, value: string, hint?: string): HTMLElement {
  const id = nextId(name);
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, label),
    h('textarea', { id, name, rows: 3, 'aria-describedby': hint ? `${id}-hint` : null }, value),
    hint ? h('small', { id: `${id}-hint`, class: 'hint' }, hint) : null,
  );
}

export function selectField(
  name: string,
  label: string,
  options: Array<[string, string]>,
  value: string,
  hint?: string,
): HTMLElement {
  const id = nextId(name);
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, label),
    h('select', { id, name, value, 'aria-describedby': hint ? `${id}-hint` : null }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))),
    hint ? h('small', { id: `${id}-hint`, class: 'hint' }, hint) : null,
  );
}

export function checkField(name: string, label: string, checked: boolean, hint?: string): HTMLElement {
  const id = nextId(name);
  return h(
    'div',
    { class: 'field field-check' },
    h('input', { id, name, type: 'checkbox', checked, 'aria-describedby': hint ? `${id}-hint` : null }),
    h('label', { for: id }, label),
    hint ? h('small', { id: `${id}-hint`, class: 'hint' }, hint) : null,
  );
}

/** <datalist> partagée des communes connues hors ligne. */
export function gazetteerDatalist(): HTMLElement {
  return h('datalist', { id: 'gazetteer' }, GAZETTEER.map((g) => h('option', { value: g.name }, g.area)));
}

/**
 * Bloc « lieu » : libellé (avec suggestions de communes), adresse, latitude, longitude.
 * Si les coordonnées sont vides, elles sont déduites de la commune connue (approximation du centre-ville).
 */
export function placeFields(prefix: string, title: string, place: Place, required = false): HTMLElement {
  const root = h('fieldset', { class: 'fieldset place' }, h('legend', null, title));
  const label = field(`${prefix}_label`, 'Lieu / commune', { value: place.label, list: 'gazetteer', required, placeholder: 'ex. Rezé' });
  const address = field(`${prefix}_address`, 'Adresse (facultatif)', { value: place.address, autocomplete: 'street-address' });
  const lat = field(`${prefix}_lat`, 'Latitude', { value: place.lat ?? '', inputmode: 'decimal', placeholder: '47.2184' });
  const lng = field(`${prefix}_lng`, 'Longitude', { value: place.lng ?? '', inputmode: 'decimal', placeholder: '-1.5536' });
  const status = h('p', { class: 'hint', role: 'status' });
  const input = (f: HTMLElement): HTMLInputElement => f.querySelector('input') as HTMLInputElement;

  const fill = (): void => {
    const found = lookupPlace(`${input(label).value} ${input(address).value}`);
    if (!found) {
      status.textContent = 'Commune non reconnue : saisissez latitude et longitude (clic droit sur une carte en ligne, « Plus d’infos »).';
      return;
    }
    input(lat).value = String(found.lat);
    input(lng).value = String(found.lng);
    status.textContent = `Coordonnées approximatives de ${found.name} (centre-ville). Précisez-les pour de meilleurs itinéraires.`;
  };
  input(label).addEventListener('change', () => {
    if (input(lat).value === '' && input(lng).value === '') fill();
  });
  root.append(
    label,
    address,
    h('div', { class: 'row' }, lat, lng),
    h('button', { type: 'button', class: 'btn btn-small', onclick: fill }, 'Déduire les coordonnées de la commune'),
    status,
  );
  return root;
}

export interface ReadPlaceResult {
  place: Place;
  error: string | null;
}

/** Relit un bloc « lieu » depuis un FormData. Les coordonnées manquantes sont complétées par le gazetteer. */
export function readPlace(fd: FormData, prefix: string, required = false): ReadPlaceResult {
  const text = (k: string): string => String(fd.get(`${prefix}_${k}`) ?? '').trim();
  const label = text('label');
  const address = text('address');
  let lat: number | null = null;
  let lng: number | null = null;
  const latS = text('lat').replace(',', '.');
  const lngS = text('lng').replace(',', '.');
  if (latS !== '' || lngS !== '') {
    lat = Number(latS);
    lng = Number(lngS);
    if (latS === '' || lngS === '' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { place: { label, address, lat: null, lng: null }, error: 'Latitude et longitude doivent être deux nombres.' };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { place: { label, address, lat: null, lng: null }, error: 'Coordonnées hors plage (latitude −90…90, longitude −180…180).' };
    }
  } else if (label !== '' || address !== '') {
    const found = lookupPlace(`${label} ${address}`);
    if (found) {
      lat = found.lat;
      lng = found.lng;
    }
  }
  if (required && label === '' && address === '') return { place: { label, address, lat, lng }, error: 'Le lieu est obligatoire.' };
  return { place: { label, address, lat, lng }, error: null };
}

// ───────────────────────── Présentation ─────────────────────────

export function pageHeader(title: string, subtitle?: string, actions?: Child): HTMLElement {
  return h(
    'header',
    { class: 'page-header' },
    h('div', null, h('h1', null, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

export function emptyState(title: string, text: string, actions?: Child): HTMLElement {
  return h('div', { class: 'empty' }, h('h2', null, title), h('p', { class: 'muted' }, text), actions ? h('div', { class: 'row-wrap' }, actions) : null);
}

export type BadgeKind = 'ok' | 'warn' | 'error' | 'info' | 'neutral';

export function badge(text: string, kind: BadgeKind = 'neutral', title?: string): HTMLElement {
  return h('span', { class: `badge badge-${kind}`, title: title ?? null }, text);
}

export function errorBox(messages: string[]): HTMLElement | null {
  if (messages.length === 0) return null;
  return h('div', { class: 'alert alert-error', role: 'alert' }, h('ul', null, messages.map((m) => h('li', null, m))));
}

export function card(title: string | null, ...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, title ? h('h2', null, title) : null, children);
}

export function stat(label: string, value: string, hint?: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), hint ? h('div', { class: 'hint' }, hint) : null);
}
