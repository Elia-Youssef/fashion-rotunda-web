import { describe, expect, it } from 'vitest';

import { DEFAULT_RIG, serializeRig } from '../../src/lighting/rig';
import {
  DEFAULT_RIG_SERIALIZED,
  SHARE_PARAMS,
  buildSearch,
  parseShareState,
} from '../../src/share/state';
import type { ShareState } from '../../src/share/state';

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
    expect(parseShareState('?cam=1,2,3,4').camera).toBeNull();
  });

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
});
