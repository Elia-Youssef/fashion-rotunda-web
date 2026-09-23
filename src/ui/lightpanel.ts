// The simplified lighting panel: exactly Key, Fill, Back, and Daylight/Atmosphere.
// Native form controls only, no canvas and no three.js import.
// Every change leaves through updateLight or updateDaylight, producing whole, immutable Rig objects.

import './lightpanel.css';

import {
  CANDELA_RANGE,
  DAYLIGHT_RANGE,
  DAYLIGHT_STEP,
  normalizeHexColor,
  updateDaylight,
  updateLight,
} from '../lighting/rig';
import type { Rig, RigLight, RigStudioLightId } from '../lighting/rig';

export interface LightPanelOptions {
  rig: Rig;
  /** The whole new rig after every input, never a mutation of the rig passed in. */
  onChange: (rig: Rig) => void;
}

export interface LightPanelHandle {
  /** Updates every control from the rig without triggering onChange. */
  setRig(rig: Rig): void;
  dispose(): void;
}

let panelSerial = 0;

interface StudioRowControls {
  entry: RigLight;
  row: HTMLElement;
  on: HTMLInputElement;
  intensity: HTMLInputElement;
  intensityValue: HTMLOutputElement;
  color: HTMLInputElement;
  colorValue: HTMLOutputElement;
}

interface DaylightControls {
  range: HTMLInputElement;
  value: HTMLOutputElement;
}

function formatCandela(value: number): string {
  return `${value.toFixed(1)} cd`;
}

