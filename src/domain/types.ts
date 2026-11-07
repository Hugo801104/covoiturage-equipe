// filepath: src/domain/types.ts
// Modèle de domaine du covoiturage sportif. Aucune dépendance (ni DOM, ni stockage) :
// ces types sont partagés par le moteur, la couche données et l'interface.

/** Date ISO complète (ex. 2026-11-06T10:00:00.000Z). */
export type ISODateTime = string;
/** Date calendaire AAAA-MM-JJ. */
export type ISODay = string;

/**
 * Niveau de préférence de conduite.
 * Distinct de la capacité à conduire (avoir une voiture disponible) :
 * un participant avec voiture peut très bien être « refuse ».
 */
export type DrivingPreference =
  | 'priority' // « Je souhaite conduire en priorité »
  | 'volunteer' // « Je suis volontaire »
  | 'indifferent' // « Je suis indifférent »
  | 'prefer_passenger' // « Je préfère être passager » (dernier recours si accepté)
  | 'refuse'; // « Je ne souhaite pas conduire » (jamais affecté)

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Un lieu (domicile, départ ponctuel, destination). Coordonnées facultatives. */
export interface Place {
  label: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export interface Participant {
  id: string;
  firstName: string;
  lastName: string;
  /** Lieu de départ habituel. */
  home: Place;
  /** Possède une voiture. */
  hasCar: boolean;
  /** Peut mettre sa voiture à disposition de l'équipe. */
  carAvailable: boolean;
  /** Places passagers (hors conducteur). */
  seats: number;
  drivingPreference: DrivingPreference;
  /** Conducteur prioritaire désigné par le responsable (bonus de priorité). */
  priorityDriver: boolean;
  /** Ne doit jamais être affecté à la conduite (contrainte dure). */
  neverDrive: boolean;
  /**
   * Pour « prefer_passenger » : accepte de conduire en dernier recours
   * si le moteur n'a pas d'autre solution.
   */
  acceptLastResort: boolean;
  /** Contraintes ou préférences complémentaires (texte libre). */
  notes: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /** Suppression logique (tombstone) : permet de propager une suppression à l'import. */
  deletedAt: ISODateTime | null;
}

export type Availability = 'yes' | 'no' | 'unknown';

/** Réponse d'un participant pour un événement donné. */
export interface Attendance {
  participantId: string;
  availability: Availability;
  /** Se déplace par ses propres moyens : exclu du covoiturage mais compté comme présent. */
  selfTransport: boolean;
  /** Lieu de départ spécifique à cet événement (sinon domicile). */
  startOverride: Place | null;
  /** Nombre de places passagers spécifique à cet événement. */
  seatsOverride: number | null;
  /** Voiture disponible pour cet événement (sinon valeur du profil). */
  carAvailableOverride: boolean | null;
  note: string;
}

export type EventStatus = 'planned' | 'done';

export interface SportEvent {
  id: string;
  name: string;
  date: ISODay;
  departureTime: string; // HH:MM
  returnTime: string | null; // HH:MM
  destination: Place;
  constraints: string;
  attendance: Attendance[];
  status: EventStatus;
  plan: Plan | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt: ISODateTime | null;
}

// ───────────────────────── Stratégies ─────────────────────────

export type StrategyMode = 'equity' | 'volunteer' | 'mixed';

/**
 * Poids des critères, tous exprimés sur une échelle 0..10 compréhensible
 * (0 = ignoré, 5 = normal, 10 = très important).
 */
export interface Weights {
  /** Priorité donnée aux volontaires. */
  volunteer: number;
  /** Équité du nombre de trajets. */
  tripEquity: number;
  /** Équité des distances parcourues. */
  distanceEquity: number;
  /** Sévérité de la limitation des trajets consécutifs. */
  consecutive: number;
  /** Importance de limiter les kilomètres et les détours. */
  compactness: number;
  /** Importance de limiter le nombre de voitures. */
  fewCars: number;
}

export interface StrategyConfig {
  mode: StrategyMode;
  weights: Weights;
  /** Nombre de trajets consécutifs au-delà duquel la priorité chute. */
  maxConsecutive: number;
  /** Détour toléré par conducteur (km à vol d'oiseau) avant pénalité. */
  maxDetourKm: number;
  /** Nombre de voitures supplémentaires explorées au-delà du minimum. */
  extraCars: number;
}

// ───────────────────────── Plan de covoiturage ─────────────────────────

export interface Vehicle {
  id: string;
  driverId: string;
  /** Passagers, dans l'ordre de récupération. */
  passengerIds: string[];
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'INSUFFICIENT_SEATS'
  | 'NO_DRIVER_AVAILABLE'
  | 'UNASSIGNED'
  | 'OVER_CAPACITY'
  | 'DRIVER_NOT_AVAILABLE'
  | 'DRIVER_NO_CAR'
  | 'DRIVER_REFUSES'
  | 'DUPLICATE_ASSIGNMENT'
  | 'UNKNOWN_PARTICIPANT'
  | 'PASSENGER_NOT_AVAILABLE'
  | 'LONG_DETOUR'
  | 'MISSING_COORDS'
  | 'LAST_RESORT_DRIVER'
  | 'MANUAL_OVERRIDE'
  | 'LOCK_NOT_APPLIED';

export interface PlanIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  participantIds: string[];
  vehicleId: string | null;
}

export interface UnassignedEntry {
  participantId: string;
  reason: string;
}

export interface VehicleMetrics {
  vehicleId: string;
  /** Longueur de l'itinéraire (départ conducteur → récupérations → destination), à vol d'oiseau. */
  routeKm: number;
  /** Distance directe départ conducteur → destination. */
  directKm: number;
  /** routeKm - directKm. */
  detourKm: number;
  seatsUsed: number;
  seatsTotal: number;
}

export interface PlanMetrics {
  carsUsed: number;
  totalKm: number;
  totalDetourKm: number;
  /** Somme (sans covoiturage) des distances directes de chacun : référence. */
  soloKm: number;
  vehicles: VehicleMetrics[];
  /** Distance parcourue par chaque passager (de sa récupération à la destination). */
  passengerKm: Record<string, number>;
  /** Origine des distances : jamais un temps de trajet routier. */
  distanceKind: 'straight_line' | 'road';
}

export interface AlternativeSummary {
  driverIds: string[];
  carsUsed: number;
  totalKm: number;
  /** Coût global pondéré (plus bas = meilleur). */
  score: number;
  /** Écart-type projeté de la « dette de conduite » après cet événement. */
  projectedImbalance: number;
}

export interface Locks {
  /** Conducteurs imposés (non modifiables lors d'un recalcul). */
  drivers: string[];
  /** Passager → conducteur imposé. */
  assignments: Record<string, string>;
}

export type PlanStatus = 'ok' | 'incomplete' | 'invalid';

export interface Plan {
  id: string;
  strategy: StrategyConfig;
  generatedAt: ISODateTime;
  source: 'engine' | 'manual';
  vehicles: Vehicle[];
  unassigned: UnassignedEntry[];
  /** Exclus manuellement de l'organisation. */
  excluded: string[];
  /** Présents mais en transport autonome. */
  selfTransportIds: string[];
  /** Participants considérés comme conducteurs possibles à cet événement (instantané pour l'équité). */
  eligibleDriverIds: string[];
  /** Tous les participants pris en compte à cet événement. */
  attendeeIds: string[];
  locks: Locks;
  issues: PlanIssue[];
  /** Pistes concrètes quand le plan est incomplet (véhicule en plus, disponibilités à revoir…). */
  suggestions: string[];
  status: PlanStatus;
  metrics: PlanMetrics;
  alternatives: AlternativeSummary[];
  /** L'utilisateur a validé explicitement cette organisation. */
  validated: boolean;
}

// ───────────────────────── Application ─────────────────────────

export interface Settings {
  strategy: StrategyConfig;
  /** Rappel de sauvegarde / sauvegarde automatique, en jours. */
  backupEveryDays: number;
  autoBackupEnabled: boolean;
}

export interface AppMeta {
  deviceId: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  lastExportAt: ISODateTime | null;
  lastBackupAt: ISODateTime | null;
}

export interface AppState {
  /** Version du format de données (voir data/migrate.ts). */
  schemaVersion: number;
  team: { name: string };
  participants: Participant[];
  events: SportEvent[];
  settings: Settings;
  meta: AppMeta;
}
