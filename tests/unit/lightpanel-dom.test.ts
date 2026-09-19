// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RIG, updateLight } from '../../src/lighting/rig';
import type { Rig } from '../../src/lighting/rig';
import { CANDELA_RANGE, KELVIN_RANGE, SUN_ANGLE_RANGE, SUN_LUX_RANGE } from '../../src/lighting/units';
import { mountLightPanel } from '../../src/ui/lightpanel';
import type { LightPanelHandle } from '../../src/ui/lightpanel';

let root: HTMLElement;
let panel: LightPanelHandle | null = null;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  panel?.dispose();
  panel = null;
  root.remove();
});

interface MountOptions {
  rig: Rig;
  onChange: (rig: Rig) => void;
  presets: Record<string, Rig>;
}

function mount(options: Partial<MountOptions> = {}): LightPanelHandle {
  const onChange = options.onChange ?? vi.fn();
  const presets = options.presets;
  panel = mountLightPanel(
    root,
    presets
      ? { rig: options.rig ?? DEFAULT_RIG, onChange, presets }
      : { rig: options.rig ?? DEFAULT_RIG, onChange },
  );
  return panel;
}

function rows(): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.lightpanel__row')];
}

function control(id: string, name: 'on' | 'intensity' | 'kelvin' | 'angle'): HTMLInputElement {
  const found = root.querySelector<HTMLInputElement>(`[data-light="${id}"] [id$="-${id}-${name}"]`);
  if (!found) throw new Error(`no ${name} control for ${id}`);
  return found;
}

function readout(id: string, name: 'intensity' | 'kelvin' | 'angle'): string {
  const input = control(id, name);
  const output = root.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
  if (!output) throw new Error(`no readout for ${id} ${name}`);
  return output.textContent ?? '';
}

