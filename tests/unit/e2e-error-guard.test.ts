import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, ConsoleMessage, Page } from '@playwright/test';
import { ErrorGuard } from '../e2e/support/error-guard';

class FakePage extends EventEmitter {
  readonly inspectArgument = vi.fn(async (fn: (value: unknown) => string, value: unknown) => fn(value));
  url(): string { return 'http://localhost/test'; }
  context(): BrowserContext { return this.owner as unknown as BrowserContext; }
  constructor(private readonly owner?: FakeContext) { super(); }
  get page(): Page { return this as unknown as Page; }

  console(type: string, text: string, args: unknown[] = []): void {
    this.emit('console', {
      type: () => type, text: () => text,
      location: () => ({ url: 'startup.ts', lineNumber: 12, columnNumber: 3 }),
      args: () => args.map((value) => ({
        evaluate: (fn: (value: unknown) => string) => this.inspectArgument(fn, value),
      })),
    } as unknown as ConsoleMessage);
  }
}

class FakeContext extends EventEmitter {
  private readonly created: FakePage[] = [];
  get context(): BrowserContext { return this as unknown as BrowserContext; }
  pages(): Page[] { return this.created.map((page) => page.page); }
  async newPage(): Promise<Page> {
    const page = new FakePage(this);
    this.created.push(page);
    this.emit('page', page.page);
    return page.page;
  }
}

function setup() {
  const guard = new ErrorGuard();
  const page = new FakePage();
  guard.watchPage(page.page);
  return { guard, page };
}

// All console event types other than errors and warnings carry text-only diagnostics.
const TEXT_ONLY_TYPES = [
  'log', 'debug', 'info', 'dir', 'dirxml', 'table', 'trace', 'clear', 'startGroup',
  'startGroupCollapsed', 'endGroup', 'assert', 'profile', 'profileEnd', 'count', 'time', 'timeEnd',
] satisfies ReturnType<ConsoleMessage['type']>[];

