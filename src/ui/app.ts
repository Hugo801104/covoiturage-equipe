// filepath: src/ui/app.ts
// Coque de l'application : ouverture du stockage, routage par hash, navigation, indicateur d'enregistrement.

import { createBestStorage } from '../data/storage.ts';
import { Store } from '../data/store.ts';
import { todayDay } from '../domain/helpers.ts';
import type { AppContext, Route, RouteName } from './context.ts';
import { createUiState, parseRoute, routeHash } from './context.ts';
import { clear, h, mountToastHost, toast } from './dom.ts';
import { renderDashboard } from './views/dashboard.ts';
import { renderData } from './views/data.ts';
import { renderEvents } from './views/events.ts';
import { renderHistory } from './views/history.ts';
import { renderOrganisation } from './views/organisation.ts';
import { renderParticipants } from './views/participants.ts';

const NAV: Array<{ name: RouteName; label: string; icon: string }> = [
  { name: 'dashboard', label: 'Accueil', icon: '🏠' },
  { name: 'participants', label: 'Participants', icon: '👥' },
  { name: 'events', label: 'Événements', icon: '📅' },
  { name: 'organisation', label: 'Organisation', icon: '🚗' },
  { name: 'history', label: 'Historique', icon: '📊' },
  { name: 'data', label: 'Données', icon: '💾' },
];

const VIEWS: Record<RouteName, (ctx: AppContext) => HTMLElement> = {
  dashboard: renderDashboard,
  participants: renderParticipants,
  events: renderEvents,
  organisation: renderOrganisation,
  history: renderHistory,
  data: renderData,
};

export async function start(root: HTMLElement): Promise<void> {
  root.replaceChildren(h('p', { class: 'boot', role: 'status' }, 'Chargement de vos données…'));
  let store: Store;
  try {
    store = await Store.open(await createBestStorage());
  } catch (e) {
    root.replaceChildren(h('div', { class: 'alert alert-error', role: 'alert' }, `Impossible d’ouvrir le stockage local : ${e instanceof Error ? e.message : String(e)}`));
    return;
  }

  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  mountToastHost(toasts);
  const main = h('main', { id: 'main', tabindex: -1 });
  const status = h('span', { class: 'save-status', role: 'status' });
  const undoBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => { if (store.undo()) toast('Dernière modification annulée.'); } }, '↶ Annuler');
  const nav = h('nav', { class: 'nav', 'aria-label': 'Navigation principale' });

  const ctx: AppContext = {
    store,
    ui: createUiState(),
    route: parseRoute(location.hash),
    today: todayDay,
    navigate: (name, param = null) => { location.hash = routeHash(name, param); },
    refresh: () => render(),
  };

  function renderNav(): void {
    clear(nav);
    for (const item of NAV) {
      const current = ctx.route.name === item.name;
      nav.appendChild(h('a', { href: routeHash(item.name), class: `nav-link${current ? ' current' : ''}`, 'aria-current': current ? 'page' : null }, h('span', { 'aria-hidden': 'true', class: 'nav-icon' }, item.icon), h('span', null, item.label)));
    }
  }

  function renderStatus(): void {
    const labels = { idle: 'Prêt', saving: 'Enregistrement…', saved: '✓ Enregistré sur cet appareil', error: '⚠ Échec de l’enregistrement' } as const;
    status.textContent = store.durable ? labels[store.saveStatus] : '⚠ Stockage non durable : exportez vos données';
    status.className = `save-status save-${store.saveStatus}${store.durable ? '' : ' save-error'}`;
    undoBtn.disabled = !store.canUndo;
  }

  function render(): void {
    const y = window.scrollY;
    renderNav();
    renderStatus();
    let view: HTMLElement;
    try {
      view = VIEWS[ctx.route.name](ctx);
    } catch (e) {
      console.error(e);
      view = h('div', { class: 'alert alert-error', role: 'alert' }, h('strong', null, 'Cet écran a rencontré une erreur. '), `${e instanceof Error ? e.message : String(e)} — vos données ne sont pas affectées.`);
    }
    main.replaceChildren(view);
    window.scrollTo({ top: y });
  }

  let lastState = store.state;
  store.subscribe(() => {
    renderStatus();
    if (store.state !== lastState) {
      lastState = store.state;
      render();
    }
  });

  window.addEventListener('hashchange', () => {
    const next: Route = parseRoute(location.hash);
    ctx.route = next;
    if (next.name !== 'events') ctx.ui.eventEditId = null;
    render();
    window.scrollTo({ top: 0 });
    main.focus({ preventScroll: true });
  });

  window.addEventListener('beforeunload', (ev) => {
    if (store.saveStatus === 'saving') {
      void store.flush();
      ev.preventDefault();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void store.flush(); });
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !(ev.target instanceof HTMLInputElement) && !(ev.target instanceof HTMLTextAreaElement)) {
      if (store.undo()) { ev.preventDefault(); toast('Dernière modification annulée.'); }
    }
  });

  root.replaceChildren(
    h('a', { href: '#main', class: 'skip-link' }, 'Aller au contenu'),
    h('header', { class: 'topbar' }, h('div', { class: 'brand' }, h('span', { 'aria-hidden': 'true' }, '🚗'), h('strong', null, store.state.team.name)), h('div', { class: 'topbar-right' }, status, undoBtn)),
    nav, main, toasts);
  if (!location.hash) history.replaceState(null, '', routeHash('dashboard'));
  render();

  if (store.startupNotice) toast(store.startupNotice, { kind: store.isNew ? 'error' : 'info', durationMs: 12000 });
  void requestPersistence();
  registerWorker();
}

async function requestPersistence(): Promise<void> {
  try {
    const storage = (navigator as Navigator & { storage?: StorageManager }).storage;
    if (storage?.persist && !(await storage.persisted())) await storage.persist();
  } catch { /* facultatif */ }
}

function registerWorker(): void {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js').catch(() => undefined);
}
