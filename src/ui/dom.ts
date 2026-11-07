// filepath: src/ui/dom.ts
// Mini-bibliothèque DOM : création d'éléments typés, SVG, boîtes de dialogue accessibles, notifications.
// Aucune dépendance : l'interface reste un simple fichier JavaScript autonome.

export type Child = Node | string | number | boolean | null | undefined | Child[];
export type Props = Record<string, unknown>;

const PROPERTY_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate', 'readOnly', 'open']);

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
    return;
  }
  parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
}

function applyProps(el: Element, props: Props, deferred: Array<[string, unknown]>): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      if (PROPERTY_KEYS.has(key)) deferred.push([key, false]);
      continue;
    }
    if (key === 'class') el.setAttribute('class', String(value));
    else if (key === 'style') el.setAttribute('style', String(value));
    else if (key === 'dataset') Object.assign((el as HTMLElement).dataset, value as Record<string, string>);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (PROPERTY_KEYS.has(key)) deferred.push([key, value]);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const deferred: Array<[string, unknown]> = [];
  if (props) applyProps(el, props, deferred);
  for (const c of children) append(el, c);
  // `value` d'un <select> doit être posé après la création des <option>.
  for (const [k, v] of deferred) (el as unknown as Record<string, unknown>)[k] = v;
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag: string, props?: Props | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      else el.setAttribute(key, String(value));
    }
  }
  for (const c of children) append(el, c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ───────────────────────── Notifications ─────────────────────────

export interface ToastOptions {
  kind?: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
  durationMs?: number;
}

let toastHost: HTMLElement | null = null;

export function mountToastHost(host: HTMLElement): void {
  toastHost = host;
}

/** Message éphémère annoncé aux lecteurs d'écran (zone aria-live). Les erreurs restent plus longtemps. */
export function toast(message: string, options: ToastOptions = {}): void {
  if (!toastHost) return;
  const kind = options.kind ?? 'info';
  const el = h('div', { class: `toast toast-${kind}` }, h('span', null, message));
  const remove = (): void => el.remove();
  if (options.action) {
    const { label, run } = options.action;
    el.appendChild(
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => { run(); remove(); } }, label),
    );
  }
  el.appendChild(h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'aria-label': 'Fermer la notification', onclick: remove }, '✕'));
  toastHost.appendChild(el);
  window.setTimeout(remove, options.durationMs ?? (kind === 'error' ? 9000 : options.action ? 8000 : 4500));
}

// ───────────────────────── Dialogue de confirmation ─────────────────────────

export interface ConfirmOptions {
  title: string;
  message: string | Node;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Boîte de dialogue modale native (<dialog>) : focus piégé, Échap = annuler. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' });
    const finish = (value: boolean): void => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); finish(false); });
    dialog.append(
      h('h2', { id: 'dlg-title' }, opts.title),
      h('div', { class: 'dialog-body' }, opts.message),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => finish(false) }, opts.cancelLabel ?? 'Annuler'),
        h('button', { type: 'button', class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => finish(true) }, opts.confirmLabel ?? 'Confirmer'),
      ),
    );
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

// ───────────────────────── Fichiers ─────────────────────────

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, class: 'sr-only' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    reader.readAsText(file, 'utf-8');
  });
}

export function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'equipe';
}
