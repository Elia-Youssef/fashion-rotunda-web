// @vitest-environment jsdom
// Contracts of the scene reveal coordinator that the behaviour suite does not pin:
// the published timestamps, the veil and lobby attributes at each phase, what fail()
// shows, the cancellation paths at every park point, and the disruption restarts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryLobby, LobbyState } from '../../src/ui/entry-lobby';
import {
  SceneRevealCoordinator,
  READY_HIDDEN_HOLD_MS,
  COVER_TO_BLACK_MS,
  BLACK_HOLD_MIN_MS,
  REVEAL_MS,
} from '../../src/ui/scene-reveal';
import type { ReadinessPredicates, TransitionSeam } from '../../src/ui/scene-reveal';
import { assertFreshStableFrames } from '../e2e/support/reveal-disruption';

const E2E_GATE = '?e2e=1&gate=on';

function createLobby(): EntryLobby {
  let state: LobbyState = 'ready-hidden';
  const element = document.createElement('div');
  element.id = 'entry-lobby';
  element.dataset.state = state;
  document.body.appendChild(element);
  return {
    get state() {
      return state;
    },
    get element() {
      return element;
    },
    waitForLoadRequest: vi.fn().mockResolvedValue({ musicPreference: 'on' }),
    trackProgress: vi.fn().mockReturnValue(() => {}),
    setProgress: vi.fn(),
    setReady: vi.fn(() => {
      state = 'ready-hidden';
      element.dataset.state = state;
    }),
    setCoverToBlack: vi.fn(() => {
      state = 'cover-to-black';
      element.dataset.state = state;
    }),
    setBlackHold: vi.fn(() => {
      state = 'black-hold';
      element.dataset.state = state;
    }),
    setRevealing: vi.fn(() => {
      state = 'revealing';
      element.dataset.state = state;
    }),
    setRevealed: vi.fn(() => {
      state = 'revealed';
      element.dataset.state = state;
      element.hidden = true;
    }),
    setError: vi.fn(() => {
      state = 'error';
      element.dataset.state = state;
    }),
    setUnsupported: vi.fn(() => {
      state = 'error';
      element.dataset.state = state;
    }),
    waitUntilReadyHidden: vi.fn().mockResolvedValue(undefined),
    prepareForReveal: vi.fn(),
    dispose: vi.fn(() => {
      state = 'disposed';
      element.remove();
    }),
  };
}

function createPredicates(): ReadinessPredicates {
  return {
    rendererExists: () => true,
    backendActive: () => true,
    canvasSized: () => true,
    tierSettled: () => true,
    showroomExists: () => true,
    staticsMounted: () => true,
    lookAndVariantMounted: () => true,
    cameraPoseActive: () => true,
    lightingAttached: () => true,
    postChainAssembled: () => true,
    shadersCompiled: () => true,
    noError: () => true,
    realFrameCompleted: () => true,
  };
}

