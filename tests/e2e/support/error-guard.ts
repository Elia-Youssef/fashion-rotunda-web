import type { Browser, BrowserContext, ConsoleMessage, Page } from '@playwright/test';

// Validation diagnostics sometimes arrive as warnings or as truncated object previews.
const GPU_ERROR = /GPU(?:Validation|OutOfMemory|Internal)Error|Texture copy range|uncaptured.*(?:WebGPU|GPU)|WebGPURenderer: Uncaptured/i;

export interface BrowserReport {
  kind: 'console' | 'pageerror';
  type: string;
  text: string;
  detail: string;
  location: string;
}

interface ExpectedError {
  page: Page;
  kind: BrowserReport['kind'];
  pattern: RegExp;
  reason: string;
  remaining: number;
}

interface RecordedReport {
  page: Page;
  report: BrowserReport;
  eligible: ExpectedError[];
}

/** Pure event collection and checking; no Playwright runtime is imported here. */
export class ErrorGuard {
  private readonly pages = new Map<Page, { console: (message: ConsoleMessage) => void; error: (error: Error) => void }>();
  private readonly contexts = new Map<BrowserContext, (page: Page) => void>();
  private readonly records: RecordedReport[] = [];
  private readonly expected: ExpectedError[] = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly onPage: (page: Page) => void = () => {}) {}

  watchContext(context: BrowserContext): void {
    if (this.contexts.has(context)) return;
    const watch = (page: Page): void => this.watchPage(page);
    context.on('page', watch);
    this.contexts.set(context, watch);
    for (const page of context.pages()) this.watchPage(page);
  }

  watchPage(page: Page): void {
    if (this.pages.has(page)) return;
    const console = (message: ConsoleMessage): void => {
      const source = message.location();
      const report: BrowserReport = {
        kind: 'console', type: message.type(), text: message.text(), detail: message.text(),
        location: `${source.url}:${source.lineNumber}:${source.columnNumber}`,
      };
      this.record(page, report);
      // Each handle.evaluate grants the page user activation. Only errors and warnings need
      // object details: backend errors and post-fallback warnings can hide GPU diagnostics in
      // truncated previews. Keep their inspection before navigation destroys the handles;
      // every other console type is checked from its synchronous text without touching the page.
      if (report.type !== 'error' && report.type !== 'warning') return;
      const task = Promise.all(message.args().map((handle) => handle.evaluate((value: unknown) => {
        if (typeof value === 'object' && value !== null) {
          return ['name', 'type', 'message'].map((key) => {
            const field = (value as Record<string, unknown>)[key];
            return typeof field === 'string' ? field : '';
          }).filter(Boolean).join(': ');
        }
        return '';
      }).catch(() => ''))).then((parts) => {
        report.detail = [report.text, ...parts.filter(Boolean)].join(' | ');
      });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    };
    const error = (error: Error): void => this.record(page, {
      kind: 'pageerror', type: error.name, text: error.message,
      detail: `${error.name}: ${error.message}`, location: page.url(),
    });
    page.on('console', console);
    page.on('pageerror', error);
    this.pages.set(page, { console, error });
    this.onPage(page);
  }

  private record(page: Page, report: BrowserReport): void {
    this.records.push({ page, report, eligible: this.expected.filter((item) => item.page === page) });
  }

  expectError(page: Page, kind: BrowserReport['kind'], pattern: RegExp, reason: string): void {
    if (!reason.trim()) throw new Error('An expected browser error needs a reason');
    if (!this.pages.has(page)) throw new Error('Expected errors require a guarded page');
    // Each declaration consumes one event, so a repeated error cannot disappear behind a whitelist.
    this.expected.push({ page, kind, pattern: new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')),
      reason, remaining: 1 });
  }

  reports(page: Page): BrowserReport[] {
    return this.records.filter((item) => item.page === page).map((item) => item.report);
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  async assertClean(): Promise<void> {
    await this.settled();
    const failures: string[] = [];
    // Checking is repeatable; callers may collect diagnostics before fixture teardown.
    const remaining = new Map(this.expected.map((item) => [item, item.remaining]));
    for (const { report, eligible } of this.records) {
      const isError = report.kind === 'pageerror' || report.type === 'error' || GPU_ERROR.test(report.detail);
      if (!isError) continue;
      const match = eligible.find((item) => item.kind === report.kind &&
        // A console-error declaration cannot swallow validation warnings.
        (report.kind !== 'console' || report.type === 'error') &&
        remaining.get(item)! > 0 && item.pattern.test(report.detail));
      if (match) remaining.set(match, remaining.get(match)! - 1);
      else failures.push(`Unexpected ${report.kind} ${report.type}: ${report.detail} [${report.location}]`);
    }
    for (const item of this.expected) {
      if (remaining.get(item)! > 0) {
        failures.push(`Missing expected ${item.kind} ${item.pattern}: ${item.reason}`);
      }
    }
    if (failures.length > 0) throw new Error(`Browser error guard failed:\n${failures.join('\n')}`);
  }

  /** A test-scoped facade covers pages in manually created contexts too. */
  browser(browser: Browser): Browser {
    return new Proxy(browser, {
      get: (target, property) => {
        if (property === 'newContext') return async (...args: Parameters<Browser['newContext']>) => {
          const context = await target.newContext(...args);
          this.watchContext(context);
          return context;
        };
        if (property === 'newPage') return async (...args: Parameters<Browser['newPage']>) => {
          const page = await target.newPage(...args);
          this.watchContext(page.context());
          return page;
        };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  dispose(): void {
    for (const [context, listener] of this.contexts) context.off('page', listener);
    for (const [page, listeners] of this.pages) {
      page.off('console', listeners.console);
      page.off('pageerror', listeners.error);
    }
  }
}
