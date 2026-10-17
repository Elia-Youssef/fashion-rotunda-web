import { describe, expect, it } from 'vitest';

import { pickSource } from '../../src/audio/sources';
import type { TrackSource } from '../../src/audio/manifest';

const opus: TrackSource = { url: 'music-01.ogg', type: 'audio/ogg; codecs="opus"', bytes: 100 };
const aac: TrackSource = { url: 'music-01.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bytes: 200 };

describe('pickSource', () => {
  it('takes the first probably', () => {
    const answer = pickSource([opus, aac], (type) => (type.startsWith('audio/ogg') ? 'probably' : 'maybe'));
    expect(answer).toBe(opus);
  });

  it('a probably beats an earlier maybe', () => {
    // The AAC entry comes first and answers maybe; the Opus entry later answers probably.
    const answer = pickSource([aac, opus], (type) => (type.startsWith('audio/ogg') ? 'probably' : 'maybe'));
    expect(answer).toBe(opus);
  });

  it('takes the first maybe when nothing is probably', () => {
    const answer = pickSource([opus, aac], (type) => (type.startsWith('audio/ogg') ? '' : 'maybe'));
    expect(answer).toBe(aac);
  });

  it('keeps the first maybe when a later one also answers maybe', () => {
    const answer = pickSource([opus, aac], () => 'maybe');
    expect(answer).toBe(opus);
  });

  it('gives null when every type answers empty', () => {
    expect(pickSource([opus, aac], () => '')).toBeNull();
  });

  it('gives null for an empty list', () => {
    expect(pickSource([], () => 'probably')).toBeNull();
  });
});
