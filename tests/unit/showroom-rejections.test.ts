import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShowroomHarness, finishFade } from '../support/showroom';

// The caller's side of a failed call: unknown ids and unavailable variants reject before any
// fetch or scene change, and HTTP or parser failures leave the visible look untouched and a
// retry working.

const { createGltfLoader, parseAsync } = vi.hoisted(() => ({
  createGltfLoader: vi.fn<() => Promise<GLTFLoader>>(),
  parseAsync: vi.fn<(bytes: ArrayBuffer | string, path: string) => Promise<GLTF>>(),
}));

vi.mock('../../src/scene/loaders', () => ({ createGltfLoader }));

const harness = createShowroomHarness(parseAsync);

beforeEach(() => {
  vi.resetAllMocks();
  const loader: GLTFLoader = Object.create(null);
  loader.parseAsync = parseAsync;
  createGltfLoader.mockResolvedValue(loader);
  vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: false })) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  performance.clearMarks('look-switch-start');
  performance.clearMeasures('look-switch');
});

describe('createShowroom', () => {
  it('rejects an unknown look before fetching or changing the scene', async () => {
    const { showroom, fetchMock, onChange } = harness();
    await expect(showroom.showLook('missing')).rejects.toThrow(
      'no look with the id "missing" in the catalogue',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showroom.currentLook).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects variant selection without a look on screen', async () => {
    const { showroom, onChange } = harness();
    await expect(showroom.setVariant('light')).rejects.toThrow(
      'setVariant("light") needs a look on screen',
    );
    expect(showroom.currentVariant).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects an unavailable variant without changing the material or selected variant', async () => {
    const { showroom, first, onChange } = harness();
    await showroom.showLook('first');
    await expect(showroom.setVariant('missing')).rejects.toThrow(
      'the look "first" has no variant "missing"',
    );
    expect(first.mannequin.material).toBe(first.materials[0]);
    expect(first.parser.getDependency).toHaveBeenCalledTimes(1);
    expect(showroom.currentVariant).toBe('base');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports a static HTTP failure without attaching partial statics', async () => {
    const { showroom, rotunda, plinth, fetchMock, onChange } = harness();
    // The response status is part of the public error message, not a timing or a budget.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(showroom.loadStatics()).rejects.toThrow('content: /content/rotunda.glb answered 503');
    expect(rotunda.root.parent).toBeNull();
    expect(plinth.root.parent).toBeNull();
    expect(showroom.turntableState.plinthAttached).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a current look HTTP failure, preserves the visible look, and permits a retry', async () => {
    const { showroom, first, second, fetchMock, onChange } = harness();
    await showroom.showLook('first');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(showroom.showLook('second')).rejects.toThrow(
      'content: /content/looks/second.glb answered 404',
    );
    expect(showroom.currentLook).toBe('first');
    expect(first.root.parent).not.toBeNull();
    expect(first.disposal.geometry).not.toHaveBeenCalled();
    expect(showroom.fading).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);

    await showroom.showLook('second');
    expect(showroom.currentLook).toBe('second');
    expect(second.root.parent).not.toBeNull();
    await finishFade(showroom);
  });

  it('propagates a current parser error without replacing the visible look', async () => {
    const { showroom, first, onChange } = harness();
    await showroom.showLook('first');
    const failure = new Error('invalid glTF');
    parseAsync.mockRejectedValueOnce(failure);
    await expect(showroom.showLook('second')).rejects.toBe(failure);
    expect(showroom.currentLook).toBe('first');
    expect(first.root.parent).not.toBeNull();
    expect(first.disposal.geometry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('resolves a superseded parser failure while keeping the winning look', async () => {
    const { showroom, second, onChange, pauseFirstParse } = harness();
    const parse = pauseFirstParse();
    const older = showroom.showLook('first');
    await parse.entered;
    await showroom.showLook('second');
    const resolved = expect(older).resolves.toBeUndefined();
    parse.reject(new Error('retired parse failed'));
    await resolved;
    expect(showroom.currentLook).toBe('second');
    expect(second.root.parent).not.toBeNull();
    expect(second.disposal.geometry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
