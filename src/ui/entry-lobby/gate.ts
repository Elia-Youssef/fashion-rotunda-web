/**
 * Evaluates query parameter precedence for showing the entry lobby:
 * - gate=on explicitly shows the lobby, including when e2e=1.
 * - gate=off explicitly bypasses the lobby and starts loading immediately.
 * - absent gate plus e2e=1 preserves existing direct-load test behavior.
 * - ordinary visitor URLs show the lobby.
 */
export function lobbyWanted(search: string): boolean {
  const params = new URLSearchParams(search);
  const gate = params.get('gate');
  if (gate === 'on') {
    return true;
  }
  if (gate === 'off') {
    return false;
  }
  if (params.get('e2e') === '1') {
    return false;
  }
  return true;
}
