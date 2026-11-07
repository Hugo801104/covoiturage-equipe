// filepath: src/domain/gazetteer.ts
// Mini-annuaire de communes embarqué : permet de renseigner des coordonnées SANS service externe.
// Les coordonnées sont celles du centre de la commune (approximatives, ±1 km) : suffisantes pour
// un regroupement à vol d'oiseau, modifiables à la main pour plus de précision.

import type { Place } from './types.ts';

export interface GazetteerEntry {
  name: string;
  lat: number;
  lng: number;
  area: string;
}

export const GAZETTEER: GazetteerEntry[] = [
  // Loire-Atlantique
  { name: 'Nantes', lat: 47.2184, lng: -1.5536, area: '44' },
  { name: 'Rezé', lat: 47.1819, lng: -1.5497, area: '44' },
  { name: 'Vertou', lat: 47.1686, lng: -1.4694, area: '44' },
  { name: 'Saint-Sébastien-sur-Loire', lat: 47.2058, lng: -1.4999, area: '44' },
  { name: 'Saint-Herblain', lat: 47.2122, lng: -1.6488, area: '44' },
  { name: 'Orvault', lat: 47.2717, lng: -1.6203, area: '44' },
  { name: 'Carquefou', lat: 47.2986, lng: -1.4903, area: '44' },
  { name: 'Bouguenais', lat: 47.1783, lng: -1.6222, area: '44' },
  { name: 'Couëron', lat: 47.2155, lng: -1.7244, area: '44' },
  { name: 'Sainte-Luce-sur-Loire', lat: 47.2556, lng: -1.4806, area: '44' },
  { name: 'Basse-Goulaine', lat: 47.2117, lng: -1.4631, area: '44' },
  { name: 'La Chapelle-sur-Erdre', lat: 47.2993, lng: -1.5531, area: '44' },
  { name: 'Sautron', lat: 47.2638, lng: -1.6694, area: '44' },
  { name: 'Les Sorinières', lat: 47.1469, lng: -1.5253, area: '44' },
  { name: 'Thouaré-sur-Loire', lat: 47.2833, lng: -1.4333, area: '44' },
  { name: 'Saint-Étienne-de-Montluc', lat: 47.2755, lng: -1.775, area: '44' },
  { name: 'Le Pellerin', lat: 47.2, lng: -1.752, area: '44' },
  { name: 'Indre', lat: 47.198, lng: -1.674, area: '44' },
  { name: 'Héric', lat: 47.3586, lng: -1.6664, area: '44' },
  { name: 'Nort-sur-Erdre', lat: 47.4412, lng: -1.5042, area: '44' },
  { name: 'Blain', lat: 47.476, lng: -1.762, area: '44' },
  { name: 'Savenay', lat: 47.36, lng: -1.946, area: '44' },
  { name: 'Saint-Nazaire', lat: 47.2733, lng: -2.2137, area: '44' },
  { name: 'Montoir-de-Bretagne', lat: 47.315, lng: -2.147, area: '44' },
  { name: 'Guérande', lat: 47.328, lng: -2.429, area: '44' },
  { name: 'La Baule-Escoublac', lat: 47.287, lng: -2.393, area: '44' },
  { name: 'Pornic', lat: 47.1154, lng: -2.1025, area: '44' },
  { name: 'Machecoul', lat: 46.993, lng: -1.819, area: '44' },
  { name: 'Saint-Philbert-de-Grand-Lieu', lat: 47.0364, lng: -1.6359, area: '44' },
  { name: 'Clisson', lat: 47.0871, lng: -1.2788, area: '44' },
  { name: 'Vallet', lat: 47.1626, lng: -1.2653, area: '44' },
  { name: 'Ancenis', lat: 47.366, lng: -1.177, area: '44' },
  { name: 'Châteaubriant', lat: 47.717, lng: -1.376, area: '44' },
  // Maine-et-Loire, Vendée, Sarthe, Mayenne
  { name: 'Angers', lat: 47.4784, lng: -0.5632, area: '49' },
  { name: 'Cholet', lat: 47.0606, lng: -0.8786, area: '49' },
  { name: 'Saumur', lat: 47.26, lng: -0.077, area: '49' },
  { name: 'La Roche-sur-Yon', lat: 46.6705, lng: -1.426, area: '85' },
  { name: 'Les Sables-d’Olonne', lat: 46.497, lng: -1.783, area: '85' },
  { name: 'Challans', lat: 46.845, lng: -1.877, area: '85' },
  { name: 'Fontenay-le-Comte', lat: 46.467, lng: -0.807, area: '85' },
  { name: 'Le Mans', lat: 48.0061, lng: 0.1996, area: '72' },
  { name: 'Laval', lat: 48.0698, lng: -0.77, area: '53' },
  // Bretagne
  { name: 'Rennes', lat: 48.1173, lng: -1.6778, area: '35' },
  { name: 'Redon', lat: 47.651, lng: -2.084, area: '35' },
  { name: 'Saint-Malo', lat: 48.6493, lng: -2.007, area: '35' },
  { name: 'Vannes', lat: 47.6582, lng: -2.7608, area: '56' },
  { name: 'Lorient', lat: 47.7482, lng: -3.3667, area: '56' },
  { name: 'Quimper', lat: 47.996, lng: -4.1, area: '29' },
  { name: 'Brest', lat: 48.3904, lng: -4.4861, area: '29' },
  { name: 'Saint-Brieuc', lat: 48.5136, lng: -2.765, area: '22' },
  // Autres grandes villes
  { name: 'Tours', lat: 47.3941, lng: 0.6848, area: '37' },
  { name: 'Orléans', lat: 47.9029, lng: 1.9093, area: '45' },
  { name: 'Poitiers', lat: 46.5802, lng: 0.3404, area: '86' },
  { name: 'Niort', lat: 46.3237, lng: -0.4588, area: '79' },
  { name: 'La Rochelle', lat: 46.1603, lng: -1.1511, area: '17' },
  { name: 'Angoulême', lat: 45.6484, lng: 0.1562, area: '16' },
  { name: 'Caen', lat: 49.1829, lng: -0.3707, area: '14' },
  { name: 'Rouen', lat: 49.4432, lng: 1.0993, area: '76' },
  { name: 'Paris', lat: 48.8566, lng: 2.3522, area: '75' },
  { name: 'Bordeaux', lat: 44.8378, lng: -0.5792, area: '33' },
  { name: 'Toulouse', lat: 43.6047, lng: 1.4442, area: '31' },
  { name: 'Lyon', lat: 45.764, lng: 4.8357, area: '69' },
  { name: 'Lille', lat: 50.6292, lng: 3.0573, area: '59' },
  { name: 'Strasbourg', lat: 48.5734, lng: 7.7521, area: '67' },
  { name: 'Montpellier', lat: 43.6108, lng: 3.8767, area: '34' },
  { name: 'Marseille', lat: 43.2965, lng: 5.3698, area: '13' },
  { name: 'Nice', lat: 43.7102, lng: 7.262, area: '06' },
];

