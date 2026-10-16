// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { lobbyWanted } from '../../src/ui/entry-lobby';
import { lobbyWanted as gateWanted } from '../../src/ui/entry-lobby/gate';

// Whether the entry lobby shows at all: the URL gate precedence rules.

describe('lobbyWanted precedence', () => {
  it('re-exports the gate function and preserves explicit gate precedence directly', () => {
    expect(lobbyWanted).toBe(gateWanted);
    expect(gateWanted('?e2e=1&gate=on')).toBe(true);
    expect(gateWanted('?e2e=1&gate=off')).toBe(false);
    expect(gateWanted('?e2e=1')).toBe(false);
    expect(gateWanted('?gate=unknown')).toBe(true);
  });

  it('shows the lobby for standard visitor URLs', () => {
    expect(lobbyWanted('')).toBe(true);
    expect(lobbyWanted('?webgl=1')).toBe(true);
    expect(lobbyWanted('?look=first')).toBe(true);
  });

  it('explicitly shows the lobby when gate=on, even if e2e=1', () => {
    expect(lobbyWanted('?gate=on')).toBe(true);
    expect(lobbyWanted('?e2e=1&gate=on')).toBe(true);
    expect(lobbyWanted('?gate=on&e2e=1')).toBe(true);
    expect(lobbyWanted('?e2e=1&gate=on&music=off')).toBe(true);
  });

  it('bypasses the lobby when gate=off', () => {
    expect(lobbyWanted('?gate=off')).toBe(false);
    expect(lobbyWanted('?gate=off&e2e=1')).toBe(false);
    expect(lobbyWanted('?e2e=1&gate=off')).toBe(false);
  });

  it('bypasses the lobby for automated direct-load tests when e2e=1 and gate is absent', () => {
    expect(lobbyWanted('?e2e=1')).toBe(false);
    expect(lobbyWanted('?webgl=1&e2e=1')).toBe(false);
    expect(lobbyWanted('?e2e=1&music=off')).toBe(false);
  });
});
