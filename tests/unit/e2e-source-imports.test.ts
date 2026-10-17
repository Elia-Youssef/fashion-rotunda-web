import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = process.cwd();
const sourceDirectory = resolve(root, 'src');
const testDirectory = resolve(root, 'tests/e2e');
const options: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
};

function inside(path: string, directory: string): boolean {
  const suffix = relative(directory, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  }).sort();
}

/** Parses executable imports and forwarding exports without treating types or comments as code. */
function runtimeImports(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const add = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) imports.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings &&
        ts.isNamedImports(bindings) && bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly));
      if (!onlyTypes) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      const bindings = node.exportClause;
      const onlyTypes = node.isTypeOnly || (bindings && ts.isNamedExports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
      if (!onlyTypes) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

it('keeps every browser test runtime source import chain free of stylesheets', () => {
  const failures: string[] = [];
  const cachedImports = new Map<string, string[]>();
  const display = (path: string): string => relative(root, path).split(sep).join('/');
  for (const entry of testFiles(testDirectory)) {
    const visited = new Set<string>();
    const visit = (path: string, chain: string[]): void => {
      if (visited.has(path)) return;
      visited.add(path);
      let imports = cachedImports.get(path);
      if (!imports) {
        imports = runtimeImports(path);
        cachedImports.set(path, imports);
      }
      for (const specifier of imports) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(path), specifier);
        if (!inside(target, sourceDirectory) && !inside(target, testDirectory)) continue;
        if (/\.css(?:[?#]|$)/i.test(specifier)) {
          failures.push([...chain, display(target)].join(' -> '));
          continue;
        }
        const resolved = ts.resolveModuleName(specifier, path, options, ts.sys).resolvedModule;
        if (!resolved) {
          failures.push([...chain, `${specifier} (unresolved relative import)`].join(' -> '));
          continue;
        }
        const file = resolve(resolved.resolvedFileName);
        if (inside(file, sourceDirectory) || inside(file, testDirectory)) {
          visit(file, [...chain, display(file)]);
        }
      }
    };
    visit(entry, [display(entry)]);
  }
  expect(failures, `Browser test imports must load without CSS:\n${failures.join('\n')}`).toEqual([]);
});
