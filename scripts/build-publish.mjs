/**
 * Netlify build: write js/config.js, then copy ONLY public site files into dist/.
 * Repo docs, SQL, scripts and audit notes must never be published.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

await import('./generate-config.js');

const PUBLIC_FILES = ['index.html', 'update.html', 'sw.js', 'manifest.webmanifest'];
const PUBLIC_DIRS = ['css', 'icons', 'js'];
const EXCLUDE = new Set(['js/config.example.js']);
const FORBIDDEN = /\.(md|sql|bat|sh|py|R|Rhistory|pdf|env)$/i;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of PUBLIC_FILES) cpSync(join(root, f), join(out, f));
for (const d of PUBLIC_DIRS) {
  cpSync(join(root, d), join(out, d), {
    recursive: true,
    filter: (src) => !EXCLUDE.has(relative(root, src).split('\\').join('/')),
  });
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(out, p)];
  });
}
const files = walk(out);
const bad = files.filter((f) => FORBIDDEN.test(f) || /^(docs|scripts|netlify|supabase)/.test(f));
if (bad.length || !existsSync(join(out, 'js', 'config.js'))) {
  console.error('publish check failed:', bad.join(', ') || 'js/config.js missing');
  process.exit(1);
}
console.log(`dist/ ready: ${files.length} files`);
