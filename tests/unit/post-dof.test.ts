import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DOF_BOKEH_SCALE } from '../../src/post/chain';

// The 2026-09-23 client request halved the at-rest depth-of-field blur. The chain reaches that
// through the bokeh scale alone, which is only true while three's DepthOfFieldNode uses the scale
// for the blur taps' step and nowhere else; the source checks below fail if an upgrade changes that,
// or if the chain stops using the constant at either of its two sites.

const require = createRequire(import.meta.url);
const nodeSource = readFileSync(
  require.resolve('three/examples/jsm/tsl/display/DepthOfFieldNode.js'),
  'utf8',
);
const chainSource = readFileSync(new URL('../../src/post/chain.ts', import.meta.url), 'utf8');
const SEE_COMMENT = 'see the DOF_BOKEH_SCALE comment in src/post/chain.ts';

describe('depth-of-field bokeh scale', () => {
  it('is half of the 2.5 the chain used before the client request', () => {
    expect(DOF_BOKEH_SCALE).toBe(1.25);
  });

  it('is what the chain sets at graph build and on every render, with no literal 2.5 left', () => {
    expect(
      chainSource.match(/bokehScaleUniform = uniform\(DOF_BOKEH_SCALE\);/g),
      `the uniform is initialised from the constant; ${SEE_COMMENT}`,
    ).toHaveLength(1);
    expect(
      chainSource.match(/bokehScaleUniform\.value = isDofOn \? DOF_BOKEH_SCALE : 0\.0;/g),
      `the per-render assignment uses the constant; ${SEE_COMMENT}`,
    ).toHaveLength(1);
    expect(
      chainSource.match(/bokehScale\w*(\s*=\s*uniform\(|\.value\s*=)[^;]*2\.5/g),
      `no bokeh scale site sets a literal 2.5; ${SEE_COMMENT}`,
    ).toBeNull();
  });

  it('only scales the blur step in DepthOfFieldNode, not the CoC or the composite blend', () => {
    const reads = nodeSource.match(/this\.bokehScaleNode(?!\s*=)/g) ?? [];
    expect(
      reads,
      `DepthOfFieldNode reads bokehScaleNode only for the blur step; ${SEE_COMMENT}`,
    ).toHaveLength(2);
    const stepLines = nodeSource.match(
      /const sampleStep = this\._invSize\.mul\( this\.bokehScaleNode \)\.mul\( CoC \);/g,
    );
    expect(stepLines, `both blur passes step by invSize * bokehScale * CoC; ${SEE_COMMENT}`).toHaveLength(2);
    expect(nodeSource, `the near blend ignores the bokeh scale; ${SEE_COMMENT}`).toContain(
      'const blendNear = min( near.a, 0.5 ).mul( 2 );',
    );
    expect(nodeSource, `the far blend ignores the bokeh scale; ${SEE_COMMENT}`).toContain(
      'const blendFar = min( far.a, 0.5 ).mul( 2 );',
    );
  });
});
