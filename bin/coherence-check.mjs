#!/usr/bin/env node
// LID structural coherence check: spec IDs in docs/specs vs @spec annotations in code and tests.
// Usage: node bin/coherence-check.mjs [--prefix DEC,REC,...]   (exit 1 on dangling references)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const prefixArg = args.indexOf('--prefix');
const prefixes = prefixArg >= 0 ? args[prefixArg + 1].split(',') : null;
const inScope = (id) => !prefixes || prefixes.some((p) => id.startsWith(p + '-'));

// .github is scanned (workflows carry @spec comments); other dot-directories are not.
const SKIP = new Set(['node_modules', 'dist', 'target', '.git', 'docs', 'fixtures', 'coverage', 'results']);
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || (name.startsWith('.') && name !== '.github' && name !== '.github/workflows')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|mjs|rs|html|ya?ml|sh)$/.test(name) || name === 'Dockerfile' || name === 'README.md' || /^tsconfig.*\.json$/.test(name)) yield p;
  }
}

// Spec IDs and their status markers.
const specs = new Map();
for (const f of readdirSync(join(root, 'docs/specs'))) {
  for (const line of readFileSync(join(root, 'docs/specs', f), 'utf8').split('\n')) {
    const m = line.match(/^- \[( |x|D)\] \*\*([A-Z]+-[A-Z]+-\d{3})\*\*/);
    if (m) specs.set(m[2], { status: m[1], file: f });
  }
}

// @spec annotations, split into tests and code.
const refs = { test: new Map(), code: new Map() };
for (const file of walk(root)) {
  const rel = relative(root, file);
  const kind = /(^|\/)(test|tests)\//.test(rel) || /\.test\.ts$/.test(rel) ? 'test' : 'code';
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/@spec\s+([A-Z0-9, -]+)/g)) {
    for (const id of m[1].match(/[A-Z]+-[A-Z]+-\d{3}/g) ?? []) {
      if (!refs[kind].has(id)) refs[kind].set(id, new Set());
      refs[kind].get(id).add(rel);
    }
  }
}

const dangling = [...refs.test.keys(), ...refs.code.keys()].filter((id) => !specs.has(id));
const active = [...specs].filter(([id, s]) => s.status !== 'D' && inScope(id)).map(([id]) => id);
const untested = active.filter((id) => !refs.test.has(id));
const unannotated = active.filter((id) => !refs.code.has(id));

console.log(`specs: ${specs.size} total, ${active.length} active in scope${prefixes ? ` (${prefixes.join(',')})` : ''}`);
console.log(`dangling @spec references: ${dangling.length}${dangling.length ? '\n  ' + [...new Set(dangling)].join('\n  ') : ''}`);
console.log(`active specs without a test: ${untested.length}${untested.length ? '\n  ' + untested.join(' ') : ''}`);
console.log(`active specs without a code annotation: ${unannotated.length}${unannotated.length ? '\n  ' + unannotated.join(' ') : ''}`);
process.exit(dangling.length ? 1 : 0);
