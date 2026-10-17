// @vitest-environment jsdom
import { BoxGeometry, BufferGeometry, PerspectiveCamera, PlaneGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';

import { createWalkthrough } from '../../src/camera/walkthrough';

// Recorded from the walkthrough before its collision workspace became reusable (2026-10-10,
// working tree at cf5d4b8); the reusable workspace must reproduce every step exactly. Foot
// components are strings so the exact doubles, including negative zero, survive transcription;
// Number() decodes bit-exactly. Every step is a 100 ms update with a fixed now() of 1000.
interface BaselineStep {
  moved: boolean;
  foot: [string, string, string];
}

const BASELINE_SEQUENCES: Record<string, BaselineStep[]> = {
  wallBlockedThenFree: [
    { moved: true, foot: ['0', '0', '5.36'] },
    { moved: true, foot: ['0', '0', '5.220000000000001'] },
    { moved: true, foot: ['0', '0', '5.080000000000001'] },
    { moved: true, foot: ['0', '0', '4.940000000000001'] },
    { moved: true, foot: ['0', '0', '4.800000000000002'] },
    { moved: true, foot: ['0', '0', '4.660000000000002'] },
    { moved: true, foot: ['0', '0', '4.520000000000002'] },
    { moved: true, foot: ['0', '0', '4.4999998092651365'] },
  ],
  backOffAfterBlocked: [
    { moved: true, foot: ['0', '0', '5.36'] },
    { moved: true, foot: ['0', '0', '5.220000000000001'] },
    { moved: true, foot: ['0', '0', '5.080000000000001'] },
    { moved: true, foot: ['0', '0', '4.940000000000001'] },
    { moved: true, foot: ['0', '0', '4.800000000000002'] },
    { moved: true, foot: ['0', '0', '4.660000000000002'] },
    { moved: true, foot: ['0', '0', '4.520000000000002'] },
    { moved: true, foot: ['0', '0', '4.4999998092651365'] },
    { moved: true, foot: ['0', '0', '4.639999809265136'] },
    { moved: true, foot: ['0', '0', '4.779999809265136'] },
    { moved: true, foot: ['0', '0', '4.919999809265136'] },
  ],
  cornerDiagonal: [
    { moved: true, foot: ['1.6989949493661167', '0', '0.10100505063388338'] },
    { moved: true, foot: ['1.7979898987322334', '0', '0.0020101012677667396'] },
    { moved: true, foot: ['1.89698484809835', '0', '-0.0969848480983499'] },
    { moved: true, foot: ['1.9959797974644666', '0', '-0.19597979746446653'] },
    { moved: true, foot: ['2.0949747468305833', '0', '-0.29497474683058317'] },
    { moved: true, foot: ['2.1939696961967', '0', '-0.3939696961966998'] },
    { moved: true, foot: ['2.2929646455628165', '0', '-0.49296464556281644'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-0.5883663349636464'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-0.6841557094911778'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-0.7808619373173181'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-0.8785653303819784'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-0.977317159868822'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-1.0763121092349384'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-1.1753070586010543'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-1.2743020079671712'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-1.3732969573332878'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-1.4722919066994047'] },
    { moved: true, foot: ['2.2999999046325685', '0', '-1.4999999523162844'] },
  ],
  floorClamp: [
    { moved: true, foot: ['0', '0', '5.36'] },
    { moved: true, foot: ['0', '0', '5.220000000000001'] },
    { moved: true, foot: ['0', '0', '5.080000000000001'] },
  ],
  sprintStrafe: [
    { moved: true, foot: ['0.19798989873223327', '0', '9.802010101267767'] },
    { moved: true, foot: ['0.39597979746446654', '0', '9.604020202535533'] },
    { moved: true, foot: ['0.5939696961966998', '0', '9.4060303038033'] },
    { moved: true, foot: ['0.7919595949289331', '0', '9.208040405071067'] },
    { moved: true, foot: ['0.9899494936611664', '0', '9.010050506338834'] },
  ],
};

function encFoot(foot: [number, number, number]): [string, string, string] {
  const enc = (value: number): string => (Object.is(value, -0) ? '-0' : String(value));
  return [enc(foot[0]), enc(foot[1]), enc(foot[2])];
}

describe('walkthrough collision baseline', () => {
  // The same shapes the baseline was recorded against; a size or placement change here would
  // silently invalidate the recorded values, so the builders mirror the recorder exactly.
  function walkWallGeometry(): BufferGeometry {
    const wall = new BoxGeometry(20, 4, 0.4);
    wall.translate(0, 2, 4.0);
    return wall;
  }
  function cornerNearGeometry(): BufferGeometry {
    const floor = new PlaneGeometry(40, 40);
    floor.rotateX(-Math.PI / 2);
    const front = new BoxGeometry(20, 3, 0.4);
    front.translate(0, 1.5, -2);
    const side = new BoxGeometry(0.4, 3, 20);
    side.translate(2.8, 1.5, 0);
    return mergeGeometries([floor, front, side]) as BufferGeometry;
  }
  function floorGeometry(): PlaneGeometry {
    const floor = new PlaneGeometry(20, 20);
    floor.rotateX(-Math.PI / 2);
    return floor;
  }

  function makeOn(collision: BufferGeometry): ReturnType<typeof createWalkthrough> {
    const handle = createWalkthrough({
      camera: new PerspectiveCamera(40, 1, 0.1, 100),
      element: document.createElement('canvas'),
      collision,
      eyeHeight: 1.65,
      radius: 0.3,
      walkSpeed: 1.4,
      isTouch: false,
      onChange: () => {},
      now: () => 1000,
    });
    handle.enable();
    return handle;
  }

  function press(code: string): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  }
  function release(code: string): void {
    window.dispatchEvent(new KeyboardEvent('keyup', { code }));
  }

  function expectBaseline(
    actual: BaselineStep[],
    expected: BaselineStep[],
    label: string,
  ): void {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((step, i) => {
      expect(actual[i].moved, label + ' step ' + i).toBe(step.moved);
      expect(actual[i].foot, label + ' step ' + i).toEqual(step.foot);
    });
  }

  function trace(handle: ReturnType<typeof createWalkthrough>, steps: number): BaselineStep[] {
    const entries: BaselineStep[] = [];
    for (let i = 0; i < steps; i += 1) {
      entries.push({ moved: handle.update(100), foot: encFoot(handle.foot) });
    }
    return entries;
  }

  it('walks into the wall, holds the blocked step, and backs off freely', () => {
    const handle = makeOn(walkWallGeometry());
    press('KeyW');
    const blockedTrace = trace(handle, 8);
    release('KeyW');
    press('KeyS');
    const backTrace = trace(handle, 3);
    release('KeyS');
    handle.disable();

    expectBaseline(blockedTrace, BASELINE_SEQUENCES.wallBlockedThenFree, 'blocked');
    expectBaseline(
      blockedTrace.concat(backTrace),
      BASELINE_SEQUENCES.backOffAfterBlocked,
      'back off',
    );
    // The blocked step proposed z = 4.38 but the wall held it at the safe line; every step
    // stayed grounded.
    expect(blockedTrace[7].foot[2]).toBe('4.4999998092651365');
    for (const step of blockedTrace.concat(backTrace)) {
      expect(step.foot[1]).toBe('0');
    }
  });

  it('holds the near corner under a diagonal push', () => {
    const handle = makeOn(cornerNearGeometry());
    handle.setPose([1.6, 0, 0.2], 0, 0);
    press('KeyW');
    press('KeyD');
    const steps = trace(handle, 18);
    release('KeyD');
    release('KeyW');
    handle.disable();

    expectBaseline(steps, BASELINE_SEQUENCES.cornerDiagonal, 'corner');
    // Both walls hold the last step: x pinned by the side wall, z by the front wall.
    expect(steps[17].foot[0]).toBe('2.2999999046325685');
    expect(steps[17].foot[2]).toBe('-1.4999999523162844');
  });

  it('grounds a foot that starts below the floor and sprints freely', () => {
    const clampHandle = makeOn(floorGeometry());
    clampHandle.setPose([0, -0.5, 5.5], 0, 0);
    press('KeyW');
    const clampSteps = trace(clampHandle, 3);
    release('KeyW');
    clampHandle.disable();

    expectBaseline(clampSteps, BASELINE_SEQUENCES.floorClamp, 'floor clamp');
    for (const step of clampSteps) {
      expect(step.foot[1]).toBe('0');
    }

    const sprintHandle = makeOn(floorGeometry());
    sprintHandle.setPose([0, 0, 10], 0, 0);
    press('KeyW');
    press('ShiftLeft');
    press('KeyD');
    const sprintSteps = trace(sprintHandle, 5);
    release('KeyD');
    release('ShiftLeft');
    release('KeyW');
    sprintHandle.disable();

    expectBaseline(sprintSteps, BASELINE_SEQUENCES.sprintStrafe, 'sprint strafe');
  });
});
