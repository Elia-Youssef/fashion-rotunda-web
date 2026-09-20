// The lighting panel: one row per rig light, native form controls only, no canvas and no three.js import.
// It owns no lighting knowledge of its own. Every range's span, step and unit comes from the rig module, so
// a control cannot drift from what the rig will accept, and every change leaves through updateLight, so the
// caller always receives a whole, valid rig rather than a field.

import './lightpanel.css';

import { intensityScale, updateLight } from '../lighting/rig';
import type { Rig, RigLight } from '../lighting/rig';
import { KELVIN_RANGE, SUN_ANGLE_RANGE } from '../lighting/units';

export interface LightPanelOptions {
  rig: Rig;
  /** The whole new rig after every input, never a field and never a mutation of the rig passed in. */
  onChange: (rig: Rig) => void;
  /** Optional. When present a select loads one, as an action: it returns to its placeholder afterwards. */
  presets?: Record<string, Rig>;
}

export interface LightPanelHandle {
  /** Updates every control from the rig. Does not call onChange: this is the caller telling the panel. */
  setRig(rig: Rig): void;
  dispose(): void;
}

/** The temperature slider's step in kelvin. 106 stops across the span, fine enough to look continuous. */
const KELVIN_STEP = 50;

/**
 * The sun angle's step in degrees. It is this fine because the converted Unreal angle is 130.483 and a
 * coarser step would make the browser snap the value away from the rig's, leaving the readout and the thumb
 * disagreeing. A range input is continuous to a dragging hand at any step this small.
 */
const SUN_ANGLE_STEP = 0.001;

/** Ids must be unique per document, so two panels on one page cannot collide on a label's for attribute. */
let panelSerial = 0;

interface RowControls {
  entry: RigLight;
  on: HTMLInputElement;
  intensity: HTMLInputElement;
  intensityValue: HTMLOutputElement;
  kelvin: HTMLInputElement;
  kelvinValue: HTMLOutputElement;
  angle: HTMLInputElement | null;
  angleValue: HTMLOutputElement | null;
}

