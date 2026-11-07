// filepath: src/ui/map.ts
// Carte SVG hors ligne (aucune tuile, aucun réseau) : points de départ, ramassages et destination par véhicule.
// Projection équirectangulaire corrigée de la latitude : adaptée aux distances régionales d'un déplacement d'équipe.

import type { Participant, Plan, SportEvent } from '../domain/types.ts';
import { fullName, hasCoords } from '../domain/helpers.ts';
import { s } from './dom.ts';
import type { Child } from './dom.ts';

/** Palette distinguable (daltonisme) ; chaque véhicule a aussi un motif de trait et un numéro. */
export const VEHICLE_COLORS = ['#1f6feb', '#d9480f', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#8a6d00', '#495057'];
const DASHES = ['', '8 4', '2 4', '10 3 2 3', '', '8 4', '2 4', '10 3 2 3'];

export const colorOf = (index: number): string => VEHICLE_COLORS[index % VEHICLE_COLORS.length] as string;

export interface MapOptions {
  event: SportEvent;
  plan: Plan;
  participants: Map<string, Participant>;
  hiddenVehicleIds: Set<string>;
  width?: number;
  height?: number;
}

interface Pt { x: number; y: number }

export function renderMap(opts: MapOptions): SVGElement {
  const W = opts.width ?? 720;
  const H = opts.height ?? 460;
  const pad = 36;
  const dest = opts.event.destination;
  const startOf = (id: string): { lat: number; lng: number; label: string } | null => {
    const p = opts.participants.get(id);
    if (!p) return null;
    const att = opts.event.attendance.find((a) => a.participantId === id);
    const place = att?.startOverride && hasCoords(att.startOverride) ? att.startOverride : p.home;
    return hasCoords(place) ? { lat: place.lat, lng: place.lng, label: place.label } : null;
  };

  const pts: Array<{ lat: number; lng: number }> = [];
  if (hasCoords(dest)) pts.push({ lat: dest.lat, lng: dest.lng });
  for (const v of opts.plan.vehicles) for (const id of [v.driverId, ...v.passengerIds]) { const st = startOf(id); if (st) pts.push(st); }

  const root = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'map', 'aria-label': `Carte de l’organisation : ${opts.plan.vehicles.length} véhicule(s) vers ${dest.label || 'la destination'}` });
  root.appendChild(s('rect', { x: 0, y: 0, width: W, height: H, class: 'map-bg', rx: 8 }));
  if (pts.length === 0) {
    root.appendChild(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'map-text' }, 'Aucune coordonnée disponible pour tracer la carte.'));
    return root;
  }

  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * k, 0.02);
  const spanY = Math.max(maxLat - minLat, 0.02);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const project = (lat: number, lng: number): Pt => ({ x: offX + (lng - minLng) * k * scale, y: offY + (maxLat - lat) * scale });

  // Échelle graphique (≈ distance à vol d'oiseau).
  const kmPerDegLat = 111.2;
  const kmPerPx = 1 / (scale / kmPerDegLat);
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200];
  const barKm = candidates.filter((c) => c / kmPerPx < W * 0.3).pop() ?? 1;
  const barPx = barKm / kmPerPx;
  root.append(
    s('line', { x1: 16, y1: H - 16, x2: 16 + barPx, y2: H - 16, class: 'map-scale' }),
    s('text', { x: 16, y: H - 22, class: 'map-text' }, `${barKm} km (vol d’oiseau)`),
  );

  const destPt = hasCoords(dest) ? project(dest.lat, dest.lng) : null;
  opts.plan.vehicles.forEach((v, i) => {
    if (opts.hiddenVehicleIds.has(v.id)) return;
    const color = colorOf(i);
    const stops: Pt[] = [];
    const nodes: Child[] = [];
    [v.driverId, ...v.passengerIds].forEach((id, idx) => {
      const st = startOf(id);
      if (!st) return;
      const pt = project(st.lat, st.lng);
      stops.push(pt);
      const name = opts.participants.get(id) ? fullName(opts.participants.get(id) as Participant) : id;
      const isDriver = idx === 0;
      nodes.push(
        s('g', { class: 'map-node' },
          s('title', null, `${name} — ${isDriver ? 'conducteur' : `ramassage n°${idx}`} (${st.label})`),
          isDriver
            ? s('rect', { x: pt.x - 7, y: pt.y - 7, width: 14, height: 14, fill: color, stroke: '#fff', 'stroke-width': 2 })
            : s('circle', { cx: pt.x, cy: pt.y, r: 5, fill: '#fff', stroke: color, 'stroke-width': 3 }),
          s('text', { x: pt.x + 9, y: pt.y - 8, class: 'map-label' }, isDriver ? `🚗${i + 1} ${name.split(' ')[0] ?? ''}` : (name.split(' ')[0] ?? '')),
        ),
      );
    });
    const route = destPt ? [...stops, destPt] : stops;
    if (route.length >= 2) {
      root.appendChild(s('polyline', { points: route.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-dasharray': DASHES[i % DASHES.length] ?? '', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: 0.9 }));
    }
    for (const n of nodes) root.appendChild(n as Node);
  });

  if (destPt) {
    root.appendChild(
      s('g', { class: 'map-node' },
        s('title', null, `Destination : ${dest.label || dest.address}`),
        s('polygon', { points: starPoints(destPt.x, destPt.y, 11, 5), fill: '#111', stroke: '#fff', 'stroke-width': 1.5 }),
        s('text', { x: destPt.x > W - 110 ? destPt.x - 13 : destPt.x + 13, y: destPt.y + 4, 'text-anchor': destPt.x > W - 110 ? 'end' : 'start', class: 'map-label map-dest' }, dest.label || 'Destination'),
      ),
    );
  }
  return root;
}

function starPoints(cx: number, cy: number, outer: number, inner: number): string {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    out.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return out.join(' ');
}
