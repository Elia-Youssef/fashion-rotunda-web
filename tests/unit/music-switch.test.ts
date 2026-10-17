// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MusicState } from '../../src/audio/music';
import { mountMusicSwitch } from '../../src/ui/music-switch';
import type { MusicSwitchHandle } from '../../src/ui/music-switch';

let root: HTMLElement;
let handle: MusicSwitchHandle | null = null;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  root.remove();
});

function mount(state: MusicState, onToggle: () => void = () => undefined): MusicSwitchHandle {
  handle = mountMusicSwitch(root, { state, onToggle });
  return handle;
}

function button(): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>('button.music-switch');
  if (found === null) {
    throw new Error('no switch button in the root');
  }
  return found;
}

function label(): string {
  const span = button().querySelector('span');
  return span?.textContent ?? '';
}

/** What the visitor reads and what assistive tech hear, per state. */
const STATE_TABLE: Array<{
  state: MusicState;
  text: string;
  pressed: string;
  busy: boolean;
  disabled: boolean;
  tooltip: string;
}> = [
  {
    state: 'off',
    text: 'Music off',
    pressed: 'false',
    busy: false,
    disabled: false,
    tooltip: 'Turn music on',
  },
  {
    state: 'armed',
    text: 'Music on',
    pressed: 'true',
    busy: false,
    disabled: false,
    tooltip: 'Starts with your first click or key',
  },
  {
    state: 'loading',
    text: 'Music on',
    pressed: 'true',
    busy: true,
    disabled: false,
    tooltip: 'Loading music',
  },
  {
    state: 'playing',
    text: 'Music on',
    pressed: 'true',
    busy: false,
    disabled: false,
    tooltip: 'Turn music off',
  },
  {
    // Never disabled: the press in this state is the retry, so the control has to stay pressable.
    // The player reports no detail, so the switch's own fixed text fills label and tooltip.
    state: 'error',
    text: 'Music unavailable',
    pressed: 'false',
    busy: false,
    disabled: false,
    tooltip: 'Music unavailable',
  },
];

describe('mountMusicSwitch', () => {
  it('mounts exactly one native button with a hidden glyph and a visible label', () => {
    mount('off');
    expect(root.childElementCount).toBe(1);
    const btn = button();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.className).toBe('music-switch');
    expect(btn.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(btn.querySelector('span')?.textContent).toBe('Music off');
    // A real button is keyboard reachable by itself; nothing here needs a tabindex.
    expect(btn.tabIndex).toBe(0);
  });

  it('renders the state it was mounted with', () => {
    mount('armed');
    expect(label()).toBe('Music on');
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });

  it.each(STATE_TABLE)('shows $state as "$text"', (row) => {
    const current = mount('off');
    current.setState(row.state, null);
    const btn = button();
    expect(label()).toBe(row.text);
    expect(btn.getAttribute('aria-pressed')).toBe(row.pressed);
    if (row.busy) {
      expect(btn.getAttribute('aria-busy')).toBe('true');
    } else {
      expect(btn.hasAttribute('aria-busy')).toBe(false);
    }
    expect(btn.disabled).toBe(row.disabled);
    expect(btn.dataset.music).toBe(row.state);
    expect(btn.dataset.tooltip).toBe(row.tooltip);
    expect(btn.hasAttribute('title')).toBe(false);
  });

  it('keeps one state after another: no attribute survives two states later', () => {
    const current = mount('off');
    current.setState('loading', null);
    expect(button().getAttribute('aria-busy')).toBe('true');
    current.setState('playing', null);
    expect(button().hasAttribute('aria-busy')).toBe(false);
    current.setState('error', null);
    expect(button().dataset.tooltip).toBe('Music unavailable');
    expect(button().hasAttribute('title')).toBe(false);
    current.setState('off', null);
    expect(button().dataset.tooltip).toBe('Turn music on');
    expect(button().hasAttribute('title')).toBe(false);
  });

  it('shows the player error reason as the tooltip, keeping the fixed label', () => {
    const current = mount('off');
    current.setState('error', 'Track unavailable');
    const btn = button();
    expect(btn.dataset.tooltip).toBe('Track unavailable');
    expect(label()).toBe('Music unavailable');
    current.setState('error', null);
    expect(btn.dataset.tooltip).toBe('Music unavailable');
  });

  it('never disables the button, so every state can be pressed', () => {
    const current = mount('off');
    for (const row of STATE_TABLE) {
      current.setState(row.state, null);
      expect(button().disabled, `${row.state} is pressable`).toBe(false);
    }
  });
});

describe('the switch reporting a press', () => {
  it('calls onToggle exactly once per click', () => {
    const onToggle = vi.fn();
    mount('off', onToggle);
    button().click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    button().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('reports a press in the error state, which is how the music is retried', () => {
    const onToggle = vi.fn();
    const current = mount('off', onToggle);
    current.setState('error', null);
    button().click();
    expect(onToggle, 'the error state retries on a press').toHaveBeenCalledTimes(1);
  });
});

describe('MusicSwitchHandle.dispose', () => {
  it('removes the button from the root', () => {
    const current = mount('off');
    expect(root.childElementCount).toBe(1);
    current.dispose();
    handle = null;
    expect(root.childElementCount).toBe(0);
  });

  it('stops reporting: a click on the removed button cannot fire', () => {
    const onToggle = vi.fn();
    const current = mount('off', onToggle);
    const btn = button();
    current.dispose();
    handle = null;
    btn.click();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
