#!/usr/bin/env node
// Prints a sha256 digest over the SDK's build inputs. The build script stamps
// the result into dist/source-hash (so it ships in the tarball); the
// realtime-sdk-bump workflow recomputes it from the working tree to detect
// drift from the committed pin.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Tests, fixtures, and docs under src/ never reach dist, so they must not
// move the hash: a test-only edit would otherwise force a repack and churn
// the frontend lockfile for a change that ships no code.
const NON_SHIPPED = /(^|\/)__tests__(\/|$)|\.test\.[a-z]+$|\.md$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

// Every Node script under scripts/ is a build input — the build runs them to
// produce dist — so the whole directory is walked rather than named file by
// file: a script the list forgot would let its edits ship without a repack.
const files = [
  ...walk(join(root, 'src')),
  ...walk(join(root, 'scripts')).filter((path) => path.endsWith('.mjs')),
  join(root, 'package.json'),
  join(root, 'package-lock.json'),
  join(root, 'tsconfig.json'),
  join(root, 'tsconfig.build.json'),
  join(root, 'tsup.config.ts'),
]
  .map((path) => relative(root, path))
  .filter((path) => !NON_SHIPPED.test(path))
  .sort();

const hash = createHash('sha256');
for (const file of files) {
  hash.update(file);
  hash.update('\0');
  hash.update(readFileSync(join(root, file)));
  hash.update('\0');
}
process.stdout.write(hash.digest('hex') + '\n');
