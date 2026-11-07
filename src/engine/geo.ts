// filepath: src/engine/geo.ts
// Calcul géographique 100 % local. Les distances sont à VOL D'OISEAU (formule de haversine).
// Ce ne sont PAS des distances routières, et aucun temps de trajet n'est jamais déduit d'elles.
//
// Extension prévue : implémenter l'interface DistanceProvider avec des données routières
// hors ligne (tables pré-calculées) ou un fournisseur externe FACULTATIF. Le moteur ne dépend
// que de cette interface et ne fait jamais d'appel réseau.

import type { GeoPoint } from '../domain/types.ts';

export interface DistanceProvider {
  readonly name: string;
  /** « straight_line » = vol d'oiseau ; « road » = distances routières réelles. */
  readonly kind: 'straight_line' | 'road';
  distanceKm(a: GeoPoint, b: GeoPoint): number;
}

const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Fournisseur par défaut : distance à vol d'oiseau, entièrement local. */
export const straightLineProvider: DistanceProvider = {
  name: 'Vol d’oiseau (haversine)',
  kind: 'straight_line',
  distanceKm: haversineKm,
};

/**
 * Matrice de distances entre des nœuds. Un nœud sans coordonnées reçoit une distance de repli
 * (médiane des distances connues) : il n'influence alors pas le regroupement, et le plan avertit.
 */
export interface DistanceMatrix {
  readonly size: number;
  /** Données brutes (ligne × colonne) pour les boucles critiques du solveur. */
  readonly data: Float64Array;
  get(i: number, j: number): number;
  /** Indices des nœuds sans coordonnées. */
  readonly unlocated: number[];
  readonly fallbackKm: number;
  readonly kind: DistanceProvider['kind'];
}

export function buildDistanceMatrix(points: Array<GeoPoint | null>, provider: DistanceProvider): DistanceMatrix {
  const n = points.length;
  const data = new Float64Array(n * n);
  const known: number[] = [];
  const unlocated: number[] = [];
  points.forEach((p, i) => {
    if (!p) unlocated.push(i);
  });

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = points[i];
      const b = points[j];
      if (a && b) {
        const d = provider.distanceKm(a, b);
        data[i * n + j] = d;
        data[j * n + i] = d;
        known.push(d);
      }
    }
  }

  known.sort((x, y) => x - y);
  const fallbackKm = known.length > 0 ? (known[Math.floor(known.length / 2)] ?? 10) : 10;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!points[i] || !points[j]) {
        data[i * n + j] = fallbackKm;
        data[j * n + i] = fallbackKm;
      }
    }
  }

  return {
    size: n,
    data,
    get: (i, j) => data[i * n + j] ?? 0,
    unlocated,
    fallbackKm,
    kind: provider.kind,
  };
}

/** Distance totale d'un chemin passant par la suite de nœuds donnée. */
export function pathKm(m: DistanceMatrix, nodes: number[]): number {
  let total = 0;
  for (let i = 1; i < nodes.length; i++) total += m.get(nodes[i - 1] as number, nodes[i] as number);
  return total;
}

/** Arrondi d'affichage à 0,1 km. */
export function roundKm(km: number): number {
  return Math.round(km * 10) / 10;
}
