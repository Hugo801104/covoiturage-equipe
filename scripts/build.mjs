// filepath: scripts/build.mjs
// Compilation et assemblage SANS dépendance supplémentaire que TypeScript :
//   1. tsc compile src/ → .build/js (modules ES)
//   2. un petit assembleur regroupe les modules en UN seul script (pas de chargeur de modules requis :
//      l'application fonctionne ainsi même ouverte en double-clic via file://)
//   3. sortie : dist/covoiturage.html (fichier unique, à ouvrir directement)
//               dist/site/ (version installable hors ligne : index.html + app.js + styles.css + sw.js + manifeste)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = join(root, '.build', 'js');
const dist = join(root, 'dist');

function findTsc() {
  try {
    const require = createRequire(join(root, 'package.json'));
    return { cmd: process.execPath, args: [require.resolve('typescript/bin/tsc')] };
  } catch {
    return { cmd: process.platform === 'win32' ? 'tsc.cmd' : 'tsc', args: [] };
  }
}

function compile() {
  rmSync(join(root, '.build'), { recursive: true, force: true });
  const { cmd, args } = findTsc();
  const extra = process.env.TSC_ARGS ? process.env.TSC_ARGS.split(' ').filter(Boolean) : [];
  const r = spawnSync(cmd, [...args, '-p', 'tsconfig.build.json', ...extra], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && args.length === 0 });
  if (r.status !== 0) {
    console.error('\n✗ La compilation TypeScript a échoué. Lancez « npm install » si TypeScript est absent.');
    process.exit(r.status ?? 1);
  }
}

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listJs(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : []));
}

const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+(["'])([^"']+)\2;?[ \t]*$/gm;
const BARE_IMPORT_RE = /^import\s+(["'])([^"']+)\1;?[ \t]*$/gm;
const EXPORT_FROM_RE = /^export\s+\{([\s\S]*?)\}\s+from\s+(["'])([^"']+)\2;?[ \t]*$/gm;
const EXPORT_LIST_RE = /^export\s+\{([\s\S]*?)\};?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function\s*\*?|function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function resolveId(fromId, spec) {
  if (!spec.startsWith('.')) throw new Error(`Import externe non supporté dans ${fromId} : ${spec}`);
  return posix.normalize(posix.join(posix.dirname(fromId), spec));
}

function parseNames(list) {
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [a, b] = s.split(/\s+as\s+/);
    return { imported: a.trim(), local: (b ?? a).trim() };
  });
}

function transform(id, code) {
  const exportsOut = [];
  let out = code;
  out = out.replace(IMPORT_RE, (_m, clause, _q, spec) => {
    const dep = resolveId(id, spec);
    const c = clause.trim();
    const ns = c.match(/^\*\s+as\s+([\w$]+)$/);
    if (ns) return `const ${ns[1]} = __require(${JSON.stringify(dep)});`;
    const named = c.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const parts = parseNames(named[1]).map((n) => (n.imported === n.local ? n.local : `${n.imported}: ${n.local}`));
      return `const { ${parts.join(', ')} } = __require(${JSON.stringify(dep)});`;
    }
    throw new Error(`Forme d'import non supportée dans ${id} : ${c}`);
  });
  out = out.replace(BARE_IMPORT_RE, (_m, _q, spec) => `__require(${JSON.stringify(resolveId(id, spec))});`);
  let n = 0;
  out = out.replace(EXPORT_FROM_RE, (_m, list, _q, spec) => {
    const v = `__re${n++}`;
    for (const { imported, local } of parseNames(list)) exportsOut.push(`exports.${local} = ${v}.${imported};`);
    return `const ${v} = __require(${JSON.stringify(resolveId(id, spec))});`;
  });
  out = out.replace(EXPORT_LIST_RE, (_m, list) => {
    for (const { imported, local } of parseNames(list)) exportsOut.push(`exports.${local} = ${imported};`);
    return '';
  });
  out = out.replace(EXPORT_DECL_RE, (_m, kind, name) => {
    exportsOut.push(`exports.${name} = ${name};`);
    return `${kind} ${name}`;
  });
  if (/^\s*(import|export)\s/m.test(out.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))) {
    const bad = out.split('\n').find((l) => /^\s*(import|export)\s/.test(l));
    throw new Error(`Instruction de module non transformée dans ${id} : ${bad}`);
  }
  return `${out}\n${exportsOut.join('\n')}`;
}

function bundle() {
  const files = listJs(join(jsDir, 'src'));
  const modules = files.map((f) => {
    const id = relative(jsDir, f).split('\\').join('/');
    return `${JSON.stringify(id)}: function (exports, __require) {\n${transform(id, readFileSync(f, 'utf8'))}\n}`;
  });
  return `(function () {
'use strict';
var __defs = {
${modules.join(',\n')}
};
var __cache = {};
function __require(id) {
  var c = __cache[id];
  if (c) return c.exports;
  var def = __defs[id];
  if (!def) throw new Error('Module introuvable : ' + id);
  var mod = (__cache[id] = { exports: {} });
  def(mod.exports, __require);
  return mod.exports;
}
__require('src/ui/main.js');
})();
`;
}

function main() {
  compile();
  const js = bundle();
  const css = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const build = createHash('sha1').update(js).update(css).digest('hex').slice(0, 10);

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, 'site'), { recursive: true });

  // Fichier unique : tout est intégré (aucune requête, ouverture directe par double-clic).
  const inlineJs = js.replace(/<\/script/gi, '<\\/script');
  const single = html
    .replace('<link rel="manifest" href="manifest.webmanifest">\n', '')
    .replace('<link rel="icon" href="icon.svg" type="image/svg+xml">', `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(readFileSync(join(root, 'public', 'icon.svg'), 'utf8'))}">`)
    .replace('<!--STYLES-->', () => `<style>\n${css}\n</style>`)
    .replace('<!--SCRIPT-->', () => `<script>\n${inlineJs}\n</script>`);
  writeFileSync(join(dist, 'covoiturage.html'), single);

  // Version « site » installable (service worker, manifeste) : nécessite http(s) ou localhost.
  const site = join(dist, 'site');
  writeFileSync(join(site, 'app.js'), js);
  writeFileSync(join(site, 'styles.css'), css);
  writeFileSync(join(site, 'index.html'), html.replace('<!--STYLES-->', '<link rel="stylesheet" href="styles.css">').replace('<!--SCRIPT-->', '<script src="app.js"></script>'));
  for (const f of ['manifest.webmanifest', 'icon.svg']) cpSync(join(root, 'public', f), join(site, f));
  writeFileSync(join(site, 'sw.js'), readFileSync(join(root, 'public', 'sw.js'), 'utf8').replace('__BUILD__', build));

  const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} Ko`;
  console.log(`✓ dist/covoiturage.html (${kb(join(dist, 'covoiturage.html'))}) — fichier unique, ouvrir directement`);
  console.log(`✓ dist/site/ — version installable hors ligne (build ${build}) ; lancer « npm run serve »`);
  if (!existsSync(join(dist, 'covoiturage.html'))) process.exit(1);
}

main();
