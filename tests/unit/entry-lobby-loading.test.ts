// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContentSet, chooseLook } from '../../src/catalog/bootstrap';
import { parseCatalog } from '../../src/catalog/catalog';
import { APPROVED_FACTS, LOBBY_READY_MESSAGE } from '../../src/ui/entry-lobby';
import type { ProgressReading } from '../../src/ui/entry-lobby';
import { trackFirstFrameProgress } from '../../src/ui/entry-lobby/progress';
import { installLobbyHarness, mountLobby } from '../support/entry-lobby';

// What the loading surface tells the visitor: the truthful progress readout, the one fact
// chosen for the visit, and the first-frame byte totals the tracker counts.

installLobbyHarness();

describe('loading state and truthful progress', () => {
  it('updates progress bar, byte readout, and status faithfully', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    expect(lobby.state).toBe('loading');

    const reading: ProgressReading = {
      received: 5_000_000,
      expected: 10_000_000,
      ended: 2,
      totalFiles: 4,
      fromCache: false,
    };
    lobby.setProgress(reading);

    const bar = element.querySelector<HTMLProgressElement>('.entry-lobby__progress-bar')!;
    expect(bar.value).toBe(0.5);
    expect(element.querySelector('.entry-lobby__progress-readout')?.textContent).toBe(
      '5.0 MB of 10.0 MB',
    );
    expect(element.querySelector('.entry-lobby__status')?.textContent).toBe('Dressing the mannequin');
  });

  it('steps the loading line once per arrived file and never ahead of the files', () => {
    const { lobby, element } = mountLobby();
    const status = element.querySelector('.entry-lobby__status')!;
    expect(status.textContent).toBe('Opening the rotunda');
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    const lines = [0, 1, 2, 3].map((ended) => {
      lobby.setProgress({ received: ended, expected: 3, ended, totalFiles: 3, fromCache: false });
      return status.textContent;
    });
    expect(lines).toEqual([
      'Opening the rotunda',
      'Polishing the marble',
      'Dressing the mannequin',
      'Setting the lights',
    ]);

    // A tracker with more files than steps holds the last arrival step until every file is in.
    lobby.setProgress({ received: 4, expected: 5, ended: 4, totalFiles: 5, fromCache: false });
    expect(status.textContent).toBe('Dressing the mannequin');
  });

  it('greets a repeat visit served from the cache, then says when the scene prepares', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    const status = element.querySelector('.entry-lobby__status')!;

    lobby.setProgress({ received: 0, expected: 10_000_000, ended: 1, totalFiles: 4, fromCache: true });
    expect(status.textContent).toBe('Welcome back');

    lobby.setProgress({ received: 0, expected: 10_000_000, ended: 4, totalFiles: 4, fromCache: true });
    expect(status.textContent).toBe('Setting the lights');
  });

  it('ends the loading line with the welcome when the scene is ready', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    lobby.setReady();
    expect(element.querySelector('.entry-lobby__status')?.textContent).toBe(LOBBY_READY_MESSAGE);
    expect(LOBBY_READY_MESSAGE).toBe('Welcome to the rotunda');
  });
});

