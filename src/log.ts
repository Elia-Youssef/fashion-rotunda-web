// The console gate for the routine [archviz] info lines. A visitor's console stays quiet:
// an info line prints only for a session that asked for diagnostics, through the proof
// overlay (?proof=1), the test harness (?e2e=1) or the dev server. Warnings and errors
// bypass this module and keep their own always-on console calls.

/** The pure gate: a dev session hears everything; otherwise the URL must ask for it. */
export function diagnosticsWanted(search: string, isDev: boolean): boolean {
  if (isDev) {
    return true;
  }
  const params = new URLSearchParams(search);
  return params.get('proof') === '1' || params.get('e2e') === '1';
}

function currentSearch(): string {
  // Node test processes have no location; a session with no URL has asked for nothing.
  return typeof location === 'undefined' ? '' : location.search;
}

/** Routes the routine info lines; call it where a visitor should hear nothing. */
export function info(message: string, ...rest: unknown[]): void {
  if (!diagnosticsWanted(currentSearch(), import.meta.env.DEV)) {
    return;
  }
  console.info(message, ...rest);
}
