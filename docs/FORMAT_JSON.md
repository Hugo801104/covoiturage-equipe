# Format du fichier d'export JSON

## Enveloppe

```json
{
  "format": "covoiturage-equipe",
  "schemaVersion": 1,
  "exportedAt": "2026-11-06T10:00:00.000Z",
  "appVersion": "1.0.0",
  "data": { "...état de l'application..." }
}
```

- `format` : identifiant constant ; un autre fichier JSON est refusé.
- `schemaVersion` : version de la structure de `data`. Un fichier **plus récent** que l'application est refusé
  avec un message clair ; un fichier **plus ancien** est migré automatiquement.
- Un état brut (sans enveloppe) est également accepté.

## `data` (schemaVersion 1)

| Champ | Contenu |
|---|---|
| `schemaVersion` | entier |
| `team.name` | nom de l'équipe |
| `participants[]` | `id`, `firstName`, `lastName`, `home` {`label`,`address`,`lat`,`lng`}, `hasCar`, `carAvailable`, `seats` (hors conducteur), `drivingPreference` (`priority` \| `volunteer` \| `indifferent` \| `prefer_passenger` \| `refuse`), `priorityDriver`, `neverDrive`, `acceptLastResort`, `notes`, `createdAt`, `updatedAt`, `deletedAt` |
| `events[]` | `id`, `name`, `date` (AAAA-MM-JJ), `departureTime`/`returnTime` (HH:MM), `destination` (lieu), `constraints`, `attendance[]`, `status` (`planned` \| `done`), `plan`, `createdAt`, `updatedAt`, `deletedAt` |
| `events[].attendance[]` | `participantId`, `availability` (`yes` \| `no` \| `unknown`), `selfTransport`, `startOverride`, `seatsOverride`, `carAvailableOverride`, `note` |
| `events[].plan` | stratégie utilisée, `vehicles[]` (`driverId`, `passengerIds` dans l'ordre de ramassage), `unassigned`, `excluded`, `selfTransportIds`, `eligibleDriverIds`, `attendeeIds`, `locks`, `issues`, `suggestions`, `status`, `metrics`, `alternatives`, `validated` |
| `settings` | stratégie par défaut, `backupEveryDays` (0 = pas de rappel), `autoBackupEnabled` |
| `meta` | `deviceId`, `createdAt`, `updatedAt`, `lastExportAt`, `lastBackupAt` |

Règles de validation : types et plages (lat −90…90, lng −180…180, places entières ≥ 0), énumérations,
identifiants uniques, dates/heures valides, longueurs maximales. Les champs inconnus sont ignorés ; les
références orphelines (disponibilité d'un participant inconnu) produisent un **avertissement** et sont retirées.
Une erreur bloque l'import et **ne modifie aucune donnée**.

## Suppressions

Les suppressions sont logiques (`deletedAt` non nul). Le participant disparaît des listes mais reste dans
l'historique, et la suppression peut être propagée à un autre appareil via l'import (toujours comme conflit à arbitrer).

## Import et fusion

1. Analyse du fichier (validation + migration) sans toucher aux données.
2. Comparaison entité par entité (par `id`) :
   - **ajouté** : absent en local → ajouté ;
   - **identique** : rien à faire ;
   - **conflit** : contenu différent → l'utilisateur choisit *garder ici* (par défaut) ou *prendre le fichier*,
     ou « le plus récent gagne » (d'après `updatedAt`) sur demande explicite ;
   - **local seulement** : conservé (un import ne supprime jamais rien) ;
   - **ignoré** : supprimé dans le fichier et inconnu en local.
3. Une sauvegarde de l'état précédent est créée avant d'appliquer. « Tout remplacer » demande confirmation.

Le nom d'équipe, les réglages et l'identité de l'appareil locaux sont conservés lors d'une fusion.

## Ajouter une version du format

1. Incrémenter `CURRENT_SCHEMA_VERSION` dans `src/data/schema.ts`.
2. Ajouter dans `MIGRATIONS` (`src/data/migrate.ts`) une fonction `n → n+1` : `MIGRATIONS[1] = (d) => ({ ...d, nouveauChamp: … })`.
3. Adapter `src/data/validate.ts` et ajouter un test de migration dans `tests/data.test.ts`.

## Partage multi-appareils

Appareil A : *Données → Télécharger le fichier JSON* → transmettre le fichier → appareil B : *Importer* →
résoudre les éventuels conflits → *Appliquer la fusion*. Répéter dans l'autre sens pour synchroniser.