/** Three decimals, trailing zeros dropped: the same rounding serializeRig uses, so readouts match URLs. */
function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function formatValue(value: number, unit: string): string {
  return `${formatNumber(value)} ${unit}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** A labelled range with its readout beside it. Returns both, because the caller writes to both. */
function addRange(
  parent: HTMLElement,
  id: string,
  labelText: string,
  min: number,
  max: number,
  step: number,
  tooltipText: string,
): { input: HTMLInputElement; value: HTMLOutputElement } {
  const label = element('label', 'lightpanel__label');
  label.htmlFor = id;
  label.textContent = labelText;

  const input = element('input', 'lightpanel__range');
  input.type = 'range';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.dataset.tooltip = tooltipText;

  const value = element('output', 'lightpanel__value');
  // HTMLOutputElement.htmlFor is a token list, not a string, so the attribute is set directly.
  value.setAttribute('for', id);

  parent.append(label, input, value);
  return { input, value };
}

function addRow(panel: HTMLElement, entry: RigLight, idPrefix: string): RowControls {
  const row = element('fieldset', 'lightpanel__row');
  row.dataset.light = entry.id;

  const legend = element('legend', 'lightpanel__name');
  legend.textContent = entry.label;
  row.appendChild(legend);

  const onId = `${idPrefix}-${entry.id}-on`;
  const onLabel = element('label', 'lightpanel__label');
  onLabel.htmlFor = onId;
  onLabel.textContent = 'On';
  const on = element('input', 'lightpanel__switch');
  on.type = 'checkbox';
  on.id = onId;
  on.dataset.tooltip = `Toggle ${entry.label} on or off`;
  row.append(onLabel, on);

  const scale = intensityScale(entry.kind);
  const intensity = addRange(
    row,
    `${idPrefix}-${entry.id}-intensity`,
    'Intensity',
    scale.range[0],
    scale.range[1],
    scale.step,
    `Adjust ${entry.label} brightness`,
  );
  const kelvin = addRange(
    row,
    `${idPrefix}-${entry.id}-kelvin`,
    'Temperature',
    KELVIN_RANGE[0],
    KELVIN_RANGE[1],
    KELVIN_STEP,
    `Adjust ${entry.label} color temperature`,
  );

  const angle =
    entry.sunAngleDeg === undefined
      ? null
      : addRange(
          row,
          `${idPrefix}-${entry.id}-angle`,
          'Sun angle',
          SUN_ANGLE_RANGE[0],
          SUN_ANGLE_RANGE[1],
          SUN_ANGLE_STEP,
          'Adjust sun elevation angle',
        );

  panel.appendChild(row);
  return {
    entry,
    on,
    intensity: intensity.input,
    intensityValue: intensity.value,
    kelvin: kelvin.input,
    kelvinValue: kelvin.value,
    angle: angle === null ? null : angle.input,
    angleValue: angle === null ? null : angle.value,
  };
}

export function mountLightPanel(root: HTMLElement, options: LightPanelOptions): LightPanelHandle {
  panelSerial += 1;
  const idPrefix = `lightpanel-${panelSerial}`;

  const panel = element('section', 'lightpanel');
  panel.setAttribute('aria-label', 'Studio lights');

  let current = options.rig;

  const presets = options.presets;
  let presetSelect: HTMLSelectElement | null = null;
  if (presets && Object.keys(presets).length > 0) {
    const holder = element('div', 'lightpanel__presets');
    const id = `${idPrefix}-preset`;
    const label = element('label', 'lightpanel__label');
    label.htmlFor = id;
    label.textContent = 'Preset';
    const select = element('select', 'lightpanel__select');
    select.id = id;
    select.dataset.tooltip = 'Choose studio lighting preset';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a preset';
    select.appendChild(placeholder);
    for (const name of Object.keys(presets)) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    holder.append(label, select);
    panel.appendChild(holder);
    presetSelect = select;
  }

  const rows = options.rig.lights.map((entry) => addRow(panel, entry, idPrefix));
  root.appendChild(panel);

  function entryFor(id: RigLight['id']): RigLight | undefined {
    return current.lights.find((light) => light.id === id);
  }

  /** Writes every control from the rig. Setting a value in script fires no input event, so this is silent. */
  function render(): void {
    for (const row of rows) {
      const entry = entryFor(row.entry.id);
      if (!entry) continue;
      const scale = intensityScale(entry.kind);
      row.on.checked = entry.on;
      row.intensity.value = String(entry.intensity);
      row.intensityValue.textContent = formatValue(entry.intensity, scale.unit);
      row.kelvin.value = String(entry.kelvin);
      row.kelvinValue.textContent = formatValue(entry.kelvin, 'K');
      if (row.angle && row.angleValue && entry.sunAngleDeg !== undefined) {
        row.angle.value = String(entry.sunAngleDeg);
        row.angleValue.textContent = formatValue(entry.sunAngleDeg, 'deg');
      }
    }
  }

  function emit(next: Rig): void {
    current = next;
    // Redraw first: updateLight clamps, so the readout must show what the rig took, not what was typed.
    render();
    options.onChange(next);
  }

  // One controller for every listener the panel adds, so dispose can revoke them all at once. Removing the
  // elements is not enough on its own: a caller holding a reference to a control could still make it fire.
  const listeners = new AbortController();
  const signal = listeners.signal;

  for (const row of rows) {
    const id = row.entry.id;
    row.on.addEventListener(
      'input',
      () => {
        emit(updateLight(current, id, { on: row.on.checked }));
      },
      { signal },
    );
    row.intensity.addEventListener(
      'input',
      () => {
        emit(updateLight(current, id, { intensity: Number(row.intensity.value) }));
      },
      { signal },
    );
    row.kelvin.addEventListener(
      'input',
      () => {
        emit(updateLight(current, id, { kelvin: Number(row.kelvin.value) }));
      },
      { signal },
    );
    const angle = row.angle;
    if (angle) {
      angle.addEventListener(
        'input',
        () => {
          emit(updateLight(current, id, { sunAngleDeg: Number(angle.value) }));
        },
        { signal },
      );
    }
  }

  if (presetSelect && presets) {
    const select = presetSelect;
    select.addEventListener(
      'change',
      () => {
        const chosen = presets[select.value];
        // Back to the placeholder: the select loads a preset, it does not remember one. Any slider moved
        // afterwards would make a remembered name a lie.
        select.value = '';
        if (chosen) emit(chosen);
      },
      { signal },
    );
  }

  render();

  return {
    setRig(rig: Rig): void {
      current = rig;
      render();
    },
    dispose(): void {
      listeners.abort();
      panel.remove();
    },
  };
}
