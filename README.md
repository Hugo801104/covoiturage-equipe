# Covoiturage équipe

Application web **100 % locale** pour organiser et optimiser le covoiturage d'une équipe sportive :
pas de serveur, pas de base de données distante, pas de compte, pas de service payant. Les données restent dans
le navigateur (IndexedDB) et se partagent entre appareils par **fichiers JSON**. Fonctionne **hors ligne**.

## Démarrage rapide

Prérequis : Node.js ≥ 22.18 (uniquement pour compiler et tester ; l'application elle-même n'a besoin que d'un navigateur).

```bash
npm install          # installe TypeScript (seule dépendance de développement)
npm run build        # produit dist/covoiturage.html (fichier unique) et dist/site/
```

Deux façons de l'utiliser :

| Mode | Comment | Particularité |
|---|---|---|
| **Fichier unique** | double-cliquer `dist/covoiturage.html` | aucun serveur ; fonctionne via `file://` |
| **Installable** | `npm run serve` puis http://localhost:8080 | service worker + manifeste : installable, hors ligne garanti |

Pour essayer sans rien saisir : écran **Données → Charger l'équipe de démonstration** (24 personnes, 9 événements,
6 déjà terminés), ou importer `demo/equipe-demo.json` (régénérable par `npm run demo-json`).

Commandes : `npm test` (145 tests) · `npm run typecheck` · `npm run check` (typecheck + tests + build).

## Utilisation

1. **Participants** : nom, lieu de départ (commune connue hors ligne ou coordonnées), voiture, places passagers
   (hors conducteur), volonté de conduire (5 niveaux), conducteur prioritaire, « ne conduit jamais ».
   *Avoir une voiture* et *vouloir conduire* sont deux notions distinctes.
2. **Événements** : date, horaires, destination, contraintes. Tableau des disponibilités avec exceptions par
   événement (transport autonome, voiture indisponible, nombre de places, départ spécifique).
3. **Organisation** : choisir une stratégie, **Calculer l'organisation**, puis ajuster à la main (changer de
   conducteur, déplacer/ordonner/exclure un passager, ajouter/supprimer un véhicule). Chaque modification
   relance la vérification des contraintes. **Recalculer l'organisation** conserve vos modifications si la case
   est cochée. « Pourquoi cette organisation ? » explique chaque choix avec les chiffres réellement calculés.
4. **Valider et terminer l'événement** : l'organisation entre dans l'**Historique** et pèse sur l'équité des
   événements suivants. Un événement terminé reste corrigeable.
5. **Données** : export/import JSON, sauvegardes internes, démo, remise à zéro.

### Stratégies

| Stratégie | Principe |
|---|---|
| **Mixte** (par défaut) | favorise les volontaires, mais plus on a conduit, moins on est prioritaire |
| **Équité absolue** | chacun conduit sa part équitable sur la durée ; les préférences ne servent qu'à départager |
| **Priorité aux volontaires** | volontaires/prioritaires d'abord, puis indifférents ; rotation à l'intérieur de chaque palier |

Réglages avancés : poids (volontaires, équité des trajets, équité des km, trajets consécutifs, compacité,
nombre de voitures), nombre de trajets consécutifs max, détour toléré, voitures supplémentaires explorées.

## Le moteur (`src/engine/`)

Module pur, sans DOM ni stockage, entièrement testé.

- **Contraintes dures** (jamais violées sans signalement) : capacité (conducteur compris), un seul véhicule par
  personne, conducteur avec voiture et disponible, refus respectés (« ne conduit jamais » / « refuse »),
  cohérence géographique (coordonnées requises).
- **Objectif** : minimiser un coût exprimé en « km-équivalents » = coût des conducteurs (préférence + équité
  + série consécutive + dernier recours) + coût par voiture + kilomètres parcourus + pénalité de détour.
- **Équité dans la durée** : « dette de conduite » = trajets conduits − part équitable
  (voitures ÷ conducteurs possibles présents). Seuls les présents comptent : une absence ne crée ni dette ni crédit.
- **Résolution** : choix du jeu de conducteurs par recherche locale multi-départs, affectation par insertion
  avec regret, ordre de ramassage exact (Held-Karp jusqu'à 10 arrêts, sinon voisin le plus proche + 2-opt).
  Budget de calcul déterministe ; l'optimalité du jeu de conducteurs est vérifiée contre l'énumération exhaustive
  sur 30 instances de test. 60 personnes se calculent en moins de 5 s.
- **Cas impossibles** détectés (places manquantes, aucun conducteur, personnes non affectées) avec raisons et
  pistes de résolution ; jamais de plan non conforme présenté comme valide.

### Limites à connaître

- Distances **à vol d'oiseau** (haversine). Elles ne sont **jamais** présentées comme des temps de trajet
  routier ; aucun horaire d'arrivée n'est calculé. Le moteur accepte un fournisseur de distances alternatif
  (`DistanceProvider`) pour brancher plus tard un calcul routier hors ligne.
- Le carnet d'adresses intégré (~70 communes françaises) donne le **centre-ville approximatif**. Pour un calcul
  précis, saisissez latitude/longitude réelles.
- La carte est un tracé SVG sans fond de carte (hors ligne).
- Les données sont par navigateur et par appareil : exportez régulièrement (l'application le rappelle).

## Données et sécurité

- Stockage : IndexedDB, repli localStorage, repli mémoire (signalé, non durable). Sauvegarde automatique
  (regroupée) à chaque modification ; sauvegardes internes périodiques (10 conservées) et avant tout import,
  restauration ou remise à zéro. Données illisibles : copie brute conservée et téléchargeable, jamais écrasée.
- Import : validation stricte, migration de version, puis **fusion sans écrasement silencieux** — conflits
  présentés un par un (garder ici / prendre le fichier / le plus récent). Voir `docs/FORMAT_JSON.md`.
- Aucun réseau n'est utilisé par le code applicatif.

## Architecture

```
src/domain/   types, aides, carnet de communes          (aucune dépendance)
src/engine/   géo, historique/équité, scoring, solveur, édition manuelle, explications
src/data/     schéma + validation + migrations + fusion, stockage (IndexedDB…), actions pures, store
src/ui/       DOM minimal (h()), routage par hash, composants, 6 écrans, carte SVG
scripts/      build (tsc + assembleur sans dépendance), serveur statique, génération de la démo
tests/        moteur, scénarios 24 personnes, couche données (node --test, TypeScript natif)
```

Choix : TypeScript strict sans framework (un seul fichier de sortie, ouvrable en `file://`) ; actions d'état
pures et testables ; suppressions logiques (tombstones) pour propager les suppressions à l'import.

## Accessibilité

Navigation clavier complète, focus visible, lien d'évitement, libellés liés aux champs, tableaux avec en-têtes,
messages d'état annoncés (`aria-live`), thème clair/sombre, mobile d'abord, cibles tactiles ≥ 34 px,
respect de `prefers-reduced-motion`.
