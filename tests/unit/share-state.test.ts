import { describe, expect, it } from 'vitest';

import { DEFAULT_RIG, serializeRig } from '../../src/lighting/rig';
import {
  DEFAULT_RIG_SERIALIZED,
  SHARE_PARAMS,
  buildSearch,
  parseShareState,
} from '../../src/share/state';
import type { ShareState } from '../../src/share/state';

/** The all-null state, with the fields a test cares about overridden. */
function stateWith(overrides: Partial<ShareState>): ShareState {
  return {
    look: null,
    variant: null,
    rig: null,
    camera: null,
    yaw: null,
    turning: false,
    music: null,
    post: null,
    ...overrides,
  };
}

describe('share state parsing and serialization', () => {
  it('owns the expected list of parameters in order', () => {
    expect(SHARE_PARAMS).toEqual([
      'look',
      'variant',
      'rig',
      'cam',
      'yaw',
      'turn',
      'music',
      'post',
    ]);
  });

  it('publishes the level rig as the URL spells it, so the mount cannot recompute it apart', () => {
    expect(DEFAULT_RIG_SERIALIZED).toBe(serializeRig(DEFAULT_RIG));
  });

  it('parses an empty or bare URL as all null or default values', () => {
    const empty = parseShareState('');
    expect(empty).toEqual({
      look: null,
      variant: null,
      rig: null,
      camera: null,
      yaw: null,
      turning: false,
      music: null,
      post: null,
    });

    const questionOnly = parseShareState('?');
    expect(questionOnly).toEqual(empty);
  });

  it('omits defaults to keep a fresh page bare', () => {
    const defaultState: ShareState = {
      look: null,
      variant: null,
      rig: serializeRig(DEFAULT_RIG),
      camera: null,
      yaw: 0,
      turning: false,
      music: 'on',
      post: null,
    };
    expect(buildSearch('', defaultState)).toBe('');
    expect(buildSearch('?webgl=1', defaultState)).toBe('?webgl=1');
  });

  it('parses valid parameters and rounds camera and yaw to three decimals', () => {
    const search =
      '?look=look-03&variant=dark&cam=1.23456,2.34567,3.45678&yaw=1.57079&turn=1&music=off&post=ao';
    const state = parseShareState(search);
    expect(state).toEqual({
      look: 'look-03',
      variant: 'dark',
      rig: null,
      camera: [1.235, 2.346, 3.457],
      yaw: 1.571,
      turning: true,
      music: 'off',
      post: 'ao',
    });

    const built = buildSearch('', state);
    expect(built).toBe(
      '?look=look-03&variant=dark&cam=1.235,2.346,3.457&yaw=1.571&turn=1&music=off&post=ao',
    );
  });

  it('ignores malformed camera coordinates', () => {
    expect(parseShareState('?cam=1,2').camera).toBeNull();
    expect(parseShareState('?cam=1,2,abc').camera).toBeNull();
    expect(parseShareState('?cam=1,2,3,4,5').camera).toBeNull();
  });

  it('round trips three camera coordinates without adding a target height', () => {
    const state = parseShareState('?cam=1.5,2,3');
    expect(state.camera).toEqual([1.5, 2, 3]);
    expect(buildSearch('', state)).toBe('?cam=1.500,2.000,3.000');
    expect(parseShareState(buildSearch('', state)).camera).toEqual([1.5, 2, 3]);
  });

  it('round trips a fourth camera number as target height with three decimals', () => {
    const state = parseShareState('?cam=1.5,2,3,1.65432');
    expect(state.camera).toEqual([1.5, 2, 3, 1.654]);
    expect(buildSearch('', state)).toBe('?cam=1.500,2.000,3.000,1.654');
    expect(parseShareState(buildSearch('', state)).camera).toEqual([1.5, 2, 3, 1.654]);
  });

  it('preserves an explicit fourth camera number without choosing a proof default', () => {
    expect(buildSearch('', stateWith({ camera: [1.5, 2, 3, 1] }))).toBe('?cam=1.500,2.000,3.000,1.000');
    expect(buildSearch('', stateWith({ camera: [1.5, 2, 3, 1.0001] }))).toBe('?cam=1.500,2.000,3.000,1.000');
    expect(parseShareState('?cam=1.5,2,3,1').camera).toEqual([1.5, 2, 3, 1]);
  });

  it.each(['1,2,3,NaN', '1,2,3,Infinity', '1,2,3,', '1,2,,1.5'])(
    'rejects malformed camera height or coordinates in %s', (value) => {
      expect(parseShareState(`?cam=${value}`).camera).toBeNull();
    },
  );

  it('ignores malformed yaw and treats zero yaw as null', () => {
    expect(parseShareState('?yaw=abc').yaw).toBeNull();
    expect(parseShareState('?yaw=0').yaw).toBeNull();
    expect(parseShareState('?yaw=0.000').yaw).toBeNull();
  });

  it('ignores unknown post or music values', () => {
    expect(parseShareState('?post=all').post).toBeNull();
    expect(parseShareState('?post=invalid').post).toBeNull();
    expect(parseShareState('?music=loud').music).toBeNull();
  });

  it('ignores a malformed rig string', () => {
    expect(parseShareState('?rig=invalid-data').rig).toBeNull();
    expect(parseShareState('?rig=v2;foo,bar').rig).toBeNull();
  });

  it('preserves foreign parameters in their original order and position', () => {
    const current = '?webgl=1&tier=high&look=look-01&e2e=1&proof=1';
    const nextState: ShareState = {
      look: 'look-02',
      variant: 'light',
      rig: null,
      camera: [1.5, 2.0, 3.0],
      yaw: 0.5,
      turning: true,
      music: 'off',
      post: 'aa',
    };

    const updated = buildSearch(current, nextState);
    expect(updated).toBe(
      '?webgl=1&tier=high&look=look-02&e2e=1&proof=1&variant=light' +
        '&cam=1.500,2.000,3.000&yaw=0.500&turn=1&music=off&post=aa',
    );
  });

  it('drops owned parameters that become null while preserving foreign parameters', () => {
    const current = '?webgl=1&look=look-02&variant=dark&turn=1&e2e=1';
    const nextState: ShareState = {
      look: null,
      variant: null,
      rig: null,
      camera: null,
      yaw: null,
      turning: false,
      music: null,
      post: null,
    };

    const updated = buildSearch(current, nextState);
    expect(updated).toBe('?webgl=1&e2e=1');
  });

  it('encodes owned values so a space or an ampersand survives the round trip', () => {
    const state: ShareState = {
      look: 'new look',
      variant: 'light & grey',
      rig: null,
      camera: null,
      yaw: null,
      turning: false,
      music: null,
      post: null,
    };

    const built = buildSearch('', state);
    expect(built).toBe('?look=new%20look&variant=light%20%26%20grey');
    const read = parseShareState(built);
    expect(read.look).toBe('new look');
    expect(read.variant).toBe('light & grey');
  });

  it('leaves the comma and the semicolon of the camera and the rig unencoded', () => {
    const state: ShareState = {
      look: null,
      variant: null,
      rig: 'v1;top,1,500.000,4500.000;e,1.200',
      camera: [1.5, 2, 3],
      yaw: null,
      turning: false,
      music: null,
      post: null,
    };

    expect(buildSearch('', state)).toBe(
      '?rig=v1;top,1,500.000,4500.000;e,1.200&cam=1.500,2.000,3.000',
    );
  });

  it('round-trips customized rigs', () => {
    const customRig = 'v1;top,1,500.000,4500.000;e,1.200';
    const state = parseShareState(`?rig=${customRig}`);
    expect(state.rig).toBe(customRig);

    const built = buildSearch('', state);
    expect(built).toBe(`?rig=${customRig}`);
  });

  it('reads a search string without the leading question mark', () => {
    expect(parseShareState('look=look-03&turn=1')).toEqual(parseShareState('?look=look-03&turn=1'));
  });

  it('reads an empty or whitespace-only look or variant as null', () => {
    expect(parseShareState('?look=').look).toBeNull();
    expect(parseShareState('?look=%20%20').look).toBeNull();
    expect(parseShareState('?variant=').variant).toBeNull();
    expect(parseShareState('?variant=%20').variant).toBeNull();
  });

  it('reads turn as running only for the exact value 1', () => {
    expect(parseShareState('?turn=1').turning).toBe(true);
    expect(parseShareState('?turn=0').turning).toBe(false);
    expect(parseShareState('?turn=true').turning).toBe(false);
  });

  it('reads both answers of the music switch', () => {
    expect(parseShareState('?music=on').music).toBe('on');
    expect(parseShareState('?music=off').music).toBe('off');
  });

  it('reads every post override a link may carry', () => {
    expect(parseShareState('?post=off').post).toBe('off');
    expect(parseShareState('?post=ao').post).toBe('ao');
    expect(parseShareState('?post=aa').post).toBe('aa');
  });

  it('accepts current v2 rig strings, including the day and exposure segments', () => {
    expect(parseShareState(`?rig=${DEFAULT_RIG_SERIALIZED}`).rig).toBe(DEFAULT_RIG_SERIALIZED);
    expect(parseShareState('?rig=v2;e,1.500;day,0.250').rig).toBe('v2;e,1.500;day,0.250');
  });

  it('accepts every light id of the legacy v1 rig strings', () => {
    for (const id of ['top', 'indirect', 'key', 'fill', 'back', 'sun', 'sky', 'e']) {
      const rig = `v1;${id},1,500.000,4500.000`;
      expect(parseShareState(`?rig=${rig}`).rig).toBe(rig);
    }
  });

  it('omits a blank look or variant from the built search', () => {
    expect(buildSearch('?webgl=1', stateWith({ look: '', variant: '   ' }))).toBe('?webgl=1');
  });

  it('omits a yaw that rounds to zero at three decimals', () => {
    expect(buildSearch('', stateWith({ yaw: 0.0004 }))).toBe('');
  });

  it('writes from a current search without the leading question mark', () => {
    expect(buildSearch('webgl=1', stateWith({ look: 'look-02' }))).toBe('?webgl=1&look=look-02');
  });

  it('drops empty segments a hand-typed search may leave behind', () => {
    expect(buildSearch('?webgl=1&', stateWith({}))).toBe('?webgl=1');
    expect(buildSearch('?webgl=1&&tier=high', stateWith({}))).toBe('?webgl=1&tier=high');
  });

  it('treats a valueless owned parameter as owned, replacing or dropping it', () => {
    expect(buildSearch('?look&webgl=1', stateWith({ look: 'look-02' }))).toBe(
      '?look=look-02&webgl=1',
    );
    expect(buildSearch('?look&webgl=1', stateWith({}))).toBe('?webgl=1');
  });

  it('collapses duplicate owned parameters to the first position, written once', () => {
    expect(buildSearch('?look=look-01&look=look-99&webgl=1', stateWith({ look: 'look-02' }))).toBe(
      '?look=look-02&webgl=1',
    );
  });
});
