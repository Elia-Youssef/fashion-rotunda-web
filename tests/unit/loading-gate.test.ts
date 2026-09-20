// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gateWanted, mountLoadingGate } from '../../src/ui/loading-gate';
import type { LoadingGate } from '../../src/ui/loading-gate';

// The manifest and the catalogue the fetch stub serves, in the shapes public/content writes them.
const manifestJson = {
  sets: {
    full: {
      files: {
        'env/school-field-cloudy-1k.hdr': { bytes: 200_000 },
        'rotunda.glb': { bytes: 700_000 },
        'plinth.glb': { bytes: 300_000 },
        'looks/first.glb': { bytes: 500_000 },
      },
    },
  },
};

const catalogJson = {
  version: 1,
  environment: { file: 'env/school-field-cloudy-1k.hdr' },
  rotunda: { file: 'rotunda.glb' },
  plinth: { file: 'plinth.glb' },
  looks: [
    {
      id: 'first',
      name: 'First Look',
      description: 'The look the plinth opens on.',
      thumbnail: null,
      file: 'looks/first.glb',
      audio: null,
      variants: ['base'],
      defaultVariant: 'base',
      mannequinNode: 'mannequin',
    },
  ],
  views: { proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 } },
};

/** A Resource Timing reading the spy can return. transferSize and responseEnd are the extras. */
type FakeResource = PerformanceEntry & { transferSize: number; responseEnd: number };

function resourceEntry(name: string, transferSize: number, responseEnd: number): FakeResource {
  const base: PerformanceEntry = {
    name,
    entryType: 'resource',
    startTime: responseEnd - 10,
    duration: 10,
    toJSON: (): Record<string, unknown> => ({}),
  };
  return { ...base, transferSize, responseEnd };
}

/** A User Timing mark the getEntriesByName spy can return, shaped like the real entry. */
function markEntry(name: string, startTime: number): PerformanceEntry {
  return { name, entryType: 'mark', startTime, duration: 0, toJSON: () => ({}) };
}

/** The one console line the gate prints when the button unlocks. */
function gateLine(info: { mock: { calls: unknown[][] } }): string | undefined {
  return info.mock.calls
    .map((call) => String(call[0]))
    .find((text) => text.startsWith('[archviz] gate:'));
}

let root: HTMLElement;
let canvas: HTMLCanvasElement;
const onEnter = vi.fn();

/**
 * Every gate mounted by a test, disposed in afterEach: the Tab containment listens on the
 * document, which outlives a test's root element, so a gate left mounted would hold Tab for the
 * tests that follow it. The page mounts one gate per load and never this situation.
 */
const mounted: LoadingGate[] = [];

function mountGate(entries: PerformanceEntry[] = []): LoadingGate {
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries);
  const gate = mountLoadingGate({ root, canvas, contentBase: '/content', onEnter });
  mounted.push(gate);
  return gate;
}

function gateElement(): HTMLElement {
  const found = root.querySelector<HTMLElement>('.loading-gate');
  if (found === null) {
    throw new Error('the gate is not mounted');
  }
  return found;
}