/** Minuscules, sans accents, ponctuation → espaces, « st/ste » développés. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w === 'st' ? 'saint' : w === 'ste' ? 'sainte' : w))
    .join(' ');
}

const INDEX = GAZETTEER.map((e) => ({ entry: e, key: normalizeName(e.name) }));

/** Suggestions pour l'autocomplétion (préfixe puis sous-chaîne). */
export function searchPlaces(query: string, limit = 8): GazetteerEntry[] {
  const q = normalizeName(query);
  if (q.length < 2) return [];
  const starts = INDEX.filter((x) => x.key.startsWith(q));
  const contains = INDEX.filter((x) => !x.key.startsWith(q) && x.key.includes(q));
  return [...starts, ...contains].slice(0, limit).map((x) => x.entry);
}

/**
 * Retrouve une commune connue dans un libellé ou une adresse libre
 * (ex. « 12 rue des Lilas, 44400 Rezé »). Retient la correspondance la plus longue.
 */
export function lookupPlace(text: string): GazetteerEntry | null {
  const t = ` ${normalizeName(text)} `;
  if (t.trim() === '') return null;
  let best: { entry: GazetteerEntry; len: number } | null = null;
  for (const x of INDEX) {
    if (t.includes(` ${x.key} `) && (!best || x.key.length > best.len)) best = { entry: x.entry, len: x.key.length };
  }
  return best ? best.entry : null;
}

export function placeFromEntry(entry: GazetteerEntry, address = ''): Place {
  return { label: entry.name, address, lat: entry.lat, lng: entry.lng };
}