/** A real input event, the one a dragged slider fires, not a synthetic call of the handler. */
function drag(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('mountLightPanel', () => {
  it('renders one row per light, in the rig order', () => {
    mount();
    expect(rows()).toHaveLength(7);
    expect(rows().map((row) => row.dataset.light)).toEqual([
      'top',
      'key',
      'fill',
      'back',
      'indirect',
      'sun',
      'sky',
    ]);
    expect(rows().map((row) => row.querySelector('legend')?.textContent)).toEqual([
      'TopLight',
      'KeyLight',
      'FillLight',
      'BackLight',
      'IndirectLight',
      'Sun',
      'Sky',
    ]);
  });

  it('spans intensity in candela for the rect and point lights', () => {
    mount();
    for (const id of ['top', 'key', 'fill', 'back', 'indirect']) {
      const input = control(id, 'intensity');
      expect(input.type).toBe('range');
      expect(input.min).toBe(String(CANDELA_RANGE[0]));
      expect(input.max).toBe(String(CANDELA_RANGE[1]));
      expect(input.step).toBe('0.5');
    }
  });

  it('spans the sun in lux and the sky in its own scale', () => {
    mount();
    expect(control('sun', 'intensity').max).toBe(String(SUN_LUX_RANGE[1]));
    expect(control('sky', 'intensity').max).toBe('4');
    expect(control('sky', 'intensity').step).toBe('0.1');
  });

  it('spans temperature from 2700 K to 8000 K in steps of 50 on every row', () => {
    mount();
    for (const row of rows()) {
      const input = control(row.dataset.light ?? '', 'kelvin');
      expect(input.min).toBe(String(KELVIN_RANGE[0]));
      expect(input.max).toBe(String(KELVIN_RANGE[1]));
      expect(input.step).toBe('50');
    }
  });

  it('gives the sun an angle range and gives it to nothing else', () => {
    mount();
    const angle = control('sun', 'angle');
    expect(angle.min).toBe(String(SUN_ANGLE_RANGE[0]));
    expect(angle.max).toBe(String(SUN_ANGLE_RANGE[1]));
    expect(root.querySelectorAll('[id$="-angle"]')).toHaveLength(1);
  });

  it('shows the rig values with their units', () => {
    mount();
    expect(control('top', 'on').checked).toBe(true);
    expect(control('fill', 'on').checked).toBe(false);
    expect(control('top', 'intensity').value).toBe('25');
    expect(readout('top', 'intensity')).toBe('25 cd');
    expect(readout('top', 'kelvin')).toBe('6500 K');
    expect(readout('sun', 'intensity')).toBe('7 lx');
    expect(readout('sun', 'angle')).toBe('130.483 deg');
    expect(readout('sky', 'intensity')).toBe('2 scale');
  });

  it('labels every control and keeps it reachable from the keyboard', () => {
    mount();
    const inputs = [...root.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs.length).toBe(7 * 3 + 1);
    for (const input of inputs) {
      expect(input.id).not.toBe('');
      const label = root.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
      expect(label?.textContent).toBeTruthy();
      // Native controls only: nothing here is a div with a click handler, so nothing needs a tabindex.
      expect(input.tabIndex).toBe(0);
      expect(input.disabled).toBe(false);
    }
  });
});

describe('the panel reporting a change', () => {
  it('calls onChange with the whole rig, one value different', () => {
    const onChange = vi.fn();
    mount({ onChange });
    drag(control('key', 'kelvin'), '5500');
    expect(onChange).toHaveBeenCalledTimes(1);
    const next: Rig = onChange.mock.calls[0][0];
    expect(next).toEqual(updateLight(DEFAULT_RIG, 'key', { kelvin: 5500 }));
    expect(next).not.toBe(DEFAULT_RIG);
    expect(DEFAULT_RIG.lights[1].kelvin).toBe(4500);
  });

  it('reports a checkbox, a slider and the sun angle the same way', () => {
    const onChange = vi.fn();
    mount({ onChange });
    control('fill', 'on').checked = true;
    control('fill', 'on').dispatchEvent(new Event('input', { bubbles: true }));
    drag(control('top', 'intensity'), '12.5');
    drag(control('sun', 'angle'), '45');
    expect(onChange).toHaveBeenCalledTimes(3);
    const last: Rig = onChange.mock.calls[2][0];
    expect(last.lights[2].on).toBe(true);
    expect(last.lights[0].intensity).toBe(12.5);
    expect(last.lights[5].sunAngleDeg).toBe(45);
    // The sun's direction follows its angle, which is the rig's job, not the panel's.
    expect(last.lights[5].direction?.[1]).toBeCloseTo(-Math.sin((45 * Math.PI) / 180), 9);
  });

  it('accumulates: the second change carries the first', () => {
    const onChange = vi.fn();
    mount({ onChange });
    drag(control('key', 'kelvin'), '5500');
    drag(control('top', 'intensity'), '30');
    const last: Rig = onChange.mock.calls[1][0];
    expect(last.lights[1].kelvin).toBe(5500);
    expect(last.lights[0].intensity).toBe(30);
  });

  it('updates the readout as the value moves', () => {
    mount();
    drag(control('top', 'intensity'), '12.5');
    expect(readout('top', 'intensity')).toBe('12.5 cd');
  });
});

describe('LightPanelHandle.setRig', () => {
  it('updates every control without calling onChange', () => {
    const onChange = vi.fn();
    const handle = mount({ onChange });
    handle.setRig(updateLight(updateLight(DEFAULT_RIG, 'fill', { on: true }), 'top', { intensity: 40 }));
    expect(control('fill', 'on').checked).toBe(true);
    expect(control('top', 'intensity').value).toBe('40');
    expect(readout('top', 'intensity')).toBe('40 cd');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves the next change built on the rig it was given', () => {
    const onChange = vi.fn();
    const handle = mount({ onChange });
    handle.setRig(updateLight(DEFAULT_RIG, 'fill', { on: true }));
    drag(control('key', 'kelvin'), '5500');
    const next: Rig = onChange.mock.calls[0][0];
    expect(next.lights[2].on).toBe(true);
    expect(next.lights[1].kelvin).toBe(5500);
  });
});

describe('presets', () => {
  it('lists none when none are given', () => {
    mount();
    expect(root.querySelector('select')).toBeNull();
  });

  it('lists one option per preset behind a placeholder', () => {
    mount({ presets: { Studio: DEFAULT_RIG, Evening: updateLight(DEFAULT_RIG, 'sun', { intensity: 2 }) } });
    const select = root.querySelector('select');
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual(['', 'Studio', 'Evening']);
  });

  it('loads the chosen rig and goes back to its placeholder', () => {
    const onChange = vi.fn();
    const evening = updateLight(DEFAULT_RIG, 'sun', { intensity: 2 });
    mount({ onChange, presets: { Studio: DEFAULT_RIG, Evening: evening } });
    const select = root.querySelector('select');
    if (!select) throw new Error('no preset select');
    select.value = 'Evening';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(evening);
    expect(select.value).toBe('');
    expect(control('sun', 'intensity').value).toBe('2');
  });
});

describe('LightPanelHandle.dispose', () => {
  it('empties the root', () => {
    const handle = mount();
    expect(root.childElementCount).toBe(1);
    handle.dispose();
    panel = null;
    expect(root.childElementCount).toBe(0);
  });

  it('stops reporting: a control that is gone cannot fire', () => {
    const onChange = vi.fn();
    const handle = mount({ onChange });
    const input = control('key', 'kelvin');
    handle.dispose();
    panel = null;
    drag(input, '5500');
    expect(onChange).not.toHaveBeenCalled();
  });
});
