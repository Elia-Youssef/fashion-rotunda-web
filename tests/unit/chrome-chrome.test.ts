// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Catalog, CatalogLook } from '../../src/catalog/catalog';
import { markFirstFrame } from '../../src/proof/marks';
import { mountChrome } from '../../src/ui/chrome';
import type { ChromeHandle } from '../../src/ui/chrome';
import { variantDisplayName } from '../../src/ui/product-card';

function makeLook(id: string, name: string): CatalogLook {
  return {
    id,
    name,
    description: `${name} description`,
    thumbnail: `thumbs/${id}.jpg`,
    file: `looks/${id}.glb`,
    variants: ['base', 'light', 'dark'],
    defaultVariant: 'base',
    mannequinNode: 'mannequin',
  };
}

const LOOKS: CatalogLook[] = [
  makeLook('wallis-dress', 'Wallis Dress'),
  makeLook('zoot-suit', 'Zoot Suit'),
  makeLook('new-look-dress', 'New Look Dress'),
];

function makeCatalog(): Catalog {
  return {
    version: 1,
    environment: { file: 'env/school-field-cloudy-1k.hdr' },
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    looks: LOOKS,
    views: { proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 } },
  };
}

/**
 * The showroom as the chrome module sees it, with the real switcher's rules: the latest request
 * wins, earlier ones resolve superseded without touching the screen, and the visitor's chosen
 * swatch is carried to every later look that offers it. The calls array is the shared log the
 * ordering assertions read; every method and the camera hook record into it.
 */
function fakeShowroom(initialLook: string | null) {
  let currentLook: string | null = initialLook;
  let currentVariant: string | null = 'base';
  let wantedVariant: string | null = null;
  const calls: string[] = [];
  /** Look switches started but not settled. */
  const pending: Array<(won: boolean) => void> = [];

  function variantFor(id: string): string | null {
    const look = LOOKS.find((candidate) => candidate.id === id);
    if (look === undefined) {
      return null;
    }
    if (wantedVariant !== null && look.variants.includes(wantedVariant)) {
      return wantedVariant;
    }
    return look.defaultVariant;
  }

  return {
    calls,
    /** Settles the race the way the real switcher does: the latest request wins. */
    settleNextSwitch(): void {
      const winner = pending.pop();
      if (winner === undefined) {
        throw new Error('no switch to settle');
      }
      for (const superseded of pending.splice(0)) {
        superseded(false);
      }
      winner(true);
    },
    /** The outside world (the ?look= boot path) moving the showroom under the chrome. */
    setExternally(id: string, variant: string | null): void {
      currentLook = id;
      currentVariant = variant;
    },
    showLook: vi.fn((id: string): Promise<void> => {
      calls.push(`showLook:${id}`);
      return new Promise<void>((resolve) => {
        pending.push((won: boolean) => {
          if (won) {
            currentLook = id;
            currentVariant = variantFor(id);
          }
          resolve();
        });
      });
    }),
    setVariant: vi.fn((name: string): Promise<void> => {
      calls.push(`setVariant:${name}`);
      wantedVariant = name;
      currentVariant = name;
      return Promise.resolve();
    }),
    setLookYaw: vi.fn((radians: number): void => {
      calls.push(`setLookYaw:${radians}`);
    }),
    get currentLook(): string | null {
      return currentLook;
    },
    get currentVariant(): string | null {
      return currentVariant;
    },
  };
}

type FakeShowroom = ReturnType<typeof fakeShowroom>;

interface ManualSwitch {
  readonly id: string;
  /** Adopts the look as current, as the real switcher does for the request that wins. */
  land(variant?: string): void;
  /** Resolves the switch superseded, leaving whatever look is current. */
  drop(): void;
  /** Rejects the switch, as a failed load does. */
  fail(error: unknown): void;
}

/**
 * The fake showroom with switches the test settles one at a time, in any order. Sequences the
 * shared fake cannot express, like an older switch resolving after a newer failure, run through
 * this one; the object is the shared fake itself, so its live getters stay live.
 */
function manualShowroom(initialLook: string | null): FakeShowroom & { switches: ManualSwitch[] } {
  const base = fakeShowroom(initialLook);
  const switches: ManualSwitch[] = [];
  base.showLook.mockImplementation((id: string): Promise<void> => {
    base.calls.push(`showLook:${id}`);
    return new Promise<void>((resolve, reject) => {
      switches.push({
        id,
        land(variant: string = 'base'): void {
          base.setExternally(id, variant);
          resolve();
        },
        drop(): void {
          resolve();
        },
        fail(error: unknown): void {
          reject(error);
        },
      });
    });
  });
  return Object.assign(base, { switches });
}

