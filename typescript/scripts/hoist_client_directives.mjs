// Moves `"use client"` to the front of the CommonJS builds.
//
// A directive is only a directive in the prologue — the run of string-literal
// statements a module opens with. esbuild emits its CJS interop preamble
// first, so the directive lands third and degrades into an expression
// statement that evaluates a string and discards it. A bundler resolving the
// `require` condition then rejects the file outright:
//
//   The "use client" directive must be placed before other expressions.
//
// The ESM builds are already correct and are left alone.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const DIRECTIVE = /^\s*(["'])use client\1;?/;
const STATEMENT = /(["'])use client\1;/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const hoisted = [];

for (const path of walk(DIST)) {
  if (!path.endsWith('.js')) continue;

  const source = readFileSync(path, 'utf8');
  if (!STATEMENT.test(source) || DIRECTIVE.test(source)) continue;

  // Drop the misplaced copy and reopen the file with it. `"use strict"` stays
  // a directive: a prologue may hold several, and it is still string-literal
  // statements all the way down.
  writeFileSync(path, `"use client";${source.replace(STATEMENT, '')}`);
  hoisted.push(relative(DIST, path));
}

// Post-condition, answered from the source rather than from the build: an
// entry whose source opens with the directive must produce outputs that do
// too, in both formats. Comparing the two builds to each other is not enough
// — when a source file loses its directive both builds lose it together, they
// still agree, and the check passes on a package that is broken for everyone.
const SRC = join(fileURLToPath(new URL('..', import.meta.url)), 'src');
const config = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'tsup.config.ts'),
  'utf8',
);
const entries = [...config.matchAll(/'?([\w./-]+)'?:\s*'(src\/[\w./-]+)'/g)].map(
  ([, name, source]) => [name, source.replace(/^src\//, '')],
);
if (entries.length === 0) throw new Error('no entries parsed from tsup.config.ts');

const problems = [];
for (const [name, source] of entries) {
  let text;
  try {
    text = readFileSync(join(SRC, source), 'utf8');
  } catch {
    throw new Error(`tsup entry "${name}" names a source that does not exist: src/${source}`);
  }

  // Everything under src/react/ is a React binding, so every entry built from
  // it is a client boundary. Deriving that from the directory rather than from
  // the file's own directive is the point: a source file that loses the
  // directive is exactly the failure this has to catch, and asking the file
  // whether it declares one would let that pass as "nothing to check".
  const isClientEntry = source.startsWith('react/');
  const declares = DIRECTIVE.test(text);

  if (isClientEntry && !declares) {
    problems.push(`src/${source} is a React entry and does not declare "use client"`);
    continue;
  }
  if (!declares) continue;

  for (const extension of ['.js', '.mjs']) {
    const built = join(DIST, name + extension);
    if (!DIRECTIVE.test(readFileSync(built, 'utf8'))) {
      problems.push(`${relative(DIST, built)} does not open with "use client"`);
    }
  }
}
if (problems.length) {
  throw new Error(
    `"use client" is not where it has to be:\n  ${problems.join('\n  ')}\n` +
      'A bundler will reject these, or treat a client module as server code.',
  );
}

const checked = entries.filter(([, source]) => source.startsWith('react/')).length;

console.log(
  `use client: ${hoisted.length} CJS file(s) hoisted; ${checked} declaring entr` +
    `${checked === 1 ? 'y' : 'ies'} verified against src in both formats`,
);
