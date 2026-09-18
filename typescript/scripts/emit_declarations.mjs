// Emits the package's type declarations: one .d.ts per source file, mirroring
// src/, plus the .d.mts twin each `import` export condition resolves to.
//
// Run after tsup, which owns the JavaScript and clears dist/.
//
// tsc writes extensionless relative specifiers. Both twins get an explicit
// extension here — .js in .d.ts, .mjs in .d.mts — so a consumer on
// node16/nodenext resolution follows them the same way it follows the
// JavaScript beside them.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PKG, 'dist');

// The compiler's own entry point, run on this Node: the `tsc` and `npx` bins
// are `.cmd` shims on Windows, which execFileSync cannot launch.
const tsc = createRequire(join(PKG, 'package.json')).resolve('typescript/bin/tsc');

execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: PKG,
  stdio: 'inherit',
});

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)'(\.[^']*)'/g;

// A directory-style specifier ('../protocol') has to be pointed at its index
// file before the extension goes on: the bare directory plus '.mjs' names a
// module the package does not contain.
function withExtension(path, source, extension) {
  return source.replace(RELATIVE_SPECIFIER, (_match, keyword, specifier) => {
    const target =
      !existsSync(join(dirname(path), `${specifier}.d.ts`)) &&
      existsSync(join(dirname(path), specifier, 'index.d.ts'))
        ? `${specifier}/index`
        : specifier;
    return `${keyword}'${target}${extension}'`;
  });
}

const declarations = [...walk(DIST)].filter((path) => path.endsWith('.d.ts'));

for (const path of declarations) {
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, withExtension(path, source, '.js'));
  writeFileSync(path.replace(/\.d\.ts$/, '.d.mts'), withExtension(path, source, '.mjs'));
}

// tsup names an entry built from a directory's index file after the directory
// (`tool` from `src/tool/index.ts`), so its JavaScript sits at dist/tool.mjs
// while tsc writes the declaration to dist/tool/index.d.ts. That subpath's
// export condition resolves types beside the JavaScript, so bridge the two.
// Module ids are posix everywhere: they become import specifiers, and on
// Windows `relative` would otherwise hand back backslashes.
const moduleId = (path) => relative(DIST, path).split(sep).join('/');
const emitted = new Set(declarations.map(moduleId));

for (const path of walk(DIST)) {
  const name = moduleId(path).replace(/\.mjs$/, '');
  if (!path.endsWith('.mjs') || name.includes('/')) continue;
  if (emitted.has(`${name}.d.ts`) || !emitted.has(`${name}/index.d.ts`)) continue;

  for (const [extension, twin] of [['d.ts', 'js'], ['d.mts', 'mjs']]) {
    writeFileSync(
      join(DIST, `${name}.${extension}`),
      `export * from './${name}/index.${twin}';\n`,
    );
  }
}

// Every relative specifier in the emitted declarations must resolve to a
// declaration beside it. An unresolved one is worse than a build break: under
// skipLibCheck (which every bundler-era consumer sets) it degrades each type
// it carries to `any`, silently.
const dangling = [];
for (const path of walk(DIST)) {
  if (!path.endsWith('.d.ts') && !path.endsWith('.d.mts')) continue;
  for (const match of readFileSync(path, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
    const specifier = match[2];
    const twin = specifier.replace(/\.mjs$/, '.d.mts').replace(/\.js$/, '.d.ts');
    if (!existsSync(join(dirname(path), twin))) {
      dangling.push(`  ${moduleId(path)} → ${specifier}`);
    }
  }
}
if (dangling.length) {
  throw new Error(
    `declarations import modules the package does not contain:\n${dangling.join('\n')}`,
  );
}

// The declaration tree mirrors src/ while tsup builds only the entry points,
// so it holds modules that are readable but not importable. `exports` names
// the importable ones, and every path it names must have all four files —
// otherwise a subpath typechecks and then throws at runtime.
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const targets = [];

for (const [subpath, conditions] of Object.entries(pkg.exports)) {
  for (const condition of Object.values(conditions)) {
    for (const target of Object.values(condition)) targets.push([subpath, target]);
  }
}

const missing = targets.filter(([, target]) => !existsSync(join(PKG, target)));
if (missing.length) {
  const shown = missing.map(([subpath, target]) => `  ${subpath} → ${target}`);
  throw new Error(`exports names files the build did not emit:\n${shown.join('\n')}`);
}

const advertised = new Set(Object.values(pkg.exports).map((c) => c.import.default));
const unadvertised = [...walk(DIST)]
  .filter((path) => path.endsWith('.mjs') && !path.includes('chunk-'))
  .map((path) => `./${moduleId(path)}`)
  .filter((id) => !advertised.has(`./dist/${id.slice(2)}`));

if (unadvertised.length) {
  throw new Error(`built but not in exports:\n  ${unadvertised.join('\n  ')}`);
}

console.log(
  `declarations: ${declarations.length} modules, both twins; ` +
    `${Object.keys(pkg.exports).length} subpaths complete`,
);
