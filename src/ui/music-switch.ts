// The music switch: one native button in the header, reachable from the keyboard by being a
// button, holding its whole look in music-switch.css. It owns no audio knowledge at all; it draws
// the state the player reports and forwards presses, one per click.

import './music-switch.css';

import type { MusicState } from '../audio/music';

export interface MusicSwitchOptions {
  state: MusicState;
  onToggle: () => void;
}

export interface MusicSwitchHandle {
  setState(state: MusicState, detail: string | null): void;
  dispose(): void;
}

const ARMED_TITLE = 'Starts with your first click or key';

/** What the visitor reads and what assistive tech hears, per state. */
function pressedState(state: MusicState): boolean {
  return state === 'armed' || state === 'loading' || state === 'playing';
}

export function mountMusicSwitch(root: HTMLElement, options: MusicSwitchOptions): MusicSwitchHandle {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'music-switch';

  // An eighth note: head, stem, flag. Decorative, so hidden from the accessibility tree; the text
  // span carries the meaning.
  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  glyph.setAttribute('viewBox', '0 0 16 16');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.classList.add('music-switch__glyph');

  const head = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
  head.setAttribute('cx', '5.2');
  head.setAttribute('cy', '12.3');
  head.setAttribute('rx', '3.1');
  head.setAttribute('ry', '2.3');
  head.setAttribute('transform', 'rotate(-14 5.2 12.3)');

  const stem = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  stem.setAttribute('x', '7.6');
  stem.setAttribute('y', '2.6');
  stem.setAttribute('width', '1.3');
  stem.setAttribute('height', '9.8');

  const flag = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  flag.setAttribute('d', 'M8.9 2.6c2.7 1.6 3.9 3.8 3.2 6.7-.3-2.4-1.5-3.9-3.2-4.6z');

  glyph.append(head, stem, flag);

  const label = document.createElement('span');
  label.className = 'music-switch__label';
  button.append(glyph, label);
  root.appendChild(button);

  function render(state: MusicState, detail: string | null): void {
    button.dataset.music = state;
    button.setAttribute('aria-pressed', pressedState(state) ? 'true' : 'false');
    if (state === 'loading') {
      button.setAttribute('aria-busy', 'true');
    } else {
      button.removeAttribute('aria-busy');
    }
    // Never disabled, not even in error: a disabled control is the one control nobody can retry
    // with, and every error the player reports (a failed fetch, a context that would not start)
    // is worth one more press. The muted look lives in music-switch.css on [data-music='error'].
    label.textContent =
      state === 'off' ? 'Music off' : state === 'error' ? 'Music unavailable' : 'Music on';
    if (state === 'armed') {
      button.title = ARMED_TITLE;
    } else if (state === 'error') {
      button.title = detail ?? 'Music unavailable';
    } else {
      button.removeAttribute('title');
    }
  }

  // One controller for every listener, so dispose revokes them all at once.
  const listeners = new AbortController();
  button.addEventListener(
    'click',
    () => {
      options.onToggle();
    },
    { signal: listeners.signal },
  );

  render(options.state, null);

  return {
    setState(state: MusicState, detail: string | null): void {
      render(state, detail);
    },
    dispose(): void {
      listeners.abort();
      button.remove();
    },
  };
}
