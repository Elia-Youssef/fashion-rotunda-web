// Whether the proof panel should be shown.

/** The overlay ships in production but stays off unless the URL asks for it; dev always shows it. */
export function overlayWanted(search: string, isDev: boolean): boolean {
  if (isDev) {
    return true;
  }
  return new URLSearchParams(search).get('proof') === '1';
}