/** Lets every pending microtask of a settle chain run before the assertions read the DOM. */
async function afterMicrotasks(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

let stripRoot: HTMLElement;
let cardRoot: HTMLElement;
let chrome: ChromeHandle | null = null;

beforeEach(() => {
  stripRoot = document.createElement('nav');
  cardRoot = document.createElement('aside');
  document.body.append(stripRoot, cardRoot);
});

afterEach(() => {
  chrome?.dispose();
  chrome = null;
  stripRoot.remove();
  cardRoot.remove();
});

interface MountOverrides {
  say?: (text: string) => void;
  showroom?: FakeShowroom;
  initialLook?: string;
  onRotateToggle?: () => boolean;
  onChange?: () => void;
  catalog?: Catalog;
  stripRoot?: HTMLElement;
  cardRoot?: HTMLElement;
}

function mount(overrides: MountOverrides = {}): { handle: ChromeHandle; showroom: FakeShowroom } {
  const showroom = overrides.showroom ?? fakeShowroom(overrides.initialLook ?? LOOKS[0].id);
  const onRotateToggle = overrides.onRotateToggle ?? vi.fn((): boolean => true);
  const onResetCamera = vi.fn((): void => {
    showroom.calls.push('resetCamera');
  });
  const onChange = overrides.onChange ?? vi.fn();
  chrome = mountChrome({
    catalog: overrides.catalog ?? makeCatalog(),
    contentBase: '/content',
    stripRoot: overrides.stripRoot ?? stripRoot,
    cardRoot: overrides.cardRoot ?? cardRoot,
    announcer: { say: overrides.say ?? vi.fn() },
    showroom,
    onRotateToggle,
    onResetCamera,
    onChange,
  });
  return { handle: chrome, showroom };
}

function stripButton(id: string): HTMLButtonElement {
  const found = stripRoot.querySelector<HTMLButtonElement>(`button[data-look="${id}"]`);
  if (!found) throw new Error(`no strip button for ${id}`);
  return found;
}

function cardText(selector: string): string {
  return cardRoot.querySelector(selector)?.textContent ?? '';
}

function swatch(variant: string): HTMLButtonElement {
  const found = cardRoot.querySelector<HTMLButtonElement>(
    `.product-card__swatch[aria-label="${variantDisplayName(variant)}"]`,
  );
  if (!found) throw new Error(`no swatch for ${variant}`);
  return found;
}

function actionButton(label: string): HTMLButtonElement {
  const found = [...cardRoot.querySelectorAll<HTMLButtonElement>('.product-card__action')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('mountChrome', () => {
  it('mounts the strip from the catalogue and the card from the showroom', () => {
    mount();
    expect(stripRoot.querySelectorAll('button')).toHaveLength(3);
    expect(stripButton('wallis-dress').getAttribute('aria-current')).toBe('true');
    expect(cardText('.product-card h2')).toBe('Wallis Dress');
  });

  it('lands the card above what the panel already held', () => {
    const badge = document.createElement('div');
    cardRoot.appendChild(badge);
    mount();
    expect(cardRoot.firstElementChild?.classList.contains('product-card')).toBe(true);
  });

  it('renders actions without an audio button or empty slot', () => {
    mount();
    const actions = [...cardRoot.querySelectorAll<HTMLButtonElement>('.product-card__action')];
    const labels = actions.map((candidate) => candidate.textContent);
    expect(labels).toEqual(['Rotate', 'Reset', 'Material']);
    expect(labels).not.toContain('Audio');
  });
});

describe('selecting a look', () => {
  it.each(['rejection', 'throw'] as const)(
    'reports a failed switch after a %s and clears the notice after retry succeeds', async (failure) => {
      const say = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { showroom } = mount({ say });
      const error = new Error('content unavailable');
      if (failure === 'throw') showroom.showLook.mockImplementationOnce(() => { throw error; });
      else showroom.showLook.mockRejectedValueOnce(error);
      const message = 'That look could not load. Select it again to try once more.';
      const status = document.querySelector<HTMLElement>('[data-look-status]');
      expect(status?.hidden).toBe(true);

      stripButton('zoot-suit').click();
      await vi.waitFor(() => expect(say).toHaveBeenCalledExactlyOnceWith(message));
      expect(status?.textContent).toBe(message);
      expect(status?.hidden).toBe(false);
      expect(status?.hasAttribute('aria-live')).toBe(false);
      expect(status?.hasAttribute('role')).toBe(false);
      expect(document.querySelectorAll('[data-look-status]')).toHaveLength(1);
      expect(showroom.currentLook).toBe('wallis-dress');
      expect(stripButton('wallis-dress').getAttribute('aria-current')).toBe('true');
      expect(stripButton('zoot-suit').hasAttribute('aria-busy')).toBe(false);
      expect(cardText('.product-card h2')).toBe('Wallis Dress');

      stripButton('zoot-suit').click();
      await vi.waitFor(() => expect(showroom.showLook).toHaveBeenCalledTimes(2));
      showroom.settleNextSwitch();
      await vi.waitFor(() => expect(status?.hidden).toBe(true));
      expect(status?.textContent).toBe('');
      expect(showroom.currentLook).toBe('zoot-suit');
      expect(say).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[archviz] the look "zoot-suit" did not load', error);
      warn.mockRestore();
    },
  );

  it('ignores a retired failure after a newer selection or disposal', async () => {
    const say = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handle, showroom } = mount({ say });
    let reject: (error: Error) => void = () => { throw new Error('request not started'); };
    showroom.showLook.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    stripButton('zoot-suit').click();
    await vi.waitFor(() => expect(showroom.showLook).toHaveBeenCalledTimes(1));
    stripButton('new-look-dress').click();
    await vi.waitFor(() => expect(showroom.showLook).toHaveBeenCalledTimes(2));
    showroom.settleNextSwitch();
    reject(new Error('retired request'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(say).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('[data-look-status]')?.hidden).toBe(true);

    showroom.showLook.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    stripButton('zoot-suit').click();
    await vi.waitFor(() => expect(showroom.showLook).toHaveBeenCalledTimes(3));
    handle.dispose();
    reject(new Error('disposed request'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(say).not.toHaveBeenCalled();
    expect(document.querySelector('[data-look-status]')).toBeNull();
    warn.mockRestore();
  });

  it('shows busy on the chosen item, then follows the showroom when it settles', async () => {
    const onChange = vi.fn();
    const { showroom } = mount({ onChange });
    stripButton('zoot-suit').click();
    expect(stripButton('zoot-suit').getAttribute('aria-busy')).toBe('true');
    // showLook starts in a microtask (a synchronous throw must stay inside the chain), so the
    // test waits for the request to exist before settling it.
    await vi.waitFor(() => {
      expect(showroom.showLook).toHaveBeenCalledWith('zoot-suit');
    });
    showroom.settleNextSwitch();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('Zoot Suit');
    });
    expect(stripButton('zoot-suit').getAttribute('aria-current')).toBe('true');
    expect(stripButton('zoot-suit').hasAttribute('aria-busy')).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('ends on the winner when a second click lands before the first settles', async () => {
    const { showroom } = mount();
    stripButton('zoot-suit').click();
    stripButton('new-look-dress').click();
    await vi.waitFor(() => {
      expect(showroom.showLook).toHaveBeenCalledTimes(2);
    });
    showroom.settleNextSwitch();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('New Look Dress');
    });
    expect(stripButton('new-look-dress').getAttribute('aria-current')).toBe('true');
    expect(stripRoot.querySelectorAll('[aria-busy]')).toHaveLength(0);
  });

  it('keeps the visitor swatch through a switch, reading it back from the showroom', async () => {
    const { showroom } = mount();
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    });
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(showroom.showLook).toHaveBeenCalledWith('zoot-suit');
    });
    showroom.settleNextSwitch();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('Zoot Suit');
    });
    expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
  });
});