/** Lets the stubbed fetch resolve and the 250 ms ticker run once. */
async function flush(ms = 300): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
  canvas = document.createElement('canvas');
  onEnter.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
      const url = String(input);
      if (url.endsWith('manifest.json')) {
        return { ok: true, json: async () => manifestJson };
      }
      if (url.endsWith('catalog.json')) {
        return { ok: true, json: async () => catalogJson };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  mounted.splice(0).forEach((gate) => {
    gate.dispose();
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  root.remove();
});

describe('gateWanted', () => {
  it('wants the gate for a plain visit and for url parameters it does not know', () => {
    expect(gateWanted('')).toBe(true);
    expect(gateWanted('?webgl=1&look=first')).toBe(true);
  });

  it('does not want it for the browser tests or for an explicit off', () => {
    expect(gateWanted('?e2e=1')).toBe(false);
    expect(gateWanted('?gate=off')).toBe(false);
  });
});

describe('the dialog', () => {
  it('is a labelled modal dialog with the room name, a bar, a readout and a disabled button', () => {
    mountGate();
    const dialog = gateElement();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();
    expect(dialog.querySelector(`#${labelledBy}`)?.textContent).toBe('Fashion Rotunda');
    expect(dialog.dataset.gate).toBe('loading');
    const bar = dialog.querySelector<HTMLProgressElement>('progress');
    expect(bar?.max).toBe(1);
    expect(bar?.value).toBe(0);
    const button = dialog.querySelector<HTMLButtonElement>('button');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe('Enter');
    expect(dialog.querySelector('.loading-gate__status')?.textContent).toBe('Loading the room');
  });

  it('swallows the progress element into one focusable element only', () => {
    mountGate();
    const focusable = gateElement().querySelectorAll('button, a, input, select, textarea');
    expect(focusable).toHaveLength(1);
  });

  it('focuses itself on mount so the first Tab starts inside', () => {
    mountGate();
    expect(document.activeElement).toBe(gateElement());
    expect(gateElement().tabIndex).toBe(-1);
  });

  it('keeps Tab in even from outside the dialog, and lets every other key through', () => {
    mountGate();
    // From body, which is where focus sits before the dialog takes it and after a click on the
    // scrim: a listener on the dialog would never see this event, and the Tab would escape.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    document.body.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('stops holding Tab once it is gone', async () => {
    const gate = mountGate();
    await gate.ready(() => Promise.resolve());
    gateElement().querySelector<HTMLButtonElement>('button')?.click();
    await flush(250);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });
});

describe('the progress readout', () => {
  it('follows the received bytes against the manifest total, file by file', async () => {
    mountGate([
      resourceEntry('http://localhost:5173/content/manifest.json', 400, 20),
      resourceEntry('http://localhost:5173/content/rotunda.glb', 700_000, 400),
      resourceEntry('http://localhost:5173/content/plinth.glb', 300_000, 500),
    ]);
    await flush();
    const dialog = gateElement();
    const bar = dialog.querySelector<HTMLProgressElement>('progress');
    // The gate's own manifest fetch is under /content but is not one of the four first-frame
    // files, so its 400 bytes count for neither the bar nor the readout.
    expect(bar?.value).toBeCloseTo(1_000_000 / 1_700_000, 6);
    expect(dialog.querySelector('.loading-gate__readout')?.textContent).toBe('1.0 MB of 1.7 MB');
    expect(dialog.querySelector('.loading-gate__status')?.textContent).toBe(
      'Loading the room - 2 of 4 files',
    );
  });

  it('reads as loading from cache when the first arrival transferred zero bytes', async () => {
    mountGate([
      resourceEntry('http://localhost:5173/content/manifest.json', 0, 20),
      resourceEntry('http://localhost:5173/content/env/school-field-cloudy-1k.hdr', 0, 300),
      resourceEntry('http://localhost:5173/content/rotunda.glb', 0, 400),
      resourceEntry('http://localhost:5173/content/plinth.glb', 0, 500),
      resourceEntry('http://localhost:5173/content/looks/first.glb', 0, 600),
    ]);
    await flush();
    const dialog = gateElement();
    expect(dialog.querySelector('.loading-gate__status')?.textContent).toBe(
      'Loading from cache - 4 of 4 files',
    );
    expect(dialog.querySelector('.loading-gate__readout')?.textContent).toBe('0.0 MB of 1.7 MB');
  });

  it('finishes when compressed responses all arrived even if their wire bytes are smaller', async () => {
    mountGate([
      resourceEntry('http://localhost:5173/content/env/school-field-cloudy-1k.hdr', 150_000, 300),
      resourceEntry('http://localhost:5173/content/rotunda.glb', 680_000, 400),
      resourceEntry('http://localhost:5173/content/plinth.glb', 290_000, 500),
      resourceEntry('http://localhost:5173/content/looks/first.glb', 480_000, 600),
    ]);
    await flush();
    const dialog = gateElement();
    expect(dialog.querySelector<HTMLProgressElement>('progress')?.value).toBe(1);
    expect(dialog.querySelector('.loading-gate__readout')?.textContent).toBe('1.7 MB of 1.7 MB');
    expect(dialog.querySelector('.loading-gate__status')?.textContent).toBe(
      'Loading the room - 4 of 4 files',
    );
  });

  it('keeps the bar empty while it has no total', async () => {
    // progressRatio answers 1 for an expected of 0, which is right for the arithmetic and wrong
    // for the bar: a full bar for one tick before the manifest answered reads as a finished load.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no manifest here'))),
    );
    mountGate([resourceEntry('http://localhost:5173/content/rotunda.glb', 700_000, 400)]);
    await flush();
    expect(gateElement().querySelector<HTMLProgressElement>('progress')?.value).toBe(0);
    expect(gateElement().querySelector('.loading-gate__status')?.textContent).toBe(
      'Loading the room',
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores entries outside the base and files the first frame does not wait for', async () => {
    mountGate([
      resourceEntry('http://localhost:5173/src/main.ts', 2048, 10),
      // Under /content and real, none of them a first-frame file: the transcoder, a thumbnail,
      // a music loop and a look nobody asked for. Counting these filled the bar early.
      resourceEntry('http://localhost:5173/content/basis/basis_transcoder.wasm', 900_000, 40),
      resourceEntry('http://localhost:5173/content/thumbs/first.jpg', 40_000, 60),
      resourceEntry('http://localhost:5173/content/music/first.opus', 1_200_000, 80),
      resourceEntry('http://localhost:5173/content/looks/second.glb', 4_000_000, 200),
      resourceEntry('http://localhost:5173/content/looks/first.glb', 500_000, 300),
    ]);
    await flush();
    const dialog = gateElement();
    expect(dialog.querySelector<HTMLProgressElement>('progress')?.value).toBeCloseTo(500 / 1700, 6);
    expect(dialog.querySelector('.loading-gate__readout')?.textContent).toBe('0.5 MB of 1.7 MB');
    expect(dialog.querySelector('.loading-gate__status')?.textContent).toBe(
      'Loading the room - 1 of 4 files',
    );
  });
});

describe('ready', () => {
  it('keeps the button disabled while the compile runs and enables and focuses it after', async () => {
    const gate = mountGate();
    // The resolve is held on an object: a closure's assignment to a local let is invisible to
    // the flow analysis at the call site, which would read the local as never.
    const compile = { finish: (): void => {} };
    const readyPromise = gate.ready(
      () =>
        new Promise<void>((resolve) => {
          compile.finish = resolve;
        }),
    );
    await flush();
    const dialog = gateElement();
    expect(dialog.querySelector('.loading-gate__status')?.textContent).toBe(
      'Compiling the shaders',
    );
    expect(dialog.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    expect(dialog.dataset.gate).toBe('loading');

    canvas.dataset.scene = 'ready';
    compile.finish();
    await readyPromise;
    await flush();
    const button = gateElement().querySelector<HTMLButtonElement>('button');
    expect(button?.disabled).toBe(false);
    expect(gateElement().dataset.gate).toBe('ready');
    expect(gateElement().querySelector('.loading-gate__status')?.textContent).toBe('Ready');
    expect(document.activeElement).toBe(button);
    expect(gate.state).toBe('ready');
  });

  it('measures the gap from the scene attribute to the enabled button', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gate = mountGate();
    canvas.dataset.scene = 'ready';
    await gate.ready(() => Promise.resolve());
    const line = gateLine(info);
    expect(line).toMatch(/scene-ready=\d+(\.\d+)?ms/);
    expect(line).toMatch(/gap=\d+(\.\d+)?ms/);
  });

  it('prefers the first-frame mark over its own observer for the scene time', async () => {
    // The MutationObserver cannot run while a synchronous compile holds the thread, so its
    // timestamp lags the frame; src/proof/marks.ts records the mark inside the frame itself.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(performance, 'getEntriesByName').mockReturnValue([markEntry('first-frame', 1234)]);
    const gate = mountGate();
    canvas.dataset.scene = 'ready';
    await gate.ready(() => Promise.resolve());
    expect(gateLine(info)).toContain('scene-ready=1234ms');
  });

  it('enables the button anyway when the compile rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gate = mountGate();
    await gate.ready(() => Promise.reject(new Error('boom')));
    expect(gateElement().querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up on a compile that never ends after ten seconds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gate = mountGate();
    const readyPromise = gate.ready(() => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(10_000);
    await readyPromise;
    expect(gateElement().querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('did not finish');
  });
});

describe('the tap', () => {
  async function mountReady(): Promise<{ gate: LoadingGate; button: HTMLButtonElement }> {
    const gate = mountGate();
    await gate.ready(() => Promise.resolve());
    const button = gateElement().querySelector<HTMLButtonElement>('button');
    if (button === null) {
      throw new Error('no Enter button');
    }
    return { gate, button };
  }

  it('removes the gate after the fade and calls onEnter once', async () => {
    const { gate, button } = await mountReady();
    button.click();
    expect(gate.state).toBe('entered');
    await flush(250);
    expect(root.querySelector('.loading-gate')).toBeNull();
    expect(onEnter).toHaveBeenCalledTimes(1);
    button.click();
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('lets the tap reach a capture-phase listener on window', async () => {
    // What the music waits for: src/audio/mount.ts listens on window with capture: true, and the
    // gate must never stop the event that unlocks the AudioContext.
    const heard = vi.fn();
    window.addEventListener('click', heard, { capture: true });
    const { button } = await mountReady();
    button.click();
    expect(heard).toHaveBeenCalledTimes(1);
    await flush(250);
    expect(root.querySelector('.loading-gate')).toBeNull();
    expect(onEnter).toHaveBeenCalledTimes(1);
    window.removeEventListener('click', heard, { capture: true });
  });
});

describe('the failure route', () => {
  it('opens the gate with a way out when the showroom reports an error', async () => {
    const gate = mountGate();
    canvas.dataset.scene = 'error';
    await flush();
    const dialog = gateElement();
    expect(dialog.dataset.gate).toBe('ready');
    expect(dialog.querySelector('.loading-gate__status')?.textContent).toBe(
      'The room did not load. Close this to see the page.',
    );
    const button = dialog.querySelector<HTMLButtonElement>('button');
    expect(button?.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(gate.state).toBe('ready');

    button?.click();
    await flush(250);
    expect(root.querySelector('.loading-gate')).toBeNull();
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('stops the readout, so a failed load keeps no timer running', async () => {
    const clear = vi.spyOn(window, 'clearInterval');
    mountGate();
    canvas.dataset.scene = 'error';
    await flush();
    expect(clear).toHaveBeenCalled();
    const status = gateElement().querySelector('.loading-gate__status')?.textContent;
    await flush(1000);
    expect(gateElement().querySelector('.loading-gate__status')?.textContent).toBe(status);
  });
});

describe('dispose', () => {
  it('removes the gate, clears the ticker and reads as entered', async () => {
    const clear = vi.spyOn(window, 'clearInterval');
    const gate = mountGate();
    gate.dispose();
    expect(root.querySelector('.loading-gate')).toBeNull();
    expect(clear).toHaveBeenCalled();
    expect(gate.state).toBe('entered');
    await flush(1000);
    expect(onEnter).not.toHaveBeenCalled();
  });
});
