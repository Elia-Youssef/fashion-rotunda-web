// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANDELA_RANGE, DAYLIGHT_RANGE, DEFAULT_RIG } from '../../src/lighting/rig';
import type { Rig } from '../../src/lighting/rig';
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

function mount(rig: Rig = DEFAULT_RIG, onChange = vi.fn()): LightPanelHandle {
  panel = mountLightPanel(root, { rig, onChange });
  return panel;
}

function rows(): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.lightpanel__row')];
}

function studioControl(
  id: string,
  name: 'on' | 'intensity' | 'color',
): HTMLInputElement {
  const found = root.querySelector<HTMLInputElement>(`[data-light="${id}"] [id$="-${id}-${name}"]`);
  if (!found) throw new Error(`no ${name} control for ${id}`);
  return found;
}

function studioReadout(id: string, name: 'intensity' | 'color'): string {
  const input = studioControl(id, name);
  const output = root.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
  if (!output) throw new Error(`no readout for ${id} ${name}`);
  return output.textContent ?? '';
}

function daylightControl(): HTMLInputElement {
  const found = root.querySelector<HTMLInputElement>('input.lightpanel__range--daylight');
  if (!found) throw new Error('no daylight range control found');
  return found;
}

function daylightReadout(): string {
  const input = daylightControl();
  const output = root.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
  if (!output) throw new Error('no daylight readout found');
  return output.textContent ?? '';
}

describe('mountLightPanel', () => {
  it('renders exactly four rows: Key, Fill, Back, and Daylight', () => {
    mount();
    expect(rows()).toHaveLength(4);
    expect(rows().map((r) => r.dataset.light)).toEqual(['key', 'fill', 'back', 'daylight']);
    expect(rows().map((r) => r.querySelector('legend')?.textContent)).toEqual([
      'KeyLight',
      'FillLight',
      'BackLight',
      'Daylight',
    ]);
  });

  it('contains zero Top, Indirect, Kelvin, or Preset controls', () => {
    mount();
    expect(root.querySelector('[data-light="top"]')).toBeNull();
    expect(root.querySelector('[data-light="indirect"]')).toBeNull();
    expect(root.querySelector('select')).toBeNull();
    expect(root.querySelector('.lightpanel__presets')).toBeNull();
    expect(root.querySelectorAll('input[id*="kelvin"]')).toHaveLength(0);
  });

  it('spans intensity in candela for Key, Fill, and Back [0, 50]', () => {
    mount();
    for (const id of ['key', 'fill', 'back']) {
      const input = studioControl(id, 'intensity');
      expect(input.type).toBe('range');
      expect(input.min).toBe(String(CANDELA_RANGE[0]));
      expect(input.max).toBe(String(CANDELA_RANGE[1]));
      expect(input.step).toBe('0.5');
    }
  });

  it('provides native color inputs with #RRGGBB readouts for Key, Fill, Back', () => {
    mount();
    for (const id of ['key', 'fill', 'back']) {
      const input = studioControl(id, 'color');
      expect(input.type).toBe('color');
      expect(input.value.startsWith('#')).toBe(true);
      expect(studioReadout(id, 'color')).toBe(input.value);
    }
  });

  it('initializes default readouts matching authored values', () => {
    mount();
    expect(studioReadout('key', 'intensity')).toBe('15.0 cd');
    expect(studioReadout('key', 'color')).toBe('#ffffff');

    expect(studioReadout('fill', 'intensity')).toBe('7.0 cd');
    expect(studioReadout('fill', 'color')).toBe('#ffffff');

    expect(studioReadout('back', 'intensity')).toBe('7.0 cd');
    expect(studioReadout('back', 'color')).toBe('#ffffff');
  });

  it('provides a continuous Daylight range with Dawn/Day/Dusk guidance', () => {
    mount();
    const range = daylightControl();
    expect(range.type).toBe('range');
    expect(range.min).toBe(String(DAYLIGHT_RANGE[0]));
    expect(range.max).toBe(String(DAYLIGHT_RANGE[1]));
    expect(daylightReadout()).toBe('Day');

    const guidance = root.querySelector('.lightpanel__guidance');
    expect(guidance).not.toBeNull();
    expect(guidance?.textContent).toContain('Dawn');
    expect(guidance?.textContent).toContain('Day');
    expect(guidance?.textContent).toContain('Dusk');
  });

  it('changing checkbox fires onChange with updated on state', () => {
    const onChange = vi.fn();
    mount(DEFAULT_RIG, onChange);

    const check = studioControl('key', 'on');
    check.checked = false;
    check.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const emittedRig = onChange.mock.calls[0][0] as Rig;
    expect(emittedRig.lights.find((l) => l.id === 'key')?.on).toBe(false);
  });

  it('dragging intensity slider fires onChange with updated candela', () => {
    const onChange = vi.fn();
    mount(DEFAULT_RIG, onChange);

    const range = studioControl('key', 'intensity');
    range.value = '35.5';
    range.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const emittedRig = onChange.mock.calls[0][0] as Rig;
    expect(emittedRig.lights.find((l) => l.id === 'key')?.intensity).toBe(35.5);
    expect(studioReadout('key', 'intensity')).toBe('35.5 cd');
  });

  it('changing color fires onChange with normalized color hex', () => {
    const onChange = vi.fn();
    mount(DEFAULT_RIG, onChange);

    const color = studioControl('key', 'color');
    color.value = '#00ff88';
    color.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const emittedRig = onChange.mock.calls[0][0] as Rig;
    expect(emittedRig.lights.find((l) => l.id === 'key')?.color).toBe('#00ff88');
    expect(studioReadout('key', 'color')).toBe('#00ff88');
  });

  it('dragging daylight range fires onChange and updates readout', () => {
    const onChange = vi.fn();
    mount(DEFAULT_RIG, onChange);

    const range = daylightControl();
    range.value = '0.1';
    range.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const emittedRig = onChange.mock.calls[0][0] as Rig;
    expect(emittedRig.daylight).toBe(0.1);
    expect(daylightReadout()).toBe('Dawn');
  });

  it('setRig updates controls without calling onChange', () => {
    const onChange = vi.fn();
    const handle = mount(DEFAULT_RIG, onChange);

    const nextRig: Rig = {
      lights: [
        { ...DEFAULT_RIG.lights[0], intensity: 40, color: '#123456' },
        { ...DEFAULT_RIG.lights[1], on: true, intensity: 20 },
        { ...DEFAULT_RIG.lights[2], intensity: 10 },
      ],
      daylight: 0.9,
      exposure: 1,
    };

    handle.setRig(nextRig);
    expect(onChange).not.toHaveBeenCalled();

    expect(studioReadout('key', 'intensity')).toBe('40.0 cd');
    expect(studioReadout('key', 'color')).toBe('#123456');
    expect(studioControl('fill', 'on').checked).toBe(true);
    expect(daylightReadout()).toBe('Dusk');
  });

  it('dispose removes panel element and aborts listeners', () => {
    const onChange = vi.fn();
    const handle = mount(DEFAULT_RIG, onChange);
    const range = studioControl('key', 'intensity');

    handle.dispose();
    expect(root.querySelector('.lightpanel')).toBeNull();

    range.value = '10';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