describe('browser error guard', () => {
  it.each(TEXT_ONLY_TYPES)('collects %s without evaluating any argument', async (type) => {
    const { guard, page } = setup();
    page.console(type, 'ordinary output', ['text', { message: 'diagnostic' }]);
    await guard.settled();
    await expect(guard.assertClean()).resolves.toBeUndefined();
    expect(page.inspectArgument).not.toHaveBeenCalled();
    expect(guard.reports(page.page)).toEqual([{
      kind: 'console', type, text: 'ordinary output', detail: 'ordinary output',
      location: 'startup.ts:12:3',
    }]);
  });

  it.each(TEXT_ONLY_TYPES)('still rejects GPU diagnostics in %s text without evaluation', async (type) => {
    const { guard, page } = setup();
    page.console(type, 'GPUValidationError: invalid binding', [{ message: 'diagnostic' }]);
    await expect(guard.assertClean()).rejects.toThrow(`Unexpected console ${type}: GPUValidationError`);
    expect(page.inspectArgument).not.toHaveBeenCalled();
  });

  it('fails for every unexpected console error with its message and location', async () => {
    const { guard, page } = setup();
    page.console('error', 'startup broke');
    page.console('error', 'second failure');
    await expect(guard.assertClean()).rejects.toThrow(
      'Unexpected console error: startup broke [startup.ts:12:3]\n' +
      'Unexpected console error: second failure [startup.ts:12:3]',
    );
  });

  it('passes for a declared expected console error and remains repeatable', async () => {
    const { guard, page } = setup();
    guard.expectError(page.page, 'console', /Device Lost/g, 'deliberate device loss');
    page.console('error', 'WebGL Device Lost');
    await expect(guard.assertClean()).resolves.toBeUndefined();
    await expect(guard.assertClean()).resolves.toBeUndefined();
  });

  it('fails when a declared error never happens and prints its reason', async () => {
    const { guard, page } = setup();
    guard.expectError(page.page, 'console', /Device Lost/, 'deliberate device loss');
    await expect(guard.assertClean()).rejects.toThrow(
      'Missing expected console /Device Lost/: deliberate device loss',
    );
  });

  it('consumes each declaration separately when one fault reports two distinct errors', async () => {
    const { guard, page } = setup();
    guard.expectError(page.page, 'console', /Device Lost/, 'the backend reports deliberate device loss');
    guard.expectError(page.page, 'console', /transition error/, 'the reveal reports the same device loss');
    page.console('error', 'Device Lost');
    page.console('error', 'transition error');
    await expect(guard.assertClean()).resolves.toBeUndefined();
  });

  it('does not fail for ordinary warnings, info or logs and retains them for spec assertions', async () => {
    const { guard, page } = setup();
    page.console('warning', 'unknown look');
    page.console('info', '[archviz] renderer backend: webgl2');
    page.console('log', 'diagnostic');
    await expect(guard.assertClean()).resolves.toBeUndefined();
    expect(guard.reports(page.page).map((report) => report.text)).toEqual([
      'unknown look', '[archviz] renderer backend: webgl2', 'diagnostic',
    ]);
  });

  it('fails for uncaught page errors even when a console error of the same text is expected', async () => {
    const { guard, page } = setup();
    guard.expectError(page.page, 'console', /Device Lost/, 'deliberate device loss');
    page.emit('pageerror', new TypeError('Device Lost'));
    await expect(guard.assertClean()).rejects.toThrow('Unexpected pageerror TypeError: TypeError: Device Lost');
    await expect(guard.assertClean()).rejects.toThrow('Missing expected console');
  });

  it.each([
    'GPUValidationError: invalid binding',
    'Texture copy range exceeds texture dimensions',
    'WebGPURenderer: Uncaptured WebGPU GPUInternalError',
    'GPUOutOfMemoryError: allocation failed',
  ])('fails for validation or uncaptured errors reported as warnings: %s', async (text) => {
    const { guard, page } = setup();
    page.console('warning', text);
    await expect(guard.assertClean()).rejects.toThrow(text);
  });

  it.each(['error', 'warning'])('awaits hidden GPU object details in %s events', async (type) => {
    const { guard, page } = setup();
    page.console(type, 'GPU object', [{ name: 'GPUValidationError', message: 'Texture copy range overflow' }]);
    await expect(guard.assertClean()).rejects.toThrow('GPUValidationError: Texture copy range overflow');
    expect(page.inspectArgument).toHaveBeenCalledOnce();
  });

  it('retains hidden error fields for expected console error declarations', async () => {
    const { guard, page } = setup();
    guard.expectError(page.page, 'console', /Error: Device Lost/, 'deliberate device loss');
    page.console('error', 'backend object', [new Error('Device Lost')]);
    await expect(guard.assertClean()).resolves.toBeUndefined();
    expect(page.inspectArgument).toHaveBeenCalledOnce();
  });

  it('cannot excuse a hidden GPU warning with a console error declaration', async () => {
    const { guard, page } = setup();
    guard.expectError(page.page, 'console', /GPUInternalError/, 'deliberate backend error');
    page.console('warning', 'backend object', [{ type: 'GPUInternalError' }]);
    await expect(guard.assertClean()).rejects.toThrow('Unexpected console warning: backend object | GPUInternalError');
    await expect(guard.assertClean()).rejects.toThrow('Missing expected console');
  });

  it('retains synchronous errors when argument handles were destroyed on navigation', async () => {
    const { guard, page } = setup();
    page.emit('console', {
      type: () => 'error', text: () => 'before reload',
      location: () => ({ url: 'startup.ts', lineNumber: 12, columnNumber: 3 }),
      args: () => [{ evaluate: async () => { throw new Error('Execution context was destroyed'); } }],
    });
    await expect(guard.assertClean()).rejects.toThrow('before reload');
  });

  it('requires declarations before the event and cannot forgive an earlier error', async () => {
    const { guard, page } = setup();
    page.console('error', 'Device Lost');
    guard.expectError(page.page, 'console', /Device Lost/, 'deliberate device loss');
    await expect(guard.assertClean()).rejects.toThrow('Unexpected console');
    await expect(guard.assertClean()).rejects.toThrow('Missing expected console');
  });

  it('does not allow extra occurrences behind one declaration', async () => {
    const { guard, page } = setup();
    guard.expectError(page.page, 'console', /Device Lost/, 'deliberate device loss');
    page.console('error', 'Device Lost');
    page.console('error', 'Device Lost');
    await expect(guard.assertClean()).rejects.toThrow('Unexpected console');
  });

  it('matches declarations only on their own page and only for console errors', async () => {
    const { guard, page } = setup();
    const other = new FakePage();
    guard.watchPage(other.page);
    guard.expectError(page.page, 'console', /Device Lost|GPUValidationError/, 'deliberate device loss');
    other.console('error', 'Device Lost');
    page.console('warning', 'GPUValidationError');
    await expect(guard.assertClean()).rejects.toThrow('Unexpected console error: Device Lost');
    await expect(guard.assertClean()).rejects.toThrow('Unexpected console warning: GPUValidationError');
    await expect(guard.assertClean()).rejects.toThrow('Missing expected console');
  });

  it('rejects declarations without a reason or without a guarded page', () => {
    const { guard, page } = setup();
    expect(() => guard.expectError(page.page, 'console', /lost/, ' ')).toThrow('needs a reason');
    expect(() => guard.expectError(new FakePage().page, 'console', /lost/, 'loss')).toThrow('guarded page');
  });

  it('watches existing and future context pages once and detaches listeners at teardown', async () => {
    const context = new FakeContext();
    const existing = await context.newPage() as unknown as FakePage;
    const registered: Page[] = [];
    const guard = new ErrorGuard((page) => registered.push(page));
    guard.watchContext(context.context);
    guard.watchContext(context.context);
    const popup = await context.newPage() as unknown as FakePage;
    guard.watchPage(popup.page);
    expect(registered).toEqual([existing.page, popup.page]);
    expect(popup.listenerCount('console')).toBe(1);
    existing.console('warning', 'old page');
    popup.console('error', 'popup failure');
    await expect(guard.assertClean()).rejects.toThrow('popup failure');
    guard.dispose();
    expect(context.listenerCount('page')).toBe(0);
    expect(existing.listenerCount('console')).toBe(0);
    expect(popup.listenerCount('pageerror')).toBe(0);
  });

  it('guards manual browser contexts and direct pages before callers can navigate', async () => {
    const context = new FakeContext();
    const directContext = new FakeContext();
    const browser = {
      newContext: async () => context.context,
      newPage: async () => directContext.newPage(),
      contexts() { return [context.context]; },
    } as unknown as Browser;
    const guard = new ErrorGuard();
    const facade = guard.browser(browser);
    const manual = await facade.newContext();
    const page = await manual.newPage() as unknown as FakePage;
    const direct = await facade.newPage() as unknown as FakePage;
    page.console('error', 'manual context failure');
    direct.console('error', 'direct page failure');
    expect(facade.contexts()).toEqual([context.context]);
    await expect(guard.assertClean()).rejects.toThrow('manual context failure');
    await expect(guard.assertClean()).rejects.toThrow('direct page failure');
  });
});
