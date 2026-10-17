// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANDELA_RANGE, DAYLIGHT_RANGE, DAYLIGHT_STEP, DEFAULT_RIG } from '../../src/lighting/rig';
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

  it('provides a continuous Daylight range with Dawn/Day/Noon guidance', () => {
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
    expect(guidance?.textContent).toContain('Noon');
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

  it('emits the touched light from every row, leaving the other lights untouched', () => {
    const onChange = vi.fn();
    mount(DEFAULT_RIG, onChange);

    const fillSwitch = studioControl('fill', 'on');
    fillSwitch.checked = true;
    fillSwitch.dispatchEvent(new Event('change', { bubbles: true }));
    let emittedRig = onChange.mock.calls[0][0] as Rig;
    expect(emittedRig.lights.find((l) => l.id === 'fill')?.on).toBe(true);

    const backIntensity = studioControl('back', 'intensity');
    backIntensity.value = '12.5';
    backIntensity.dispatchEvent(new Event('input', { bubbles: true }));
    emittedRig = onChange.mock.calls[1][0] as Rig;
    expect(emittedRig.lights.find((l) => l.id === 'back')?.intensity).toBe(12.5);
    expect(emittedRig.lights.find((l) => l.id === 'key')?.intensity).toBe(15);

    const fillColor = studioControl('fill', 'color');
    fillColor.value = '#abcdef';
    fillColor.dispatchEvent(new Event('input', { bubbles: true }));
    emittedRig = onChange.mock.calls[2][0] as Rig;
    expect(emittedRig.lights.find((l) => l.id === 'fill')?.color).toBe('#abcdef');
    expect(emittedRig.lights.find((l) => l.id === 'key')?.color).toBe('#ffffff');
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
    expect(daylightReadout()).toBe('Noon');
  });

  it('labels carry the light name for assistive technology and both switch words', () => {
    mount();
    const labelText = (input: HTMLInputElement): string =>
      [...(input.labels ?? [])].map((label) => label.textContent ?? '').join(' ');
    for (const [id, name] of [
      ['key', 'KeyLight'],
      ['fill', 'FillLight'],
      ['back', 'BackLight'],
    ] as const) {
      const on = studioControl(id, 'on');
      expect(on.labels).toHaveLength(1);
      const onLabel = on.labels?.[0];
      expect(onLabel?.querySelector('.lightpanel__sr')?.textContent).toBe(`${name} `);
      expect(onLabel?.querySelector('.lightpanel__label-text--sheet')?.textContent).toBe('On');
      expect(onLabel?.querySelector('.lightpanel__label-text--bar')?.textContent).toBe('Enabled');
      expect(labelText(studioControl(id, 'intensity'))).toBe(`${name} Intensity`);
      expect(labelText(studioControl(id, 'color'))).toBe(`${name} Color`);
    }
    expect(labelText(daylightControl())).toBe('Daylight Atmosphere');
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

  it('dispose silences the switch, color and daylight listeners as well', () => {
    const onChange = vi.fn();
    const handle = mount(DEFAULT_RIG, onChange);
    const on = studioControl('key', 'on');
    const color = studioControl('key', 'color');
    const daylight = daylightControl();

    handle.dispose();

    on.checked = false;
    on.dispatchEvent(new Event('change', { bubbles: true }));
    color.value = '#123456';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    daylight.value = '0.2';
    daylight.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('names the daylight phase on both sides of every boundary', () => {
    const handle = mount();
    const phase = (daylight: number): string => {
      handle.setRig({ ...DEFAULT_RIG, daylight });
      return daylightReadout();
    };
    expect(phase(0.34)).toBe('Dawn');
    expect(phase(0.35)).toBe('Day');
    expect(phase(0.64)).toBe('Day');
    expect(phase(0.65)).toBe('Day');
    expect(phase(0.66)).toBe('Noon');
  });

  it('steps the daylight range at the authored resolution', () => {
    mount();
    expect(daylightControl().step).toBe(String(DAYLIGHT_STEP));
  });

  it('renders every studio switch as a native checkbox', () => {
    mount();
    for (const id of ['key', 'fill', 'back']) {
      expect(studioControl(id, 'on').type).toBe('checkbox');
    }
  });

  it('names the panel landmark and hides the guidance marks from assistive technology', () => {
    mount();
    expect(root.querySelector('section.lightpanel')?.getAttribute('aria-label')).toBe(
      'Studio lights',
    );
    expect(root.querySelector('.lightpanel__guidance')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('anchors the daylight range to its Dawn, Day, Noon datalist', () => {
    mount();
    const listId = daylightControl().getAttribute('list');
    expect(listId).toBeTruthy();
    const options = [
      ...(document.getElementById(listId ?? '')?.querySelectorAll('option') ?? []),
    ];
    expect(options.map((option) => option.value)).toEqual(['0', '0.5', '1.0']);
    expect(options.map((option) => option.label)).toEqual(['Dawn', 'Day', 'Noon']);
  });

  it('carries a tooltip on every control', () => {
    mount();
    const controls = [
      ...(['key', 'fill', 'back'] as const).flatMap((id) => [
        studioControl(id, 'on'),
        studioControl(id, 'intensity'),
        studioControl(id, 'color'),
      ]),
      daylightControl(),
    ];
    expect(controls).toHaveLength(10);
    for (const control of controls) {
      expect(control.dataset['tooltip'] ?? '').not.toBe('');
    }
  });

  it('setRig moves every input value, not only the readouts', () => {
    const handle = mount();
    handle.setRig({
      lights: [
        { ...DEFAULT_RIG.lights[0], intensity: 40, color: '#123456' },
        DEFAULT_RIG.lights[1],
        DEFAULT_RIG.lights[2],
      ],
      daylight: 0.9,
      exposure: 1,
    });
    expect(studioControl('key', 'intensity').value).toBe('40');
    expect(studioControl('key', 'color').value).toBe('#123456');
    expect(daylightControl().value).toBe('0.9');
  });

  it('setRig leaves a row untouched when the incoming rig lacks that light', () => {
    const handle = mount();
    handle.setRig({
      lights: [
        { ...DEFAULT_RIG.lights[0], intensity: 40 },
        { ...DEFAULT_RIG.lights[1], intensity: 20 },
      ],
      daylight: 0.2,
      exposure: 1,
    });
    expect(studioReadout('key', 'intensity')).toBe('40.0 cd');
    expect(studioReadout('fill', 'intensity')).toBe('20.0 cd');
    expect(studioReadout('back', 'intensity')).toBe('7.0 cd');
    expect(studioControl('back', 'on').checked).toBe(false);
    expect(daylightReadout()).toBe('Dawn');
  });

  it('setRig still updates the rows after an earlier light is missing', () => {
    const handle = mount();
    handle.setRig({
      lights: [
        { ...DEFAULT_RIG.lights[1], intensity: 40 },
        { ...DEFAULT_RIG.lights[2], intensity: 10 },
      ],
      daylight: 0.2,
      exposure: 1,
    });
    expect(studioReadout('key', 'intensity')).toBe('15.0 cd');
    expect(studioReadout('fill', 'intensity')).toBe('40.0 cd');
    expect(studioReadout('back', 'intensity')).toBe('10.0 cd');
    expect(daylightReadout()).toBe('Dawn');
  });

  it('gives every mounted panel its own control ids', () => {
    mount();
    const other = document.createElement('div');
    document.body.appendChild(other);
    const second = mountLightPanel(other, { rig: DEFAULT_RIG, onChange: vi.fn() });
    try {
      const ids = (scope: HTMLElement): string[] =>
        [...scope.querySelectorAll('[id]')].map((node) => node.id);
      const firstIds = ids(root);
      const secondIds = ids(other);
      expect(firstIds.length).toBeGreaterThan(0);
      expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);

      const labelsResolveWithin = (scope: HTMLElement): boolean =>
        [...scope.querySelectorAll<HTMLLabelElement>('label[for]')].every((label) =>
          scope.contains(document.getElementById(label.htmlFor)),
        );
      expect(labelsResolveWithin(root)).toBe(true);
      expect(labelsResolveWithin(other)).toBe(true);
    } finally {
      second.dispose();
      other.remove();
    }
  });
});