describe('the swatches', () => {
  it('send the click to the showroom and mark what it took', async () => {
    const { showroom } = mount();
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(showroom.setVariant).toHaveBeenCalledWith('dark');
      expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    });
    expect(swatch('base').getAttribute('aria-checked')).toBe('false');
  });

  it('mark the showroom answer, not the request, when a variant is refused', async () => {
    const refusing = fakeShowroom('wallis-dress');
    refusing.setVariant.mockImplementation((name: string): Promise<void> => {
      refusing.calls.push(`setVariant:${name}`);
      return Promise.reject(new Error(`the look has no variant "${name}"`));
    });
    const { showroom } = mount({ showroom: refusing });
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(showroom.setVariant).toHaveBeenCalledWith('dark');
    });
    // The refusal leaves the check where the showroom says it is: on base.
    await vi.waitFor(() => {
      expect(swatch('base').getAttribute('aria-checked')).toBe('true');
    });
    expect(swatch('dark').getAttribute('aria-checked')).toBe('false');
  });

  it('check the swatch the showroom holds when the card mounts', () => {
    mount();
    expect(swatch('base').getAttribute('aria-checked')).toBe('true');
    expect(swatch('dark').getAttribute('aria-checked')).toBe('false');
  });
});

describe('Reset', () => {
  it('calls yaw, variant, camera, in that order, and ends with the default swatch', async () => {
    const { showroom } = mount();
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    });
    actionButton('Reset').click();
    await vi.waitFor(() => {
      expect(showroom.calls).toContain('resetCamera');
    });
    expect(showroom.calls.slice(-3)).toEqual(['setLookYaw:0', 'setVariant:base', 'resetCamera']);
    expect(swatch('base').getAttribute('aria-checked')).toBe('true');
  });

  it('releases a pressed Rotate button: the camera reset stops the turntable too', async () => {
    const onRotateToggle = vi.fn((): boolean => true);
    const { showroom } = mount({ onRotateToggle });
    actionButton('Rotate').click();
    expect(actionButton('Rotate').getAttribute('aria-pressed')).toBe('true');
    actionButton('Reset').click();
    await vi.waitFor(() => {
      expect(showroom.calls).toContain('resetCamera');
    });
    expect(actionButton('Rotate').getAttribute('aria-pressed')).toBe('false');
  });

  it('wins deterministically when pressed before an earlier swatch mutation settles', async () => {
    const delayed = fakeShowroom('wallis-dress');
    const pending: Array<{ name: string; resolve: () => void }> = [];
    let acceptedVariant = 'base';
    delayed.setVariant.mockImplementation((name: string): Promise<void> => {
      delayed.calls.push(`setVariant:${name}`);
      return new Promise<void>((resolve) => {
        pending.push({
          name,
          resolve: (): void => {
            acceptedVariant = name;
            delayed.setExternally('wallis-dress', acceptedVariant);
            resolve();
          },
        });
      });
    });

    const { showroom } = mount({ showroom: delayed });
    swatch('dark').click();
    actionButton('Reset').click();

    await vi.waitFor(() => {
      expect(showroom.setVariant).toHaveBeenCalledTimes(1);
    });
    expect(pending.map(({ name }) => name)).toEqual(['dark']);

    pending[0].resolve();
    await vi.waitFor(() => {
      expect(showroom.setVariant).toHaveBeenCalledTimes(2);
    });
    expect(pending.map(({ name }) => name)).toEqual(['dark', 'base']);

    pending[1].resolve();
    await vi.waitFor(() => {
      expect(showroom.calls).toContain('resetCamera');
      expect(swatch('base').getAttribute('aria-checked')).toBe('true');
    });
    expect(acceptedVariant).toBe('base');
    expect(showroom.calls.slice(-4)).toEqual([
      'setLookYaw:0',
      'setVariant:dark',
      'setVariant:base',
      'resetCamera',
    ]);
  });

  it('still resets the camera when the look refuses its default variant, and marks what the showroom kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scripted = fakeShowroom('wallis-dress');
    let attempts = 0;
    scripted.setVariant.mockImplementation((name: string): Promise<void> => {
      scripted.calls.push(`setVariant:${name}`);
      attempts += 1;
      if (attempts > 1) {
        return Promise.reject(new Error('the look would not take its default variant'));
      }
      scripted.setExternally('wallis-dress', name);
      return Promise.resolve();
    });
    const onChange = vi.fn();
    const { showroom } = mount({ showroom: scripted, onChange });
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    });
    actionButton('Reset').click();
    await vi.waitFor(() => {
      expect(showroom.calls).toContain('resetCamera');
    });
    expect(showroom.calls).toEqual([
      'setVariant:dark',
      'setLookYaw:0',
      'setVariant:base',
      'resetCamera',
    ]);
    // The refused default leaves the check where the showroom says it is: on dark.
    expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    expect(swatch('base').getAttribute('aria-checked')).toBe('false');
    expect(onChange).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('Rotate', () => {
  it('toggles through the hook and presses the button from the returned state', () => {
    const onRotateToggle = vi.fn((): boolean => true);
    mount({ onRotateToggle });
    actionButton('Rotate').click();
    expect(onRotateToggle).toHaveBeenCalledTimes(1);
    expect(actionButton('Rotate').getAttribute('aria-pressed')).toBe('true');
  });

  it('releases the button when the hook reports the turntable off', () => {
    const onRotateToggle = vi.fn((): boolean => false);
    mount({ onRotateToggle });
    actionButton('Rotate').click();
    expect(actionButton('Rotate').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('ChromeHandle.refresh', () => {
  it('follows a look changed from outside the chrome', () => {
    const { handle, showroom } = mount();
    showroom.setExternally('new-look-dress', 'light');
    handle.refresh();
    expect(cardText('.product-card h2')).toBe('New Look Dress');
    expect(stripButton('new-look-dress').getAttribute('aria-current')).toBe('true');
    expect(swatch('light').getAttribute('aria-checked')).toBe('true');
  });
});

describe('ChromeHandle.dispose', () => {
  it('empties both roots', () => {
    const badge = document.createElement('div');
    cardRoot.appendChild(badge);
    const { handle } = mount();
    handle.dispose();
    chrome = null;
    expect(stripRoot.childElementCount).toBe(0);
    expect(cardRoot.childElementCount).toBe(1);
    expect(cardRoot.firstElementChild).toBe(badge);
  });
});

describe('the thumbnail URL', () => {
  it('renders an empty box, not an image, for a look without a thumbnail', () => {
    markFirstFrame();
    const catalog = makeCatalog();
    catalog.looks = [{ ...LOOKS[0], thumbnail: null }, LOOKS[1], LOOKS[2]];
    mount({ catalog });
    expect(stripButton('wallis-dress').querySelector('img')).toBeNull();
    expect(stripButton('wallis-dress').querySelector('.catalog-strip__empty')).not.toBeNull();
    expect(cardRoot.querySelector<HTMLElement>('.product-card__thumb')?.hidden).toBe(true);
    expect(cardRoot.querySelector<HTMLElement>('.product-card__thumb-empty')?.hidden).toBe(false);
  });

  it('gives the strip and the card the thumbnail content URL', () => {
    markFirstFrame();
    mount();
    expect(stripButton('wallis-dress').querySelector('img')?.getAttribute('src')).toBe(
      '/content/thumbs/wallis-dress.jpg',
    );
    expect(cardRoot.querySelector('.product-card__thumb')?.getAttribute('src')).toBe(
      '/content/thumbs/wallis-dress.jpg',
    );
  });
});

describe('a showroom with no current look', () => {
  it('mounts the card empty and leaves the strip unmarked', () => {
    mount({ showroom: fakeShowroom(null) });
    expect(cardText('.product-card h2')).toBe('');
    expect(cardText('.product-card__description')).toBe('No look on the plinth yet.');
    expect(cardRoot.querySelectorAll('.product-card__swatch')).toHaveLength(0);
    expect(stripRoot.querySelectorAll('[aria-current]')).toHaveLength(0);
  });

  it('does nothing when Reset is pressed with no look on the plinth', async () => {
    const empty = fakeShowroom(null);
    const { showroom } = mount({ showroom: empty });
    actionButton('Reset').click();
    await afterMicrotasks();
    expect(showroom.calls).toEqual([]);
  });
});

describe('refresh after an external change', () => {
  it('keeps the last rendered look when the showroom names a look outside the catalogue', async () => {
    const { handle, showroom } = mount();
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(showroom.showLook).toHaveBeenCalledWith('zoot-suit');
    });
    showroom.settleNextSwitch();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('Zoot Suit');
    });
    showroom.setExternally('not-in-catalog', 'base');
    handle.refresh();
    expect(cardText('.product-card h2')).toBe('Zoot Suit');
    expect(stripRoot.querySelectorAll('[aria-current]')).toHaveLength(0);
  });
});

describe('the variant mutation queue', () => {
  it('keeps issuing mutations after a swatch was refused', async () => {
    const refusing = fakeShowroom('wallis-dress');
    refusing.setVariant.mockImplementation((name: string): Promise<void> => {
      refusing.calls.push(`setVariant:${name}`);
      return Promise.reject(new Error(`the look has no variant "${name}"`));
    });
    const { showroom } = mount({ showroom: refusing });
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(showroom.setVariant).toHaveBeenCalledWith('dark');
    });
    swatch('light').click();
    await vi.waitFor(() => {
      expect(showroom.setVariant).toHaveBeenCalledWith('light');
    });
    expect(showroom.setVariant).toHaveBeenCalledTimes(2);
  });
});