describe.each([false, true])('one fact per visit (hydration=%s)', (withPreExistingDOM) => {
  it.each([
    {
      index: 0,
      heading: 'GRAPHICS',
      text: "Runs on WebGPU, the newest browser graphics standard, and switches to WebGL 2 where it isn't available.",
    },
    {
      index: 1,
      heading: 'THE ROTUNDA',
      text: 'The rotunda, its dome and every interior surface come from the original Unreal Engine scene.',
    },
    {
      index: 2,
      heading: 'FAST LOADING',
      text: 'Models and textures are compressed for the web, so the room loads quickly and stays sharp.',
    },
    {
      index: 3,
      heading: 'FITS YOUR DEVICE',
      text: 'The showroom checks your device and sets shadows, resolution and effects to keep it smooth.',
    },
    {
      index: 4,
      heading: 'KEYBOARD READY',
      text: 'Every control is a real page element, so the whole showroom works from the keyboard.',
    },
    {
      index: 5,
      heading: 'GALLERY LIGHTING',
      text: 'Three studio lights and the daylight dome light the looks, and you can adjust both.',
    },
  ])('renders the exact $heading fact', ({ index, heading, text }) => {
    const { element } = mountLobby({
      withPreExistingDOM,
      random: () => index / APPROVED_FACTS.length,
    });
    expect(element.querySelector('.entry-lobby__fact-heading')?.textContent).toBe(heading);
    expect(element.querySelector('.entry-lobby__fact-text')?.textContent).toBe(`"${text}"`);
  });

  function expectFact(element: HTMLElement, index: number): void {
    expect(element.querySelector('.entry-lobby__fact-heading')?.textContent)
      .toBe(APPROVED_FACTS[index].heading);
    expect(element.querySelector('.entry-lobby__fact-text')?.textContent)
      .toBe(`"${APPROVED_FACTS[index].text}"`);
  }

  it.each([
    { value: 0, index: 0 },
    { value: 0.1, index: 0 },
    { value: 0.5, index: 3 },
    { value: 1 - Number.EPSILON, index: 5 },
  ])('selects fact $index at mount from random value $value', ({ value, index }) => {
    const random = vi.fn(() => value);
    const { element } = mountLobby({ withPreExistingDOM, random });
    expectFact(element, index);
    expect(random).toHaveBeenCalledOnce();
  });

  it('defaults to Math.random when no source is injected', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { element } = mountLobby({ withPreExistingDOM });
    expectFact(element, 3);
    expect(random).toHaveBeenCalledOnce();
  });

  // Five former rotation periods exercise long idle, loading and error waits.
  const longWaitMs = 30_000;

  it.each([false, true])('keeps the mounted fact through loading and error (reduced motion=%s)',
    async (reducedMotion) => {
      vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion })));
      try {
        const random = vi.fn(() => 0.5);
        const { lobby, element } = mountLobby({ withPreExistingDOM, random });
        expectFact(element, 3);
        await vi.advanceTimersByTimeAsync(longWaitMs);
        expectFact(element, 3);

        element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
        expectFact(element, 3);
        await vi.advanceTimersByTimeAsync(longWaitMs);
        expectFact(element, 3);

        for (const fromCache of [false, true]) {
          lobby.setProgress({ received: 5, expected: 10, ended: 1, totalFiles: 2, fromCache });
          expectFact(element, 3);
          await vi.advanceTimersByTimeAsync(longWaitMs);
          expectFact(element, 3);
        }

        lobby.setError('Connection lost');
        expectFact(element, 3);
        await vi.advanceTimersByTimeAsync(longWaitMs);
        expectFact(element, 3);
        expect(random).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    });

  it.each([false, true])('leaves no fact timer pending (reduced motion=%s)', async (reducedMotion) => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion })));
    try {
      const { lobby, element } = mountLobby({ withPreExistingDOM, random: () => 0 });
      // Drain jsdom's deferred document work before inspecting pending display timers.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
      expect(vi.getTimerCount()).toBe(0);
      lobby.setError('Connection lost');
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      lobby.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('first-frame byte total and the sky source', () => {
  // The shipped catalog and manifest, served through a stubbed fetch, so the totals below are the
  // real first-frame files of the full set. jsdom's URL is not the one node:fs accepts, hence paths.
  const contentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/content');
  const catalogText = readFileSync(path.join(contentDir, 'catalog.json'), 'utf8');
  const manifestText = readFileSync(path.join(contentDir, 'manifest.json'), 'utf8');
  const catalog = JSON.parse(catalogText) as {
    environment: { file: string };
    rotunda: { file: string };
    plinth: { file: string };
    looks: { id: string; file: string }[];
  };
  const manifest = JSON.parse(manifestText) as {
    sets: { full: { files: Record<string, { bytes: number }> } };
  };
  const bytes = (file: string): number => manifest.sets.full.files[file].bytes;
  const withoutEnvironment =
    bytes(catalog.rotunda.file) + bytes(catalog.plinth.file) + bytes(catalog.looks[0].file);

  async function firstReading(countEnvironment: boolean | undefined): Promise<ProgressReading> {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(new Response(url.endsWith('manifest.json') ? manifestText : catalogText)),
    );
    const readings: ProgressReading[] = [];
    let stop: (() => void) | null = null;
    try {
      stop =
        countEnvironment === undefined
          ? trackFirstFrameProgress('/content', (reading) => readings.push(reading))
          : trackFirstFrameProgress('/content', (reading) => readings.push(reading), countEnvironment);
      await vi.waitFor(() => {
        expect(readings.some((reading) => reading.expected > 0)).toBe(true);
      });
    } finally {
      stop?.();
      vi.unstubAllGlobals();
    }
    return readings.find((reading) => reading.expected > 0)!;
  }

  it('waits for no environment bytes by default: the procedural sky is not fetched', async () => {
    const reading = await firstReading(undefined);
    expect(reading.expected).toBe(withoutEnvironment);
    expect(reading.totalFiles).toBe(3);
  });

  it('counts the HDR only under the ?sky=hdr diagnostic', async () => {
    const reading = await firstReading(true);
    expect(reading.expected).toBe(withoutEnvironment + bytes(catalog.environment.file));
    expect(reading.totalFiles).toBe(4);
  });

  it.each([
    [false, false, false], [false, false, true],
    [true, false, false], [true, false, true],
    [true, true, false], [true, true, true],
  ])('shares tracker requests with content selection (half=%s, missing=%s, hdr=%s)',
    async (half, missing, hdr) => {
      let resolve!: (response: Response) => void;
      const full = new Promise<Response>((yes) => { resolve = yes; });
      const fetchFn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/content/catalog.json') return full;
        if (url === '/content/manifest.json') return Promise.resolve(new Response(manifestText));
        if (url === '/content/half/catalog.json') return Promise.resolve(
          new Response(missing ? 'missing' : catalogText, { status: missing ? 404 : 200 }),
        );
        throw new Error('unexpected request: ' + url);
      });
      vi.stubGlobal('fetch', fetchFn);
      // The extra HDR and nonselected look must never enter the default progress list.
      const entries = [
        { name: '/content/' + catalog.rotunda.file, transferSize: 101 },
        { name: '/content/' + catalog.plinth.file, transferSize: 202 },
        { name: '/content/' + catalog.looks[0].file, transferSize: 303 },
        { name: '/content/' + catalog.environment.file, transferSize: 404 },
        { name: '/content/looks/not-first.glb', transferSize: 999 },
      ].map((entry) => ({ ...entry, responseEnd: 1, entryType: 'resource' }));
      vi.stubGlobal('performance', { getEntriesByType: () => entries });
      const readings: ProgressReading[] = [];
      let stop: (() => void) | undefined;
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(fetchFn).not.toHaveBeenCalled();
        stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading), hdr);
        const selected = loadContentSet(half);
        resolve(new Response(catalogText));
        expect((await selected).base).toBe(half && !missing ? '/content/half' : '/content');
        await vi.waitFor(() => expect(readings.some((reading) => reading.expected > 0)).toBe(true));
        // A later consumer also reuses the settled request.
        await loadContentSet(half);
        const reading = readings.find((one) => one.expected > 0)!;
        expect(reading).toEqual({ received: hdr ? 1010 : 606,
          expected: withoutEnvironment + (hdr ? bytes(catalog.environment.file) : 0),
          ended: hdr ? 4 : 3, totalFiles: hdr ? 4 : 3, fromCache: false });
        expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
          '/content/manifest.json', '/content/catalog.json', ...(half ? ['/content/half/catalog.json'] : []),
        ]);
        if (missing) expect(warning).toHaveBeenCalledWith(
          '[archviz] no content set at /content/half, using /content', expect.any(Error),
        );
      } finally {
        stop?.(); warning.mockRestore(); vi.unstubAllGlobals();
      }
    },
  );

  // A ?look= deep link names a later look, and the tracker must count that look's file: the
  // expected byte total covers it and the resource entries matched are exactly the three files
  // the page requests, so the readout and the bar describe the load the visitor waits for.
  it('counts a non-first ?look= in the expected bytes, paths and file count', async () => {
    const wanted = catalog.looks[1];
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(new Response(url.endsWith('manifest.json') ? manifestText : catalogText)),
    );
    const entries = [
      { name: '/content/' + catalog.rotunda.file, transferSize: 111 },
      { name: '/content/' + catalog.plinth.file, transferSize: 222 },
      { name: '/content/' + wanted.file, transferSize: 333 },
    ].map((entry) => ({ ...entry, responseEnd: 1, entryType: 'resource' }));
    vi.stubGlobal('performance', { getEntriesByType: () => entries });
    const readings: ProgressReading[] = [];
    const stop = trackFirstFrameProgress(
      '/content', (reading) => readings.push(reading), false, wanted.id,
    );
    try {
      await vi.waitFor(() => {
        expect(readings.some((reading) => reading.expected > 0)).toBe(true);
      });
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
    const reading = readings.find((one) => one.expected > 0)!;
    expect(reading.expected).toBe(
      bytes(catalog.rotunda.file) + bytes(catalog.plinth.file) + bytes(wanted.file),
    );
    expect(reading.totalFiles).toBe(3);
    // The stub sizes arrive only when the tracker's expected paths name these three files.
    expect(reading.received).toBe(666);
    expect(reading.ended).toBe(3);
  });

  // The picker and the tracker resolve the same raw ?look= value through the same rule, so the
  // bar's total always describes the look the page shows first, whatever the value names.
  it.each([
    { label: 'no look parameter', search: '' },
    { label: 'an unknown id', search: '?look=missing' },
    { label: 'a file name', search: `?look=${catalog.looks[1].file}` },
    { label: 'a later look id', search: `?look=${catalog.looks[1].id}` },
  ])('tracker and picker agree on the first-frame look for $label', async ({ search }) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const params = new URLSearchParams(search);
    const chosen = chooseLook(parseCatalog(JSON.parse(catalogText)), params);
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(new Response(url.endsWith('manifest.json') ? manifestText : catalogText)),
    );
    const readings: ProgressReading[] = [];
    const stop = trackFirstFrameProgress(
      '/content', (reading) => readings.push(reading), false, params.get('look'),
    );
    try {
      await vi.waitFor(() => {
        expect(readings.some((reading) => reading.expected > 0)).toBe(true);
      });
    } finally {
      stop();
      warning.mockRestore();
      vi.unstubAllGlobals();
    }
    const reading = readings.find((one) => one.expected > 0)!;
    expect(reading.expected).toBe(
      bytes(catalog.rotunda.file) + bytes(catalog.plinth.file) + bytes(chosen.file),
    );
    expect(reading.totalFiles).toBe(3);
  });
});
