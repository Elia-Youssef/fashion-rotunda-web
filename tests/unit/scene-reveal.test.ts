// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryLobby, LobbyState } from '../../src/ui/entry-lobby';
import {
  SceneRevealCoordinator,
  READY_HIDDEN_HOLD_MS,
  COVER_TO_BLACK_MS,
  BLACK_HOLD_MIN_MS,
  REVEAL_MS,
} from '../../src/ui/scene-reveal';
import type { ReadinessPredicates } from '../../src/ui/scene-reveal';


function createMockLobby(): EntryLobby {
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

function createAllPassingPredicates(): ReadinessPredicates {
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

describe('SceneRevealCoordinator', () => {
  let canvas: HTMLCanvasElement;
  let mockLobby: EntryLobby;

  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.id = 'scene';
    canvas.width = 1440;
    canvas.height = 900;
    document.body.appendChild(canvas);
    mockLobby = createMockLobby();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    delete window.archvizTransitionSeam;
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('progresses through the exact state lifecycle in order', async () => {
    const predicates = createAllPassingPredicates();
    let frameResolver: (() => void) | null = null;

    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '',
      lobby: mockLobby,
      predicates,
      wakeRenderer: vi.fn(),
      onFrameRequest: () =>
        new Promise<void>((resolve) => {
          frameResolver = resolve;
        }),
    });

    const runPromise = coordinator.execute();

    // 1. Initial state is ready-hidden
    expect(coordinator.state).toBe('ready-hidden');
    expect(coordinator.veil.dataset.state).toBe('ready-hidden');

    // 2. Cover to black phase
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS);
    expect(coordinator.state).toBe('cover-to-black');
    expect(coordinator.veil.dataset.state).toBe('cover-to-black');
    expect(mockLobby.setCoverToBlack).toHaveBeenCalled();

    // Finish cover duration
    await vi.advanceTimersByTimeAsync(COVER_TO_BLACK_MS);

    // 3. Black hold phase
    expect(coordinator.state).toBe('black-hold');
    expect(coordinator.veil.dataset.state).toBe('black-hold');
    expect(mockLobby.setBlackHold).toHaveBeenCalled();

    // The first scheduled frame commits black; it is deliberately not counted as stable yet.
    const blackCommit = frameResolver as (() => void) | null;
    blackCommit?.();
    await vi.advanceTimersByTimeAsync(16);
    expect(coordinator.frameCountBehindBlack).toBe(0);

    // Deliver stable Frame 1
    const res1 = frameResolver as (() => void) | null;
    frameResolver = null;
    res1?.();
    await vi.advanceTimersByTimeAsync(16);
    expect(coordinator.frameCountBehindBlack).toBe(1);

    // Deliver stable Frame 2
    const res2 = frameResolver as (() => void) | null;
    res2?.();
    await vi.advanceTimersByTimeAsync(16);
    expect(coordinator.frameCountBehindBlack).toBe(2);

    // Complete black hold minimum duration (200ms)
    await vi.advanceTimersByTimeAsync(200);

    // 4. Revealing phase
    expect(coordinator.state).toBe('revealing');
    expect(coordinator.veil.dataset.state).toBe('revealing');
    expect(mockLobby.setRevealing).toHaveBeenCalled();

    // Complete reveal duration (600ms)
    await vi.advanceTimersByTimeAsync(600);

    // 5. Revealed phase
    await runPromise;
    expect(coordinator.state).toBe('revealed');
    expect(coordinator.veil.dataset.state).toBe('revealed');
    expect(coordinator.veil.hidden).toBe(true);
    expect(mockLobby.setRevealed).toHaveBeenCalled();
  });

  it('fails closed and stops reveal if any readiness predicate is false at start', async () => {
    const failingPredicates = createAllPassingPredicates();
    failingPredicates.lookAndVariantMounted = () => false;

    const onError = vi.fn();
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '',
      lobby: mockLobby,
      predicates: failingPredicates,
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
      onError,
    });

    await coordinator.execute();

    expect(coordinator.state).toBe('error');
    expect(coordinator.veil.dataset.state).toBe('error');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('readiness predicates'));
    expect(mockLobby.setError).toHaveBeenCalled();
    expect(mockLobby.setRevealing).not.toHaveBeenCalled();
    expect(mockLobby.setRevealed).not.toHaveBeenCalled();
  });

  it('halts reveal and transitions to error if shaders are not compiled', async () => {
    const predicates = createAllPassingPredicates();
    predicates.shadersCompiled = () => false;

    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '',
      lobby: mockLobby,
      predicates,
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
    });

    await coordinator.execute();

    expect(coordinator.state).toBe('error');
    expect(mockLobby.setError).toHaveBeenCalled();
    expect(coordinator.veil.dataset.state).toBe('error');
  });

  it('fails closed by hiding the veil and exposing the lobby retry surface', () => {
    const onError = vi.fn();
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '',
      lobby: mockLobby,
      predicates: createAllPassingPredicates(),
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
      onError,
    });

    coordinator.fail('renderer lost during reveal');

    expect(coordinator.state).toBe('error');
    expect(coordinator.veil.dataset.state).toBe('error');
    expect(coordinator.veil.hidden).toBe(true);
    expect(mockLobby.setError).toHaveBeenCalledWith('renderer lost during reveal');
    expect(onError).toHaveBeenCalledWith('renderer lost during reveal');
  });

  it('reduced motion takes the instant path without decorative delays', async () => {
    // Mock prefers-reduced-motion: reduce
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const predicates = createAllPassingPredicates();
    let frameCount = 0;
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '',
      lobby: mockLobby,
      predicates,
      wakeRenderer: vi.fn(),
      onFrameRequest: () => {
        frameCount += 1;
        return Promise.resolve();
      },
    });

    const runPromise = coordinator.execute();
    await vi.advanceTimersByTimeAsync(50);
    await runPromise;

    expect(coordinator.state).toBe('revealed');
    expect(coordinator.frameCountBehindBlack).toBeGreaterThanOrEqual(2);
    expect(frameCount).toBeGreaterThanOrEqual(2);
    expect(mockLobby.setRevealed).toHaveBeenCalled();
  });

  it('pauses transition progression when document becomes hidden', async () => {
    const predicates = createAllPassingPredicates();
    let frameCount = 0;
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '',
      lobby: mockLobby,
      predicates,
      wakeRenderer: vi.fn(),
      onFrameRequest: () => {
        frameCount += 1;
        return Promise.resolve();
      },
    });

    const runPromise = coordinator.execute();
    // Advance past ready-hidden (250) and cover-to-black (250) into black-hold (10)
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + 10);
    expect(coordinator.state).toBe('black-hold');

    // Simulate tab hidden
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // Try to advance timers while tab is hidden
    await vi.advanceTimersByTimeAsync(1000);
    expect(coordinator.state).not.toBe('revealed');
    expect(coordinator.veil.dataset.state).toBe('black-hold');

    // Simulate tab restored
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // Complete the rest of the transition: black-hold + reveal
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS + 200);
    await runPromise;

    expect(coordinator.state).toBe('revealed');
    expect(frameCount).toBeGreaterThanOrEqual(2);
  });

  it('supports deterministic test seam freezing and unfreezing', async () => {
    const predicates = createAllPassingPredicates();
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '?webgl=1&e2e=1&gate=on&freeze=black-hold',
      lobby: mockLobby,
      predicates,
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
    });

    const runPromise = coordinator.execute();

    // Advance past ready-hidden (250) + cover-to-black (250) + into black-hold (50)
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + 50);

    // Must be frozen in black-hold
    expect(coordinator.state).toBe('black-hold');
    await vi.advanceTimersByTimeAsync(2000);
    expect(coordinator.state).toBe('black-hold');

    // Unfreeze through seam
    window.archvizTransitionSeam?.unfreeze();

    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS + 200);
    await runPromise;

    expect(coordinator.state).toBe('revealed');
  });

  it('freezes revealing before its timed fade and starts the fade only after release', async () => {
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '?webgl=1&e2e=1&gate=on&freeze=revealing',
      lobby: mockLobby,
      predicates: createAllPassingPredicates(),
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
    });

    const runPromise = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + 100);
    expect(coordinator.state).toBe('revealing');
    expect(coordinator.transitionTimestamps.revealEnd).toBeNull();

    await vi.advanceTimersByTimeAsync(REVEAL_MS * 2);
    expect(coordinator.state).toBe('revealing');
    expect(coordinator.transitionTimestamps.revealEnd).toBeNull();

    window.archvizTransitionSeam?.unfreeze();
    await vi.advanceTimersByTimeAsync(REVEAL_MS + 100);
    await runPromise;
    expect(coordinator.state).toBe('revealed');
  });

  it('restarts the committed-black and stable-frame handshake after a resize', async () => {
    const requestFrame = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '?e2e=1&gate=on&freeze=black-hold',
      lobby: mockLobby,
      predicates: createAllPassingPredicates(),
      wakeRenderer: vi.fn(),
      onFrameRequest: requestFrame,
    });

    const runPromise = coordinator.execute();
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + 100);
    expect(coordinator.state).toBe('black-hold');
    expect(coordinator.frameCountBehindBlack).toBe(2);
    const firstHandshakeRequests = requestFrame.mock.calls.length;
    expect(firstHandshakeRequests).toBeGreaterThanOrEqual(3);

    window.dispatchEvent(new Event('resize'));
    expect(coordinator.state).toBe('black-hold');
    expect(coordinator.frameCountBehindBlack).toBe(0);

    window.archvizTransitionSeam?.unfreeze();
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS + 300);
    await runPromise;

    expect(coordinator.state).toBe('revealed');
    expect(coordinator.frameCountBehindBlack).toBe(2);
    expect(requestFrame.mock.calls.length).toBeGreaterThanOrEqual(firstHandshakeRequests + 3);
  });

  it('exposes the deterministic seam only for the guarded E2E gate and supports ready-hidden', async () => {
    const productionCoordinator = new SceneRevealCoordinator({
      canvas,
      search: '?gate=on',
      lobby: mockLobby,
      predicates: createAllPassingPredicates(),
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
    });
    expect(window.archvizTransitionSeam).toBeUndefined();
    productionCoordinator.dispose();

    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '?e2e=1&gate=on&freeze=ready-hidden',
      lobby: mockLobby,
      predicates: createAllPassingPredicates(),
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
    });
    const runPromise = coordinator.execute();
    await vi.advanceTimersByTimeAsync(10);
    expect(coordinator.state).toBe('ready-hidden');
    expect(window.archvizTransitionSeam?.state).toBe('ready-hidden');

    window.archvizTransitionSeam?.unfreeze();
    await vi.advanceTimersByTimeAsync(
      READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS + BLACK_HOLD_MIN_MS + REVEAL_MS + 300,
    );
    await runPromise;
    expect(coordinator.state).toBe('revealed');
  });

  it('disposing cancels all timers and aborts gracefully', async () => {
    const predicates = createAllPassingPredicates();
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '',
      lobby: mockLobby,
      predicates,
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
    });

    const runPromise = coordinator.execute();
    coordinator.dispose();

    await vi.advanceTimersByTimeAsync(5000);
    await runPromise;

    // Disposed state did not proceed to revealed
    expect(coordinator.state).not.toBe('revealed');
  });
});
