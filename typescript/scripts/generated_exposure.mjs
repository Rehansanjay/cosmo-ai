import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(sdkRoot, 'package.json'));
const ts = require('typescript');

const config = readFileSync(join(sdkRoot, 'tsup.config.ts'), 'utf8');
const entries = [...new Set([...config.matchAll(/['"]((?:src)\/[^'"]+\.tsx?)['"]/g)].map(m => m[1]))]
  .map(p => join(sdkRoot, p));
const program = ts.createProgram(entries, {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
  strict: true, noEmit: true,
});
const checker = program.getTypeChecker();
const isGen = (f) => /\.gen\.tsx?$/.test(f) || f.includes('/src/wire/');

// Walk a type's graph, recording generated declarations reached and the path taken.
function walk(type, path, seen, found, depth) {
  if (!type || depth > 12) return;
  const sym = type.aliasSymbol ?? type.getSymbol();
  if (sym) {
    const key = checker.getFullyQualifiedName(sym) + '|' + (type.aliasSymbol ? 'a' : 's');
    if (seen.has(key)) return;
    seen.add(key);
    for (const d of sym.getDeclarations() ?? []) {
      const f = d.getSourceFile().fileName;
      if (isGen(f)) {
        found.push({ name: sym.getName(), file: relative(sdkRoot, f), path: path.join(' → ') });
        return; // record the boundary crossing, don't descend into generated land
      }
    }
  }
  const name = sym ? sym.getName() : '';
  if (type.isUnionOrIntersection()) {
    for (const t of type.types) walk(t, path, seen, found, depth + 1);
    return;
  }
  const ref = type;
  if (ref.typeArguments) for (const t of ref.typeArguments) walk(t, path, seen, found, depth + 1);
  for (const prop of checker.getPropertiesOfType(type)) {
    const decls = prop.getDeclarations() ?? [];
    if (!decls.length) continue;
    // Only what a consumer can actually touch: no private/protected members,
    // no #private fields, and nothing marked @internal.
    if (prop.getName().startsWith('#')) continue;
    const mods = ts.getCombinedModifierFlags(decls[0]);
    if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
    if (decls[0].name && ts.isPrivateIdentifier(decls[0].name)) continue;
    const doc = prop.getJsDocTags?.() ?? [];
    if (doc.some(t => t.name === 'internal')) continue;
    const pt = checker.getTypeOfSymbolAtLocation(prop, decls[0]);
    walk(pt, [...path, `${name}.${prop.getName()}`], seen, found, depth + 1);
    probeTypeNode(decls[0].type, [...path, `${name}.${prop.getName()}`], found);
  }
  for (const sig of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    walk(sig.getReturnType(), [...path, `${name}()`], seen, found, depth + 1);
    for (const p of sig.getParameters()) {
      const ds = p.getDeclarations() ?? [];
      if (!ds.length) continue;
      walk(checker.getTypeOfSymbolAtLocation(p, ds[0]), [...path, `${name}(${p.getName()})`], seen, found, depth + 1);
      probeTypeNode(ds[0].type, [...path, `${name}(${p.getName()})`], found);
    }
  }
}

// The semantic walk flattens `Alias | undefined` into the alias's members,
// losing the alias symbol — a generated union alias reachable only through an
// optional property was invisible. The written annotation keeps the identity,
// so every type reference in it is resolved by name. Syntactic and shallow:
// the structure behind each reference is the semantic walk's job.
function probeTypeNode(node, path, found) {
  if (!node) return;
  if (ts.isTypeReferenceNode(node)) {
    let sym = checker.getSymbolAtLocation(node.typeName);
    if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch {} }
    for (const d of sym?.getDeclarations() ?? []) {
      const f = d.getSourceFile().fileName;
      if (isGen(f)) {
        found.push({ name: sym.getName(), file: relative(sdkRoot, f), path: path.join(' → ') });
        break;
      }
    }
  }
  ts.forEachChild(node, child => probeTypeNode(child, path, found));
}

const all = new Map();
for (const entry of entries) {
  const sf = program.getSourceFile(entry);
  const modSym = sf && checker.getSymbolAtLocation(sf);
  if (!modSym) continue;
  const ep = relative(sdkRoot, entry);
  for (const ex of checker.getExportsOfModule(modSym)) {
    let s = ex;
    if (s.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s); } catch {} }
    const decls = s.getDeclarations() ?? [];
    if (!decls.length) continue;
    const t = checker.getDeclaredTypeOfSymbol(s).flags ? checker.getDeclaredTypeOfSymbol(s) : checker.getTypeOfSymbolAtLocation(s, decls[0]);
    const found = [];
    walk(t, [ex.getName()], new Set(), found, 0);
    const t2 = checker.getTypeOfSymbolAtLocation(s, decls[0]);
    walk(t2, [ex.getName()], new Set(), found, 0);
    for (const f of found) {
      const k = `${f.name}`;
      if (!all.has(k)) all.set(k, new Set());
      all.get(k).add(`${ep} :: ${f.path}`);
    }
  }
}
const names = [...all.keys()].sort();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(names));
} else {
  console.log(`generated types reachable from a published entry point: ${names.length}\n`);
  for (const [name, paths] of [...all.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(name);
    for (const p of [...paths].sort().slice(0, 3)) console.log(`    via ${p}`);
  }
}
