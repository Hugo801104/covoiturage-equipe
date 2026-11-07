// filepath: scripts/serve.mjs
// Serveur statique local minimal (aucune dépendance) pour dist/site : http://localhost:8080
// Les données restent dans le navigateur ; ce serveur ne reçoit et n'enregistre rien.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'site');
const port = Number(process.env.PORT ?? process.argv[2] ?? 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

if (!existsSync(root)) {
  console.error('dist/site introuvable : lancez d’abord « npm run build ».');
  process.exit(1);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Introuvable');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`Covoiturage équipe : http://localhost:${port}  (Ctrl+C pour arrêter)`));
