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
import { STARTUP_FAILURE_MESSAGE } from '../../src/ui/startup-failure';
import { DEVICE_LOST_MESSAGE } from '../../src/renderer/notices';
import { assertDisruptionReset, assertFreshStableFrames } from '../e2e/support/reveal-disruption';

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

  it.each(['pending', 'failed', 'completed'] as const)(
    'releases its seam and veil at disposal after a %s transition', async (phase) => {
      const onRevealed = vi.fn(() => {
        expect(window.archvizTransitionSeam?.state).toBe('revealed');
        expect(coordinator.veil.isConnected).toBe(true);
      });
      const coordinator = new SceneRevealCoordinator({
        canvas, search: '?e2e=1&gate=on', lobby: mockLobby,
        predicates: createAllPassingPredicates(), wakeRenderer: vi.fn(),
        onFrameRequest: vi.fn().mockResolvedValue(undefined), onRevealed,
      });
      const seam = window.archvizTransitionSeam!;
      expect(seam).toBeDefined();
      expect(coordinator.veil.isConnected).toBe(true);
      if (phase === 'failed') {
        coordinator.fail('failed before reveal');
        expect(window.archvizTransitionSeam).toBe(seam);
        expect(seam.state).toBe('error');
      } else if (phase === 'completed') {
        const run = coordinator.execute();
        await vi.runAllTimersAsync();
        await run;
        expect(onRevealed).toHaveBeenCalledOnce();
        expect(window.archvizTransitionSeam).toBeUndefined();
        expect(coordinator.veil.isConnected).toBe(false);
      }
      coordinator.dispose();
      coordinator.dispose();
      expect(window.archvizTransitionSeam).toBeUndefined();
      expect(coordinator.veil.isConnected).toBe(false);
      expect(document.querySelector('#scene-veil')).toBeNull();
    },
  );

  it('preserves a later seam and veil when an earlier owner is disposed', () => {
    const create = (search: string): SceneRevealCoordinator => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      return new SceneRevealCoordinator({
        root, canvas, search, lobby: mockLobby, predicates: createAllPassingPredicates(),
        wakeRenderer: vi.fn(), onFrameRequest: vi.fn().mockResolvedValue(undefined),
      });
    };
    const earlier = create('?e2e=1&gate=on');
    const later = create('?e2e=1&gate=on');
    const production = create('');
    const seam = window.archvizTransitionSeam;
    earlier.dispose();
    production.dispose();
    expect(window.archvizTransitionSeam).toBe(seam);
    expect(later.veil.isConnected).toBe(true);
    expect(earlier.veil.isConnected).toBe(false);
    expect(production.veil.isConnected).toBe(false);
    later.dispose();
    expect(window.archvizTransitionSeam).toBeUndefined();
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
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(onError).toHaveBeenCalledWith(STARTUP_FAILURE_MESSAGE);
    expect(mockLobby.setError).toHaveBeenCalledWith(STARTUP_FAILURE_MESSAGE, undefined);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[archviz] scene reveal failed',
      'Initial readiness predicates not fulfilled: lookAndVariantMounted',
      expect.any(Error),
    );
    expect(mockLobby.setRevealing).not.toHaveBeenCalled();
    expect(mockLobby.setRevealed).not.toHaveBeenCalled();
  });

  it.each(['readiness lost', 'frame error', 'thrown string'])(
    'keeps %s diagnostics in the console and shows startup recovery copy', async (failure) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const predicates = createAllPassingPredicates();
      const error = failure === 'thrown string' ? 'internal frame rejection' : new Error('internal frame failure');
      const onFrameRequest = vi.fn(async () => {
        if (failure === 'readiness lost') {
          predicates.postChainAssembled = () => false;
        } else {
          throw error;
        }
      });
      const coordinator = new SceneRevealCoordinator({
        canvas, search: '', lobby: mockLobby, predicates, wakeRenderer: vi.fn(), onFrameRequest,
      });
      const run = coordinator.execute();
      await vi.runAllTimersAsync();
      await run;
      expect(coordinator.state).toBe('error');
      expect(mockLobby.setError).toHaveBeenCalledWith(STARTUP_FAILURE_MESSAGE, undefined);
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        '[archviz] scene reveal failed',
        failure === 'readiness lost'
          ? 'Readiness lost during black-hold handshake: postChainAssembled'
          : error instanceof Error ? error.message : error,
        failure === 'readiness lost' ? expect.any(Error) : error,
      );
      expect(mockLobby.setRevealed).not.toHaveBeenCalled();
      coordinator.dispose();
    },
  );

  it.each(['failed', 'disposed', 'revealed'] as const)(
    'ignores follow-on exceptions after the transition is %s', async (outcome) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onError = vi.fn();
      const error = new Error('late frame failure');
      const options = { announce: false };
      const coordinator = new SceneRevealCoordinator({
        canvas, search: '', lobby: mockLobby, predicates: createAllPassingPredicates(),
        wakeRenderer: vi.fn(), onError,
        onFrameRequest: async () => {
          if (outcome === 'failed') {
            coordinator.fail(DEVICE_LOST_MESSAGE, options);
          } else if (outcome === 'disposed') {
            coordinator.dispose();
          } else {
            return;
          }
          throw error;
        },
        onRevealed: () => { throw error; },
      });
      const run = coordinator.execute();
      await vi.runAllTimersAsync();
      await run;
      expect(log).not.toHaveBeenCalled();
      if (outcome === 'failed') {
        expect(mockLobby.setError).toHaveBeenCalledExactlyOnceWith(DEVICE_LOST_MESSAGE, options);
        expect(onError).toHaveBeenCalledExactlyOnceWith(DEVICE_LOST_MESSAGE);
        expect(coordinator.state).toBe('error');
      } else {
        expect(mockLobby.setError).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        if (outcome === 'revealed') {
          expect(coordinator.state).toBe('revealed');
        } else {
          expect(coordinator.veil.isConnected).toBe(false);
        }
      }
      coordinator.dispose();
    },
  );

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
    expect(mockLobby.setError).toHaveBeenCalledWith('renderer lost during reveal', undefined);
    expect(onError).toHaveBeenCalledWith('renderer lost during reveal');
  });

  it.each([
    { message: DEVICE_LOST_MESSAGE, options: { announce: false } },
    { message: 'Renderer initialization failed. Please retry.', options: { announce: true } },
  ])('preserves caller copy and announcement choice for $message', ({ message, options }) => {
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

    coordinator.fail(message, options);

    expect(mockLobby.setError).toHaveBeenCalledWith(message, options);
    expect(onError).toHaveBeenCalledWith(message);
    coordinator.dispose();
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

  it('retains the real resize reset through a fresh, scheduled three-frame handshake', async () => {
    const frameResolvers: (() => void)[] = [];
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '?e2e=1&gate=on&freeze=black-hold',
      lobby: mockLobby,
      predicates: createAllPassingPredicates(),
      wakeRenderer: vi.fn(),
      onFrameRequest: () => new Promise<void>((resolve) => frameResolvers.push(resolve)),
    });
    const completeFrame = async (): Promise<void> => {
      expect(frameResolvers.length, 'one scheduled render must be pending').toBe(1);
      frameResolvers.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    };
    const seam = window.archvizTransitionSeam!;
    const runPromise = coordinator.execute();
    expect(seam.parked).toBe(false);
    await vi.advanceTimersByTimeAsync(READY_HIDDEN_HOLD_MS + COVER_TO_BLACK_MS);
    await completeFrame();
    await completeFrame();
    await completeFrame();
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS);
    expect(seam.parked).toBe(true);
    expect(seam.stableFrameSamples).toEqual([
      { generation: 0, stableFrames: 1 }, { generation: 0, stableFrames: 2 },
    ]);
    const previousGeneration = seam.generation;
    const oldSnapshot = seam.disruptions;

    window.dispatchEvent(new Event('resize'));
    const reset = seam.disruptions[0];
    expect(reset, 'the actual window listener must retain its reset').toBeDefined();
    assertDisruptionReset(reset, previousGeneration);
    expect(reset).toEqual({
      type: 'resize', source: 'window', generation: previousGeneration + 1, stableFrames: 0,
      width: window.innerWidth, height: window.innerHeight,
    });
    expect(oldSnapshot).toEqual([]);
    expect(seam.parked).toBe(true);
    expect(coordinator.veil.dataset.state).toBe('black-hold');
    expect(coordinator.veil.hidden).toBe(false);
    expect(frameResolvers).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS);
    expect(seam.stableFrames).toBe(0);

    const sampleBaseline = seam.stableFrameSamples.length;
    seam.unfreeze();
    expect(seam.parked).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    await completeFrame();
    expect(seam.stableFrameSamples.slice(sampleBaseline)).toEqual([]);
    expect(coordinator.state).toBe('black-hold');
    await completeFrame();
    expect(seam.stableFrameSamples.slice(sampleBaseline)).toEqual([
      { generation: seam.generation, stableFrames: 1 },
    ]);
    expect(coordinator.state).toBe('black-hold');
    await completeFrame();
    assertFreshStableFrames(seam.stableFrameSamples.slice(sampleBaseline), reset.generation);
    await vi.advanceTimersByTimeAsync(BLACK_HOLD_MIN_MS + REVEAL_MS);
    await runPromise;
    expect(coordinator.state).toBe('revealed');
    expect(seam.stableFrames).toBe(2);
    expect(seam.disruptions[0]).toEqual(reset);
    expect(seam.disruptions[0].stableFrames).toBe(0);
    expect(Object.isFrozen(seam.disruptions)).toBe(true);
    expect(Object.isFrozen(reset)).toBe(true);
    expect(Object.isFrozen(seam.stableFrameSamples)).toBe(true);
    expect(Object.isFrozen(seam.stableFrameSamples[0])).toBe(true);
    expect(Object.getOwnPropertyDescriptor(seam, 'parked')?.set).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(seam, 'generation')?.set).toBeUndefined();
  });

  it('records ordered window and visual-viewport lifecycle deliveries without conflating their sources', () => {
    const visualViewport = new EventTarget();
    const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    const coordinator = new SceneRevealCoordinator({
      canvas,
      search: '?e2e=1&gate=on',
      lobby: mockLobby,
      predicates: createAllPassingPredicates(),
      wakeRenderer: vi.fn(),
      onFrameRequest: vi.fn().mockResolvedValue(undefined),
    });
    try {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));
      visualViewport.dispatchEvent(new Event('resize'));
      expect(window.archvizTransitionSeam?.disruptions).toEqual([
        expect.objectContaining({ type: 'resize', source: 'window', generation: 1, stableFrames: 0 }),
        expect.objectContaining({ type: 'orientationchange', source: 'window', generation: 2, stableFrames: 0 }),
        expect.objectContaining({ type: 'resize', source: 'visual-viewport', generation: 3, stableFrames: 0 }),
      ]);
      const seam = window.archvizTransitionSeam!;
      coordinator.dispose();
      window.dispatchEvent(new Event('resize'));
      expect(seam.disruptions).toHaveLength(3);
    } finally {
      coordinator.dispose();
      if (originalViewport === undefined) Reflect.deleteProperty(window, 'visualViewport');
      else Object.defineProperty(window, 'visualViewport', originalViewport);
    }
  });

  it.each(['', '?e2e=1', '?gate=on', '?e2e=0&gate=on'])(
    'keeps diagnostics unavailable outside the exact E2E gate guard: %s', (search) => {
      const coordinator = new SceneRevealCoordinator({
        canvas, search, lobby: mockLobby, predicates: createAllPassingPredicates(),
        wakeRenderer: vi.fn(), onFrameRequest: vi.fn().mockResolvedValue(undefined),
      });
      window.dispatchEvent(new Event('resize'));
      expect(window.archvizTransitionSeam).toBeUndefined();
      coordinator.dispose();
    },
  );

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
