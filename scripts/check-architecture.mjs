import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(root, 'src');
const facadeLayers = {
  'annotation-service.ts': 'host', 'document-store.ts': 'host',
  'molecular-patch.ts': 'chemistry', 'fragments.ts': 'chemistry',
  'fragment-layout.ts': 'chemistry', 'edit-intent.ts': 'chemistry',
};
const layerOf = file => {
  const path = relative(sourceRoot, file).replaceAll('\\', '/');
  if (facadeLayers[path]) return facadeLayers[path];
  if (path === 'index.ts') return 'assembly';
  if (['client.tsx', 'editor.tsx', 'localization.ts', 'samples.ts'].includes(path)) return 'ui';
  if (path.startsWith('adapters/ketcher/')) return 'ketcher';
  if (path.startsWith('adapters/indigo/')) return 'indigo';
  return path.split('/')[0];
};
const allowed = {
  contracts: ['contracts'], chemistry: ['contracts', 'chemistry'],
  host: ['host', 'contracts', 'chemistry'],
  ketcher: ['ketcher', 'indigo', 'contracts', 'chemistry'],
  indigo: ['indigo', 'contracts'], client: ['client', 'contracts'],
  ui: ['ui', 'client', 'ketcher', 'indigo', 'chemistry', 'contracts'],
  assembly: ['assembly', 'host', 'contracts', 'chemistry'],
};
const externalAllowed = {
  contracts: () => false, chemistry: () => false,
  host: name => name.startsWith('node:'),
  ketcher: name => name === 'ketcher-core', indigo: name => name.startsWith('ketcher-'),
  client: () => false,
  ui: name => name === 'react' || name.startsWith('react-dom/') || name === 'ketcher-react' || name.endsWith('.css'),
  assembly: name => name.startsWith('node:'),
};
async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? filesIn(resolve(directory, entry.name)) : [resolve(directory, entry.name)]));
  return nested.flat().filter(file => ['.ts', '.tsx'].includes(extname(file)));
}
const files = await filesIn(sourceRoot), known = new Set(files);
const errors = [];
let checked = 0;
for (const file of files) {
  const layer = layerOf(file), label = relative(root, file).replaceAll('\\', '/');
  if (!allowed[layer]) { errors.push(`${label}: unknown source layer ${layer}`); continue; }
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
      else errors.push(`${label}: computed module imports are not supported by the boundary check`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const name of imports) {
    checked++;
    if (!name.startsWith('.')) {
      if (!externalAllowed[layer](name)) errors.push(`${label}: ${layer} cannot import ${name}`);
      continue;
    }
    if (extname(name) === '.css') {
      if (layer !== 'ui') errors.push(`${label}: ${layer} cannot import CSS`);
      continue;
    }
    const base = resolve(dirname(file), name);
    const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')].find(candidate => known.has(candidate));
    if (!target) { errors.push(`${label}: unresolved source import ${name}`); continue; }
    const dependencyLayer = layerOf(target);
    if (!allowed[layer].includes(dependencyLayer)) errors.push(`${label}: ${layer} cannot depend on ${dependencyLayer} (${name})`);
  }
}
if (errors.length) {
  for (const error of errors) console.error(error);
  throw new Error(`Architecture boundaries failed: ${errors.length} violation(s).`);
} else console.log(`Architecture boundaries passed: ${files.length} modules, ${checked} imports/exports.`);