function formatDaylightPhase(value: number): string {
  if (value < 0.35) return 'Dawn';
  if (value > 0.65) return 'Dusk';
  return 'Day';
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** Text only assistive technology reads: the light's name in front of a control's own label. */
function hiddenPrefix(text: string): HTMLSpanElement {
  const span = element('span', 'lightpanel__sr');
  span.textContent = `${text} `;
  return span;
}

/** A label word that shows in one layout only: `sheet` below the desktop bar, `bar` in it. */
function layoutText(text: string, layout: 'sheet' | 'bar'): HTMLSpanElement {
  const span = element('span', `lightpanel__label-text lightpanel__label-text--${layout}`);
  span.textContent = text;
  return span;
}

function addStudioRow(panel: HTMLElement, entry: RigLight, idPrefix: string): StudioRowControls {
  const row = element('fieldset', 'lightpanel__row');
  row.dataset.light = entry.id;

  const legend = element('legend', 'lightpanel__name');
  legend.textContent = entry.label;
  row.appendChild(legend);

  // 1. Native Enabled Checkbox
  const onGroup = element('div', 'lightpanel__control-group lightpanel__control-group--switch');
  const onId = `${idPrefix}-${entry.id}-on`;
  // The sheets keep their short "On"; the desktop bar reads "Enabled" beside the box, as the
  // Unreal panel does. CSS shows one word; the hidden one leaves the accessible name.
  const onLabel = element('label', 'lightpanel__label lightpanel__label--switch');
  onLabel.htmlFor = onId;
  onLabel.append(hiddenPrefix(entry.label), layoutText('On', 'sheet'), layoutText('Enabled', 'bar'));
  const on = element('input', 'lightpanel__switch');
  on.type = 'checkbox';
  on.id = onId;
  on.checked = entry.on;
  on.dataset.tooltip = `Toggle ${entry.label} on or off`;
  onGroup.append(onLabel, on);

  // 2. Labelled Intensity Range with Candela Readout
  const intensityGroup = element('div', 'lightpanel__control-group lightpanel__control-group--range');
  const intensityId = `${idPrefix}-${entry.id}-intensity`;
  const intensityLabel = element('label', 'lightpanel__label lightpanel__label--quiet');
  intensityLabel.htmlFor = intensityId;
  intensityLabel.append(hiddenPrefix(entry.label), 'Intensity');
  const intensity = element('input', 'lightpanel__range');
  intensity.type = 'range';
  intensity.id = intensityId;
  intensity.min = String(CANDELA_RANGE[0]);
  intensity.max = String(CANDELA_RANGE[1]);
  intensity.step = '0.5';
  intensity.value = String(entry.intensity);
  intensity.dataset.tooltip = `Adjust ${entry.label} intensity in candela`;

  const intensityValue = element('output', 'lightpanel__value lightpanel__value--intensity');
  intensityValue.setAttribute('for', intensityId);
  intensityValue.textContent = formatCandela(entry.intensity);
  intensityGroup.append(intensityLabel, intensity, intensityValue);

  // 3. Labelled Native Colour Input with Normalized #RRGGBB Readout
  const colorGroup = element('div', 'lightpanel__control-group lightpanel__control-group--color');
  const colorId = `${idPrefix}-${entry.id}-color`;
  const colorLabel = element('label', 'lightpanel__label lightpanel__label--quiet');
  colorLabel.htmlFor = colorId;
  colorLabel.append(hiddenPrefix(entry.label), 'Color');
  const color = element('input', 'lightpanel__color');
  color.type = 'color';
  color.id = colorId;
  color.value = entry.color;
  color.dataset.tooltip = `Choose ${entry.label} color`;

  const colorValue = element('output', 'lightpanel__value lightpanel__value--color');
  colorValue.setAttribute('for', colorId);
  colorValue.textContent = entry.color;
  colorGroup.append(colorLabel, color, colorValue);

  row.append(onGroup, intensityGroup, colorGroup);
  panel.appendChild(row);

  return {
    entry,
    row,
    on,
    intensity,
    intensityValue,
    color,
    colorValue,
  };
}

function addDaylightRow(panel: HTMLElement, daylight: number, idPrefix: string): DaylightControls {
  const row = element('fieldset', 'lightpanel__row lightpanel__row--daylight');
  row.dataset.light = 'daylight';

  const legend = element('legend', 'lightpanel__name');
  legend.textContent = 'Daylight';
  row.appendChild(legend);

  const group = element('div', 'lightpanel__control-group lightpanel__control-group--daylight');
  const rangeId = `${idPrefix}-daylight`;
  const listId = `${idPrefix}-daylight-list`;

  const label = element('label', 'lightpanel__label');
  label.htmlFor = rangeId;
  label.append(hiddenPrefix('Daylight'), 'Atmosphere');

  const trackWrap = element('div', 'lightpanel__daylight-track');

  const range = element('input', 'lightpanel__range lightpanel__range--daylight');
  range.type = 'range';
  range.id = rangeId;
  range.min = String(DAYLIGHT_RANGE[0]);
  range.max = String(DAYLIGHT_RANGE[1]);
  range.step = String(DAYLIGHT_STEP);
  range.value = String(daylight);
  range.setAttribute('list', listId);
  range.dataset.tooltip = 'Continuous daylight atmosphere: Dawn to Day to Dusk';

  // Visible Dawn / Day / Dusk guidance marks
  const guidance = element('div', 'lightpanel__guidance');
  guidance.setAttribute('aria-hidden', 'true');
  const dawnMark = element('span', 'lightpanel__guidance-item');
  dawnMark.textContent = 'Dawn';
  const dayMark = element('span', 'lightpanel__guidance-item');
  dayMark.textContent = 'Day';
  const duskMark = element('span', 'lightpanel__guidance-item');
  duskMark.textContent = 'Dusk';
  guidance.append(dawnMark, dayMark, duskMark);

  // Native datalist support
  const datalist = element('datalist', 'lightpanel__datalist');
  datalist.id = listId;
  const optDawn = document.createElement('option');
  optDawn.value = '0';
  optDawn.label = 'Dawn';
  const optDay = document.createElement('option');
  optDay.value = '0.5';
  optDay.label = 'Day';
  const optDusk = document.createElement('option');
  optDusk.value = '1.0';
  optDusk.label = 'Dusk';
  datalist.append(optDawn, optDay, optDusk);

  trackWrap.append(range, guidance, datalist);

  const value = element('output', 'lightpanel__value lightpanel__value--daylight');
  value.setAttribute('for', rangeId);
  value.textContent = formatDaylightPhase(daylight);

  group.append(label, trackWrap, value);
  row.appendChild(group);
  panel.appendChild(row);

  return { range, value };
}

export function mountLightPanel(root: HTMLElement, options: LightPanelOptions): LightPanelHandle {
  panelSerial += 1;
  const idPrefix = `lightpanel-${panelSerial}`;

  const panel = element('section', 'lightpanel');
  panel.setAttribute('aria-label', 'Studio lights');

  let current = options.rig;

  // Render 3 Studio Light Rows: Key, Fill, Back
  const studioRows = current.lights.map((entry) => addStudioRow(panel, entry, idPrefix));

  // Render 1 Daylight / Atmosphere Row
  const daylightControls = addDaylightRow(panel, current.daylight, idPrefix);

  root.appendChild(panel);

  function studioEntryFor(id: RigStudioLightId): RigLight | undefined {
    return current.lights.find((light) => light.id === id);
  }

  function render(): void {
    for (const row of studioRows) {
      const entry = studioEntryFor(row.entry.id);
      if (!entry) continue;
      row.on.checked = entry.on;
      row.intensity.value = String(entry.intensity);
      row.intensityValue.textContent = formatCandela(entry.intensity);
      row.color.value = entry.color;
      row.colorValue.textContent = entry.color;
    }

    daylightControls.range.value = String(current.daylight);
    daylightControls.value.textContent = formatDaylightPhase(current.daylight);
  }

  function emit(next: Rig): void {
    current = next;
    render();
    options.onChange(next);
  }

  const listeners = new AbortController();
  const signal = listeners.signal;

  // Bind studio light row listeners
  for (const row of studioRows) {
    const id = row.entry.id;
    row.on.addEventListener(
      'change',
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
    row.color.addEventListener(
      'input',
      () => {
        emit(updateLight(current, id, { color: normalizeHexColor(row.color.value) }));
      },
      { signal },
    );
  }

  // Bind daylight row listener
  daylightControls.range.addEventListener(
    'input',
    () => {
      emit(updateDaylight(current, Number(daylightControls.range.value)));
    },
    { signal },
  );

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