describe('switch races', () => {
  const failureText = 'That look could not load. Select it again to try once more.';

  it('keeps a newer failure notice when an older switch of the same look settles late', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manual = manualShowroom('wallis-dress');
    const onChange = vi.fn();
    mount({ showroom: manual, onChange });
    stripButton('zoot-suit').click();
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(manual.switches).toHaveLength(2);
    });
    manual.switches[1].land();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('Zoot Suit');
    });
    stripButton('new-look-dress').click();
    await vi.waitFor(() => {
      expect(manual.switches).toHaveLength(3);
    });
    manual.switches[2].fail(new Error('content unavailable'));
    const status = document.querySelector<HTMLElement>('[data-look-status]');
    await vi.waitFor(() => {
      expect(status?.hidden).toBe(false);
    });
    expect(status?.textContent).toBe(failureText);
    manual.switches[0].drop();
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(3);
    });
    expect(status?.textContent).toBe(failureText);
    expect(status?.hidden).toBe(false);
    warn.mockRestore();
  });

  it('keeps the failure notice when the showroom moved on before the retry settled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manual = manualShowroom('wallis-dress');
    mount({ showroom: manual });
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(manual.switches).toHaveLength(1);
    });
    manual.switches[0].fail(new Error('content unavailable'));
    const status = document.querySelector<HTMLElement>('[data-look-status]');
    await vi.waitFor(() => {
      expect(status?.hidden).toBe(false);
    });
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(manual.switches).toHaveLength(2);
    });
    manual.setExternally('new-look-dress', 'light');
    manual.switches[1].drop();
    await vi.waitFor(() => {
      expect(cardText('.product-card h2')).toBe('New Look Dress');
    });
    expect(status?.textContent).toBe(failureText);
    expect(status?.hidden).toBe(false);
    warn.mockRestore();
  });

  it('holds the busy mark until the last switch settles', async () => {
    const manual = manualShowroom('wallis-dress');
    const onChange = vi.fn();
    mount({ showroom: manual, onChange });
    stripButton('zoot-suit').click();
    stripButton('wallis-dress').click();
    await vi.waitFor(() => {
      expect(manual.switches).toHaveLength(2);
    });
    manual.switches[1].land();
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(stripRoot.querySelectorAll('[aria-busy]')).toHaveLength(1);
    expect(stripButton('wallis-dress').hasAttribute('aria-busy')).toBe(true);
    manual.switches[0].drop();
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(2);
    });
    expect(stripRoot.querySelectorAll('[aria-busy]')).toHaveLength(0);
  });

  it('stops rewriting the failure notice once disposed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manual = manualShowroom('wallis-dress');
    const { handle } = mount({ showroom: manual });
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(manual.switches).toHaveLength(1);
    });
    manual.switches[0].fail(new Error('content unavailable'));
    const status = document.querySelector<HTMLElement>('[data-look-status]');
    await vi.waitFor(() => {
      expect(status?.hidden).toBe(false);
    });
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(manual.switches).toHaveLength(2);
    });
    handle.dispose();
    manual.switches[1].land();
    await afterMicrotasks();
    expect(status?.textContent).toBe(failureText);
    expect(status?.hidden).toBe(false);
    warn.mockRestore();
  });

  it('calls nothing further once disposed', async () => {
    const manual = manualShowroom('wallis-dress');
    const onChange = vi.fn();
    const { handle } = mount({ showroom: manual, onChange });
    stripButton('zoot-suit').click();
    await vi.waitFor(() => {
      expect(manual.switches).toHaveLength(1);
    });
    handle.dispose();
    manual.switches[0].land();
    await afterMicrotasks();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('the loop invalidation', () => {
  it('asks for a redraw after a swatch change', async () => {
    const onChange = vi.fn();
    mount({ onChange });
    swatch('dark').click();
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  it('asks for a redraw after Rotate', () => {
    const onChange = vi.fn();
    mount({ onChange });
    actionButton('Rotate').click();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('the failure notice', () => {
  it('lives in the document that owns the strip root', () => {
    const otherDocument = document.implementation.createHTMLDocument('chrome notice');
    const otherStrip = otherDocument.createElement('nav');
    const otherCard = otherDocument.createElement('aside');
    otherDocument.body.append(otherStrip, otherCard);
    mount({ stripRoot: otherStrip, cardRoot: otherCard });
    expect(otherDocument.querySelector('[data-look-status]')).not.toBeNull();
    expect(document.querySelector('[data-look-status]')).toBeNull();
  });
});
