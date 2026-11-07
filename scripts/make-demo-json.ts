// filepath: scripts/make-demo-json.ts
// Génère demo/equipe-demo.json : jeu de données de démonstration (24 personnes, 9 événements) importable dans l'application.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildDemoState } from '../src/data/demo.ts';
import { serializeExport } from '../src/data/schema.ts';

mkdirSync('demo', { recursive: true });
writeFileSync('demo/equipe-demo.json', serializeExport(buildDemoState()));
console.log('✓ demo/equipe-demo.json');
