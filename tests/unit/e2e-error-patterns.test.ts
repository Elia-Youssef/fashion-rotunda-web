import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { ErrorGuard } from '../e2e/support/error-guard';

/** Read the actual declarations, so a spec pattern cannot drift from its regression test. */
function patterns(file: string): RegExp[] {
  const text = readFileSync(new URL(`../e2e/${file}`, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: RegExp[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'expectConsoleError') {
      const pattern = node.arguments[1];
      if (pattern === undefined || !ts.isRegularExpressionLiteral(pattern)) {
        throw new Error('Expected-error declarations must provide a literal pattern');
      }
      const literal = pattern.getText(tree);
      const end = literal.lastIndexOf('/');
      found.push(new RegExp(literal.slice(1, end), literal.slice(end + 1)));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

const loss = patterns('loss.spec.ts');
const reveal = patterns('scene-reveal.spec.ts');
const declarations = [
  { name: 'backend device loss', pattern: loss[0]!,
    message: 'THREE.THREE.WebGPURenderer: WebGL Device Lost:\n\nMessage: Unknown reason',
    unrelated: 'THREE.WebGPURenderer: WebGL Device Lost:' },
  { name: 'reveal device loss', pattern: loss[1]!,
    message: "[archviz] transition error Your device's graphics restarted. Reload to continue where you left off.",
    unrelated: '[archviz] transition error Renderer initialization failed. Please retry.' },
  { name: 'injected reveal failure', pattern: reveal[0]!,
    message: '[archviz] transition error Injected transition failure',
    unrelated: '[archviz] transition error Unplanned transition failure' },
];

class FakePage extends EventEmitter {
  url(): string { return 'http://localhost/'; }
  get page(): Page { return this as unknown as Page; }
  report(text: string): void {
    this.emit('console', { type: () => 'error', text: () => text, args: () => [],
      location: () => ({ url: 'production.js', lineNumber: 0, columnNumber: 0 }) });
  }
}

it('covers every declaration in the intentional error specs', () => {
  expect(loss).toHaveLength(2);
  expect(reveal).toHaveLength(1);
});

describe.each(declarations)('$name declaration', ({ name, pattern, message, unrelated }) => {
  it('accepts the production diagnostic and rejects a different one', async () => {
    expect(pattern.test(message)).toBe(true);
    expect(pattern.test(unrelated)).toBe(false);
    const guard = new ErrorGuard();
    const page = new FakePage();
    guard.watchPage(page.page);
    guard.expectError(page.page, 'console', pattern, name);
    page.report(message);
    await expect(guard.assertClean()).resolves.toBeUndefined();
    guard.dispose();
  });

  it('still fails if the expected production diagnostic is absent', async () => {
    const guard = new ErrorGuard();
    const page = new FakePage();
    guard.watchPage(page.page);
    guard.expectError(page.page, 'console', pattern, name);
    await expect(guard.assertClean()).rejects.toThrow('Missing expected console');
    guard.dispose();
  });
});