function reducedMotionMedia(): typeof window.matchMedia {
  return vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

interface FrameQueue {
  resolvers: (() => void)[];
  requestCount: () => number;
  onFrameRequest: () => Promise<void>;
}

function manualFrames(): FrameQueue {
  const resolvers: (() => void)[] = [];
  let count = 0;
  return {
    resolvers,
    requestCount: () => count,
    onFrameRequest: () => {
      count += 1;
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
}

async function completeOneFrame(queue: FrameQueue): Promise<void> {
  expect(queue.resolvers, 'exactly one scheduled render must be pending').toHaveLength(1);
  queue.resolvers.shift()!();
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Resolves scheduled frames and idle waits until the run settles or `done` holds true.
 * `onStall` runs whenever no frame is pending and nothing has advanced, which is where a
 * real run can only be waiting for the tab to become visible again.
 */
async function driveUntil(
  run: Promise<void>,
  queue: FrameQueue,
  done: () => boolean,
  onStall?: () => void,
): Promise<void> {
  let settled = false;
  void run.then(() => {
    settled = true;
  });
  for (let step = 0; step < 90 && !settled && !done(); step += 1) {
    if (queue.resolvers.length > 0) {
      queue.resolvers.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      continue;
    }
    onStall?.();
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(settled || done(), 'the transition reached its expected stop').toBe(true);
  if (settled) {
    await run;
  }
}

describe('SceneRevealCoordinator contracts', () => {
  let canvas: HTMLCanvasElement;
  let lobby: EntryLobby;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.id = 'scene';
    document.body.appendChild(canvas);
    lobby = createLobby();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    setHidden(false);
    delete window.archvizTransitionSeam;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function autoFrames(): { onFrameRequest: () => Promise<void> } {
    return { onFrameRequest: vi.fn().mockResolvedValue(undefined) };
  }

  it('pins the four transition durations, with the reveal matching the CSS fade', () => {
    expect(READY_HIDDEN_HOLD_MS).toBe(250);
    expect(COVER_TO_BLACK_MS).toBe(250);
    expect(BLACK_HOLD_MIN_MS).toBe(200);
    expect(REVEAL_MS).toBe(600);
    // The veil fades through --dur-scene-reveal; the coordinator must time the same duration.
    // jsdom rewrites import.meta.url, so the path resolves from the vitest working directory.
    const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    expect(styles).toContain(`--dur-scene-reveal: ${REVEAL_MS}ms;`);
  });

  it('publishes every transition timestamp at its phase, in order', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(0);
    let ts = coordinator.transitionTimestamps;
    expect(typeof ts.readyHidden).toBe('number');
    expect(ts.coverStart).toBeNull();
    expect(ts.coverEnd).toBeNull();
    expect(ts.holdStart).toBeNull();
    expect(ts.holdEnd).toBeNull();
    expect(ts.revealStart).toBeNull();
    expect(ts.revealEnd).toBeNull();

    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + 1);
    ts = coordinator.transitionTimestamps;
    expect(typeof ts.coverStart).toBe('number');
    expect(ts.coverEnd).toBeNull();

    await vi.advanceTimersByTimeAsync(COVER_TO_BLACK_MS + 1);
    ts = coordinator.transitionTimestamps;
    expect(typeof ts.coverEnd).toBe('number');
    expect(typeof ts.holdStart).toBe('number');
    expect(ts.holdEnd).toBeNull();

    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + 1);
    ts = coordinator.transitionTimestamps;
    expect(typeof ts.holdEnd).toBe('number');
    expect(typeof ts.revealStart).toBe('number');
    expect(ts.revealEnd).toBeNull();

    await vi.advanceTimersByTimeAsync(REVEAL_MS + 1);
    await run;
    ts = coordinator.transitionTimestamps;
    expect(typeof ts.revealEnd).toBe('number');
    expect(ts.readyHidden!).toBeLessThanOrEqual(ts.coverStart!);
    expect(ts.coverStart!).toBeLessThanOrEqual(ts.coverEnd!);
    expect(ts.coverEnd!).toBeLessThanOrEqual(ts.holdStart!);
    expect(ts.holdStart!).toBeLessThanOrEqual(ts.holdEnd!);
    expect(ts.holdEnd!).toBeLessThanOrEqual(ts.revealStart!);
    expect(ts.revealStart!).toBeLessThanOrEqual(ts.revealEnd!);
  });

  it('hands out copies of the transition timestamps', () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const first = coordinator.transitionTimestamps;
    first.coverStart = -1;
    expect(coordinator.transitionTimestamps.coverStart).toBeNull();
    expect(coordinator.transitionTimestamps).not.toBe(first);
    coordinator.dispose();
  });

  it('mounts the veil inside the caller root and reuses an existing veil', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const first = new SceneRevealCoordinator({
      root, canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    expect(first.veil.parentElement).toBe(root);
    first.dispose();

    const existing = document.createElement('div');
    existing.id = 'scene-veil';
    root.appendChild(existing);
    const second = new SceneRevealCoordinator({
      root, canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    expect(second.veil).toBe(existing);
    expect(root.querySelectorAll('#scene-veil')).toHaveLength(1);
    expect(second.veil.dataset.state).toBe('ready-hidden');
    second.dispose();
  });

  it('creates the veil in the document that owns a foreign root', () => {
    const otherDoc = document.implementation.createHTMLDocument('reveal');
    const root = otherDoc.createElement('div');
    otherDoc.body.appendChild(root);
    const coordinator = new SceneRevealCoordinator({
      root, canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    expect(coordinator.veil.ownerDocument).toBe(otherDoc);
    expect(root.querySelector('#scene-veil')).toBe(coordinator.veil);
    coordinator.dispose();
  });

  it('latches the first failure; a second fail changes nothing', () => {
    const onError = vi.fn();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(), onError,
    });
    coordinator.fail('first failure');
    coordinator.fail('second failure');
    expect(coordinator.state).toBe('error');
    expect(lobby.setError).toHaveBeenCalledExactlyOnceWith('first failure', undefined);
    expect(onError).toHaveBeenCalledExactlyOnceWith('first failure');
    expect(lobby.setRevealed).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('hides the veil inline and reports an Error by its message', () => {
    const onError = vi.fn();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(), onError,
    });
    coordinator.fail(new Error('renderer vanished'));
    expect(coordinator.veil.hidden).toBe(true);
    expect(coordinator.veil.style.display).toBe('none');
    expect(lobby.setError).toHaveBeenCalledExactlyOnceWith('renderer vanished', undefined);
    expect(onError).toHaveBeenCalledExactlyOnceWith('renderer vanished');
    coordinator.dispose();
  });

  it('fails without a lobby and without an onError callback', () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby: null, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(), onError: vi.fn(),
    });
    expect(() => coordinator.fail('renderer lost')).not.toThrow();
    expect(coordinator.state).toBe('error');
    coordinator.dispose();
  });

  it('runs the whole transition, and a disruption, with no lobby at all', async () => {
    const onRevealed = vi.fn();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby: null, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(), onRevealed,
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + 10);
    expect(coordinator.state).toBe('black-hold');
    window.dispatchEvent(new Event('resize'));
    expect(coordinator.state).toBe('black-hold');
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS + 500);
    await run;
    expect(coordinator.state).toBe('revealed');
    expect(coordinator.veil.hidden).toBe(true);
    expect(coordinator.veil.style.display).toBe('none');
    expect(onRevealed).toHaveBeenCalledOnce();
    expect(coordinator.veil.isConnected).toBe(false);
  });

  it('marks geometry unstable when any single dimension changes', () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    expect(coordinator.evaluatePredicates().geometryStable).toBe(true);
    vi.stubGlobal('innerWidth', window.innerWidth + 1);
    expect(coordinator.evaluatePredicates().geometryStable).toBe(false);
    vi.unstubAllGlobals();
    vi.stubGlobal('innerHeight', window.innerHeight + 1);
    expect(coordinator.evaluatePredicates().geometryStable).toBe(false);
    vi.unstubAllGlobals();
    vi.stubGlobal('devicePixelRatio', window.devicePixelRatio + 1);
    expect(coordinator.evaluatePredicates().geometryStable).toBe(false);
    vi.unstubAllGlobals();
    expect(coordinator.evaluatePredicates().geometryStable).toBe(true);
    coordinator.dispose();
  });

  it('treats geometry as stable when there is no window', () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    vi.stubGlobal('window', undefined);
    expect(coordinator.evaluatePredicates().geometryStable).toBe(true);
    vi.unstubAllGlobals();
    coordinator.dispose();
  });

  it('reads documentVisible as true when there is no document', () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    vi.stubGlobal('document', undefined);
    expect(coordinator.evaluatePredicates().documentVisible).toBe(true);
    vi.unstubAllGlobals();
    coordinator.dispose();
  });

  it('exposes the seam predicates and constructs the guarded seam without a window', () => {
    vi.stubGlobal('window', undefined);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const created: { coordinator: SceneRevealCoordinator | null } = { coordinator: null };
    expect(() => {
      created.coordinator = new SceneRevealCoordinator({
        root, canvas, search: E2E_GATE, lobby, predicates: createPredicates(),
        wakeRenderer: vi.fn(), ...autoFrames(),
      });
    }).not.toThrow();
    vi.unstubAllGlobals();
    created.coordinator?.dispose();

    const coordinator = new SceneRevealCoordinator({
      canvas, search: E2E_GATE, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const seam = window.archvizTransitionSeam!;
    expect(seam.readPredicates()).toEqual({
      rendererExists: true,
      backendActive: true,
      canvasSized: true,
      tierSettled: true,
      showroomExists: true,
      staticsMounted: true,
      lookAndVariantMounted: true,
      cameraPoseActive: true,
      lightingAttached: true,
      postChainAssembled: true,
      shadersCompiled: true,
      noError: true,
      realFrameCompleted: true,
      documentVisible: true,
      geometryStable: true,
    });
    coordinator.dispose();
  });

  it('unfreezes harmlessly before anything is parked', () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: E2E_GATE, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const seam = window.archvizTransitionSeam!;
    expect(() => seam.unfreeze()).not.toThrow();
    expect(seam.parked).toBe(false);
    coordinator.dispose();
  });

  it('ignores a visibilitychange with nothing parked, and still wakes the renderer', () => {
    const wakeRenderer = vi.fn();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer, ...autoFrames(),
    });
    expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
    expect(wakeRenderer).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('parks at ready-hidden before the quiet hold and reports parked only at black-hold', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=ready-hidden`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(10);
    expect(coordinator.state).toBe('ready-hidden');
    expect(seam.parked).toBe(false);
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + 1000);
    expect(coordinator.state).toBe('ready-hidden');
    expect(coordinator.transitionTimestamps.coverStart).toBeNull();
    seam.unfreeze();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + REVEAL_MS + 500,
    );
    await run;
    expect(coordinator.state).toBe('revealed');
  });

  it('parks after the lobby cover when frozen at cover-to-black', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=cover-to-black`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + 1);
    expect(coordinator.state).toBe('cover-to-black');
    await vi.advanceTimersByTimeAsync(COVER_TO_BLACK_MS + 1000);
    expect(coordinator.state).toBe('cover-to-black');
    expect(coordinator.transitionTimestamps.coverEnd).not.toBeNull();
    expect(coordinator.transitionTimestamps.revealStart).toBeNull();
    window.archvizTransitionSeam!.unfreeze();
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS + 500);
    await run;
    expect(coordinator.state).toBe('revealed');
  });

  it('re-enters black hold when a disruption lands during the lobby cover', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + 10);
    expect(coordinator.state).toBe('cover-to-black');
    window.dispatchEvent(new Event('resize'));
    expect(coordinator.state).toBe('black-hold');
    expect(coordinator.veil.dataset.state).toBe('black-hold');
    expect(lobby.setBlackHold).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS + 1000);
    await run;
    expect(coordinator.state).toBe('revealed');
  });

  it('restarts under black when a disruption lands mid-reveal', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=revealing`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + 100,
    );
    expect(coordinator.state).toBe('revealing');
    window.dispatchEvent(new Event('resize'));
    expect(seam.state).toBe('black-hold');
    expect(seam.generation).toBe(1);
    expect(seam.stableFrames).toBe(0);
    expect(coordinator.veil.dataset.state).toBe('black-hold');
    seam.unfreeze();
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS + 1000);
    await run;
    expect(coordinator.state).toBe('revealed');
  });

  it('does not restart from a disruption inside the revealed callbacks', async () => {
    let observed = '';
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
      onRevealed: () => {
        window.dispatchEvent(new Event('resize'));
        observed = coordinator.state;
      },
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + REVEAL_MS + 500,
    );
    await run;
    expect(observed).toBe('revealed');
    expect(coordinator.state).toBe('revealed');
  });

  it('keeps a disposed coordinator from restabilizing', async () => {
    const onFrameRequest = vi.fn(async () => {
      coordinator.dispose();
      vi.stubGlobal('innerWidth', window.innerWidth + 40);
    });    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest,
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + 10);
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(lobby.setBlackHold).toHaveBeenCalledTimes(1);
    expect(coordinator.state).not.toBe('revealed');
    expect(lobby.setRevealing).not.toHaveBeenCalled();
  });

  it('keeps a failure latched when a disruption coincides with it', async () => {
    const onFrameRequest = vi.fn(async () => {
      coordinator.fail('renderer lost');
      vi.stubGlobal('innerWidth', window.innerWidth + 40);
    });    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest,
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + 10);
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(coordinator.state).toBe('error');
    expect(lobby.setError).toHaveBeenCalledExactlyOnceWith('renderer lost', undefined);
    expect(lobby.setBlackHold).toHaveBeenCalledTimes(1);
  });

  it('stops the stable-frame loop at disposal without a further frame request', async () => {
    const onFrameRequest = vi.fn(async () => {
      if (onFrameRequest.mock.calls.length === 2) {
        coordinator.dispose();
      }
    });    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest,
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + 200,
    );
    await run;
    expect(onFrameRequest).toHaveBeenCalledTimes(2);
    expect(coordinator.transitionTimestamps.holdEnd).toBeNull();
    expect(lobby.setRevealing).not.toHaveBeenCalled();
    expect(lobby.setBlackHold).toHaveBeenCalledTimes(1);
  });

  it('stops the stable-frame loop at failure and keeps the error state', async () => {
    const onFrameRequest = vi.fn(async () => {
      if (onFrameRequest.mock.calls.length === 2) {
        coordinator.fail('lost mid-handshake');
      }
    });    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest,
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + 200,
    );
    await run;
    expect(coordinator.state).toBe('error');
    expect(lobby.setError).toHaveBeenCalledExactlyOnceWith('lost mid-handshake', undefined);
    expect(onFrameRequest).toHaveBeenCalledTimes(2);
    expect(coordinator.transitionTimestamps.holdEnd).toBeNull();
    expect(lobby.setBlackHold).toHaveBeenCalledTimes(1);
  });

  it('settles without re-entering the handshake when disposal lands while parked for visibility', async () => {
    window.matchMedia = reducedMotionMedia();
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.resolvers).toHaveLength(1);
    setHidden(true);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(0);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(queue.resolvers).toHaveLength(0);
    expect(lobby.setBlackHold).toHaveBeenCalledTimes(2);
  });

  it('settles execute when disposal lands while the tab is hidden before the cover', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    setHidden(true);
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.state).toBe('ready-hidden');
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(coordinator.state).not.toBe('revealed');
  });

  it('settles execute when a failure lands while the tab is hidden before the cover', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    setHidden(true);
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(0);
    coordinator.fail('startup collapsed');
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(coordinator.state).toBe('error');
    expect(lobby.setError).toHaveBeenCalledExactlyOnceWith('startup collapsed', undefined);
  });

  it('settles execute when disposal lands during the quiet hold', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(100);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(coordinator.state).not.toBe('revealed');
    expect(lobby.setRevealing).not.toHaveBeenCalled();
  });

  it('settles execute when a failure lands during the quiet hold', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(100);
    coordinator.fail('startup collapsed');
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(lobby.setError).toHaveBeenCalledExactlyOnceWith('startup collapsed', undefined);
    expect(coordinator.state).not.toBe('revealed');
    expect(lobby.setRevealing).not.toHaveBeenCalled();
  });

  it('stops a hidden-parked wait at disposal without spending its budget', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(100);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(60);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(coordinator.state).not.toBe('revealed');
  });

  it('settles execute when disposal lands during the cover wait at the cover freeze', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=cover-to-black`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + 10);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(coordinator.state).not.toBe('revealed');
  });

  it('settles execute when a failure lands during the cover wait at the cover freeze', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=cover-to-black`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + 10);
    coordinator.fail('mid-cover failure');
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(coordinator.state).toBe('error');
    expect(lobby.setError).toHaveBeenCalledExactlyOnceWith('mid-cover failure', undefined);
  });

  it('does nothing when execute runs after disposal', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    coordinator.dispose();
    await coordinator.execute();
    expect(lobby.prepareForReveal).not.toHaveBeenCalled();
    expect(lobby.setCoverToBlack).not.toHaveBeenCalled();
    expect(coordinator.state).not.toBe('revealed');
  });

  it('does nothing when execute runs after a failure', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    coordinator.fail('already failed');
    await coordinator.execute();
    expect(coordinator.state).toBe('error');
    expect(lobby.setError).toHaveBeenCalledExactlyOnceWith('already failed', undefined);
    expect(lobby.setRevealed).not.toHaveBeenCalled();
  });

  it('makes no lobby calls when disposal lands while parked at the ready-hidden freeze', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=ready-hidden`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(10);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + REVEAL_MS + 500,
    );
    await run;
    expect(lobby.setCoverToBlack).not.toHaveBeenCalled();
    expect(lobby.setRevealing).not.toHaveBeenCalled();
    expect(lobby.setRevealed).not.toHaveBeenCalled();
  });

  it('skips the lobby cover when a disruption lands during the quiet hold', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event('resize'));
    expect(coordinator.state).toBe('black-hold');
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + REVEAL_MS + 500,
    );
    await run;
    expect(lobby.setCoverToBlack).not.toHaveBeenCalled();
    expect(coordinator.transitionTimestamps.coverStart).toBeNull();
    expect(coordinator.state).toBe('revealed');
  });

  it('skips the lobby cover when the tab is hidden at the ready-hidden freeze', async () => {
    window.matchMedia = reducedMotionMedia();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=ready-hidden`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(10);
    setHidden(true);
    window.archvizTransitionSeam!.unfreeze();
    await vi.advanceTimersByTimeAsync(0);
    expect(lobby.setCoverToBlack).not.toHaveBeenCalled();
    expect(coordinator.state).not.toBe('cover-to-black');
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + REVEAL_MS + 500,
    );
    await run;
    expect(coordinator.state).toBe('revealed');
  });

  it('never reveals when disposal lands while parked at the black-hold freeze', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS);
    expect(seam.parked).toBe(true);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(lobby.setRevealing).not.toHaveBeenCalled();
    expect(coordinator.state).toBe('black-hold');
  });

  it('marks the veil for the paused fade only under the revealing freeze', async () => {
    const live = new SceneRevealCoordinator({
      canvas, search: '', lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const liveRun = live.execute();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + 50,
    );
    expect(live.state).toBe('revealing');
    expect(live.veil.dataset.e2eFreeze).toBeUndefined();
    await vi.advanceTimersByTimeAsync(REVEAL_MS + 100);
    await liveRun;
    expect(live.state).toBe('revealed');

    const frozen = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=revealing`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), ...autoFrames(),
    });
    const frozenRun = frozen.execute();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + 100,
    );
    expect(frozen.state).toBe('revealing');
    expect(frozen.veil.dataset.e2eFreeze).toBe('revealing');
    window.archvizTransitionSeam!.unfreeze();
    await vi.advanceTimersByTimeAsync(REVEAL_MS + 100);
    await frozenRun;
    expect(frozen.state).toBe('revealed');
  });

  it('restarts the handshake when geometry changes land on the commit frame', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    expect(queue.resolvers).toHaveLength(1);
    vi.stubGlobal('innerWidth', window.innerWidth + 40);
    await completeOneFrame(queue);
    await driveUntil(run, queue, () => seam.parked);
    expect(seam.parked).toBe(true);
    // One stale commit frame, then a fresh committed-black frame and two stable frames.
    expect(queue.requestCount()).toBe(4);
    expect(seam.stableFrameSamples.at(-2)).toEqual({ generation: 1, stableFrames: 1 });
    expect(seam.stableFrameSamples.at(-1)).toEqual({ generation: 1, stableFrames: 2 });
    coordinator.dispose();
  });

  it('restarts the handshake when the tab is hidden on the commit frame', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    expect(queue.resolvers).toHaveLength(1);
    setHidden(true);
    await completeOneFrame(queue);
    await driveUntil(run, queue, () => seam.parked, () => {
      setHidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(seam.parked).toBe(true);
    expect(queue.requestCount()).toBe(4);
    expect(seam.generation).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it('restarts the handshake when a viewport disruption lands on the commit frame', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    expect(queue.resolvers).toHaveLength(1);
    window.dispatchEvent(new Event('resize'));
    await completeOneFrame(queue);
    await driveUntil(run, queue, () => seam.parked);
    expect(seam.parked).toBe(true);
    expect(queue.requestCount()).toBe(4);
    expect(seam.generation).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it('restarts with fresh samples when a disruption lands between samples', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    expect(queue.resolvers).toHaveLength(1);
    window.dispatchEvent(new Event('resize'));
    await completeOneFrame(queue);
    await driveUntil(run, queue, () => seam.parked);
    expect(seam.parked).toBe(true);
    // One sample before the disruption, then only fresh samples in the new generation.
    expect(seam.stableFrameSamples).toHaveLength(3);
    assertFreshStableFrames(seam.stableFrameSamples, seam.disruptions[0]!.generation);
    coordinator.dispose();
  });

  it('counts no stable frame after a silent geometry change between samples', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    expect(queue.resolvers).toHaveLength(1);
    vi.stubGlobal('innerWidth', window.innerWidth + 40);
    await completeOneFrame(queue);
    await driveUntil(run, queue, () => seam.parked);
    expect(seam.parked).toBe(true);
    expect(seam.stableFrameSamples).toHaveLength(3);
    expect(seam.stableFrameSamples.at(-1)!.generation).toBe(seam.generation);
    coordinator.dispose();
  });

  it('counts no stable frame after a hidden episode between samples', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    expect(queue.resolvers).toHaveLength(1);
    setHidden(true);
    await completeOneFrame(queue);
    await driveUntil(run, queue, () => seam.parked, () => {
      setHidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(seam.parked).toBe(true);
    expect(seam.stableFrameSamples).toHaveLength(3);
    expect(seam.generation).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it('demands one fresh handshake when a disruption lands during the hold wait', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event('resize'));
    await driveUntil(run, queue, () => seam.parked);
    expect(seam.parked).toBe(true);
    // Two samples before the disruption, two fresh ones from the restarted handshake.
    expect(seam.stableFrameSamples).toHaveLength(4);
    seam.unfreeze();
    await driveUntil(run, queue, () => false);
    await run;
    expect(coordinator.state).toBe('revealed');
  });

  it('demands one fresh handshake when geometry changes during the hold wait', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(100);
    vi.stubGlobal('innerWidth', window.innerWidth + 40);
    await driveUntil(run, queue, () => seam.parked);
    expect(seam.parked).toBe(true);
    seam.unfreeze();
    await driveUntil(run, queue, () => false);
    await run;
    expect(coordinator.state).toBe('revealed');
  });

  it('restarts before revealing when geometry changes during the black-hold park', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS);
    expect(seam.parked).toBe(true);
    const sampleBaseline = seam.stableFrameSamples.length;
    vi.stubGlobal('innerWidth', window.innerWidth + 40);
    seam.unfreeze();
    await driveUntil(run, queue, () => false);
    await run;
    expect(coordinator.state).toBe('revealed');
    expect(seam.generation).toBeGreaterThan(0);
    expect(seam.stableFrameSamples.slice(sampleBaseline)).toHaveLength(2);
    // The stale reveal never started: exactly one fade began, after the restart.
    expect(lobby.setRevealing).toHaveBeenCalledTimes(1);
  });

  it('restarts before revealing when the tab is hidden during the black-hold park', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=black-hold`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS);
    expect(seam.parked).toBe(true);
    setHidden(true);
    seam.unfreeze();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.state).toBe('black-hold');
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await driveUntil(run, queue, () => false);
    await run;
    expect(coordinator.state).toBe('revealed');
  });

  it('justifies the reveal with post-disruption frames when the fade is disrupted', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=revealing`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + 1);
    expect(coordinator.state).toBe('revealing');
    seam.unfreeze();
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new Event('resize'));
    await driveUntil(run, queue, () => false);
    await run;
    expect(coordinator.state).toBe('revealed');
    expect(seam.generation).toBeGreaterThan(0);
    expect(seam.stableFrameSamples.at(-1)!.generation).toBeGreaterThan(0);
  });

  it('justifies the reveal with post-disruption frames when geometry changes during the fade', async () => {
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=revealing`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam!;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + 1);
    expect(coordinator.state).toBe('revealing');
    seam.unfreeze();
    await vi.advanceTimersByTimeAsync(100);
    vi.stubGlobal('innerWidth', window.innerWidth + 40);
    await driveUntil(run, queue, () => false);
    await run;
    expect(coordinator.state).toBe('revealed');
    expect(seam.generation).toBeGreaterThan(0);
    expect(seam.stableFrameSamples.at(-1)!.generation).toBeGreaterThan(0);
  });

  it('restarts under black when the tab is hidden during the paused fade', async () => {
    window.matchMedia = reducedMotionMedia();
    const queue = manualFrames();
    const coordinator = new SceneRevealCoordinator({
      canvas, search: `${E2E_GATE}&freeze=revealing`, lobby, predicates: createPredicates(),
      wakeRenderer: vi.fn(), onFrameRequest: queue.onFrameRequest,
    });
    const seam = window.archvizTransitionSeam as TransitionSeam;
    const run = coordinator.execute();
    await vi.advanceTimersByTimeAsync(0);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await completeOneFrame(queue);
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.state).toBe('revealing');
    setHidden(true);
    seam.unfreeze();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.state).toBe('black-hold');
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await driveUntil(run, queue, () => false);
    await run;
    expect(coordinator.state).toBe('revealed');
  });
});
