// @vitest-environment jsdom
import { readFileSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOUCH_POINTER_QUERY } from '../../src/tiers/decide';
import * as entryLobby from '../../src/ui/entry-lobby';
import {
  buildLobbyMarkup, FULL_POSTER_URL, PHONE_POSTER_URL,
} from '../../src/ui/entry-lobby/markup';

/**
 * The lobby markup must stay stable across refactors of src/ui/entry-lobby. The expected
 * bytes are exact strings in this file, not snapshot files, so the unit directory keeps one
 * file per suite. Characters outside printable ASCII are escaped.
 */
function asciiEscaped(html: string): string {
  return html.replace(/[^\t\n\r\x20-\x7E]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

describe('entry lobby public surface', () => {
  it('keeps every runtime export importable from src/ui/entry-lobby', () => {
    expect(Object.keys(entryLobby).sort()).toEqual([
      'APPROVED_FACTS',
      'lobbyWanted',
      'mountEntryLobby',
      'trackFirstFrameProgress',
    ]);
  });
});

describe('entry lobby markup pin', () => {
  it('builds the pinned lobby element byte for byte', () => {
    const element = buildLobbyMarkup(document);
    expect(asciiEscaped(element.outerHTML)).toBe(BUILT_LOBBY_MARKUP);
  });
});

describe('entry lobby poster selection', () => {
  function posterMarkup(kind: 'built' | 'shipped'): Element {
    const root = kind === 'built' ? buildLobbyMarkup(document) :
      new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    return root.querySelector('.entry-lobby__poster')!;
  }

  it.each(['built', 'shipped'] as const)('puts the shared pointer query and both URLs in %s markup', (kind) => {
    const poster = posterMarkup(kind);
    const picture = poster.querySelector('picture');
    expect(poster.children).toHaveLength(1);
    expect(picture).not.toBeNull();
    expect(Array.from(picture!.children, (element) => element.tagName)).toEqual(['SOURCE', 'IMG']);
    expect(TOUCH_POINTER_QUERY).toBe('(pointer: coarse)');
    expect(picture!.querySelector('source')?.getAttribute('media')).toBe(TOUCH_POINTER_QUERY);
    expect(picture!.querySelector('source')?.getAttribute('srcset')).toBe(PHONE_POSTER_URL);
    expect(picture!.querySelector('img')?.getAttribute('src')).toBe(FULL_POSTER_URL);
  });

  it('keeps the built and shipped poster markup identical', () => {
    expect(posterMarkup('built').outerHTML).toBe(posterMarkup('shipped').outerHTML);
  });

  it('ships a phone poster within 100000 bytes', () => {
    const bytes = statSync('public/poster/hero-phone.jpg').size;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(100_000);
  });
});

describe('entry lobby mounted markup pin', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    document.body.innerHTML = '';
  });

  it('mounts the pinned lobby markup byte for byte', () => {
    const lobby = entryLobby.mountEntryLobby({ root, search: '', store: null, random: () => 0 });
    expect(asciiEscaped(lobby.element.outerHTML)).toBe(MOUNTED_LOBBY_MARKUP);
  });
});

const BUILT_LOBBY_MARKUP = `<div id="entry-lobby" class="entry-lobby" role="dialog" aria-modal="true" aria-labelledby="entry-lobby-title" data-state="idle">
      <div class="entry-lobby__scrim" aria-hidden="true"></div>
      <div class="entry-lobby__poster" aria-hidden="true">
        <!-- A coarse-pointer ?tier= diagnostic override keeps the phone poster while loading another set. -->
        <picture>
          <source media="(pointer: coarse)" srcset="/poster/hero-phone.jpg">
          <img src="/poster/hero.jpg" alt="" class="entry-lobby__poster-img">
        </picture>
      </div>

      <header class="entry-lobby__header">
        <div class="entry-lobby__brand-lockup">
          <div class="entry-lobby__mark" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
              <circle cx="50" cy="50" r="45" stroke="currentColor" stroke-width="2.5"></circle>
              <circle cx="50" cy="50" r="40" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.75"></circle>
              <path d="M 23 48 A 27 27 0 0 1 77 48" stroke="currentColor" stroke-width="2"></path>
              <line x1="50" y1="13" x2="50" y2="21" stroke="currentColor" stroke-width="2"></line>
              <line x1="33" y1="20" x2="39" y2="27" stroke="currentColor" stroke-width="1.8"></line>
              <line x1="67" y1="20" x2="61" y2="27" stroke="currentColor" stroke-width="1.8"></line>
              <path d="M 45 25 L 50 19 L 55 25 L 55 69 L 45 69 Z" fill="currentColor"></path>
              <path d="M 33 35 L 41 35 L 41 69 L 33 69 Z" fill="currentColor"></path>
              <path d="M 59 35 L 67 35 L 67 69 L 59 69 Z" fill="currentColor"></path>
              <path d="M 21 47 L 29 47 L 29 69 L 21 69 Z" fill="currentColor"></path>
              <path d="M 71 47 L 79 47 L 79 69 L 71 69 Z" fill="currentColor"></path>
              <path d="M 19 75 L 23 72 L 77 72 L 81 75 L 77 78 L 23 78 Z" fill="currentColor"></path>
              <path d="M 27 81 L 73 81 L 71 85 L 29 85 Z" fill="currentColor"></path>
              <line x1="50" y1="88" x2="50" y2="92" stroke="currentColor" stroke-width="2"></line>
              <line x1="37" y1="88" x2="33" y2="91" stroke="currentColor" stroke-width="1.5"></line>
              <line x1="63" y1="88" x2="67" y2="91" stroke="currentColor" stroke-width="1.5"></line>
            </svg>
          </div>
          <div class="entry-lobby__divider" aria-hidden="true"></div>
          <div class="entry-lobby__wordmark-text">
            <span class="entry-lobby__title" id="entry-lobby-title">FASHION ROTUNDA</span>
            <span class="entry-lobby__subtitle">HAUTE COUTURE ARCHIVE</span>
          </div>
        </div>
        <div class="entry-lobby__header-controls">
          <button type="button" class="entry-lobby__music-switch" data-music="armed" aria-pressed="true">
            <svg class="music-switch__glyph" viewBox="0 0 16 16" aria-hidden="true">
              <ellipse cx="5.2" cy="12.3" rx="3.1" ry="2.3" transform="rotate(-14 5.2 12.3)"></ellipse>
              <rect x="7.6" y="2.6" width="1.3" height="9.8"></rect>
              <path d="M8.9 2.6c2.7 1.6 3.9 3.8 3.2 6.7-.3-2.4-1.5-3.9-3.2-4.6z"></path>
            </svg>
            <span class="music-switch__label">Music on</span>
          </button>
        </div>
      </header>

      <div class="entry-lobby__content">
        <div class="entry-lobby__card">
          <div class="entry-lobby__card-inner-frame" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--tl" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--tr" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--bl" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--br" aria-hidden="true"></div>

          <div class="entry-lobby__idle-pane">
            <p class="entry-lobby__eyebrow">AN INTERACTIVE EXHIBITION OF HAUTE COUTURE &amp; ARCHITECTURE</p>
            <p class="entry-lobby__desc">Step inside the glazed rotunda to explore archival couture silhouettes beneath the daylight dome.</p>
            <noscript>
              <p class="entry-lobby__noscript">JavaScript is required to load and interact with the 3D Fashion Rotunda exhibition.</p>
            </noscript>
            <div class="entry-lobby__action-area">
              <button type="button" class="entry-lobby__load-btn" id="lobby-load-btn">
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--tl" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--tr" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--bl" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--br" aria-hidden="true"></span>
                LOAD EXPERIENCE
              </button>
            </div>
            <p class="entry-lobby__telemetry" aria-hidden="true">WEBGPU NATIVE \\u2022 WEBGL 2 FALLBACK \\u2022 THREE-LIGHT STUDIO RIG \\u2022 KTX2</p>
          </div>

          <div class="entry-lobby__loading-pane" hidden="">
            <h2 class="entry-lobby__loading-title">LOADING YOUR EXPERIENCE</h2>
            <div class="entry-lobby__bar-container">
              <progress class="entry-lobby__progress-bar" max="1" value="0" aria-label="Exhibition loading progress"></progress>
            </div>
            <p class="entry-lobby__status" aria-live="polite">Loading your experience</p>
            <p class="entry-lobby__progress-readout">0.0 MB of 0.0 MB</p>
            <div class="entry-lobby__fact-container">
              <div class="entry-lobby__fact-diamond" aria-hidden="true"></div>
              <span class="entry-lobby__fact-heading">ARCHITECTURAL &amp; GRAPHICS PROVENANCE</span>
              <p class="entry-lobby__fact-text">"Built on WebGPU for next-generation hardware rasterization, with seamless automatic fallback to WebGL 2."</p>
            </div>
          </div>

          <div class="entry-lobby__error-pane" hidden="">
            <div class="entry-lobby__error-icon" aria-hidden="true">
              <svg viewBox="0 0 44 44" fill="none">
                <polygon points="22,4 40,38 4,38" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"></polygon>
                <line x1="22" y1="16" x2="22" y2="28" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"></line>
                <circle cx="22" cy="33" r="1.5" fill="currentColor"></circle>
              </svg>
            </div>
            <h2 class="entry-lobby__error-title">SHOWROOM INITIALIZATION FAILED</h2>
            <p class="entry-lobby__error-message">We were unable to load the 3D showroom assets. Please verify your internet connection and select retry below.</p>
            <button type="button" class="entry-lobby__retry-btn" id="lobby-retry-btn">RETRY LOADING</button>
          </div>
        </div>
      </div>
    </div>`;

const MOUNTED_LOBBY_MARKUP = `<div id="entry-lobby" class="entry-lobby" role="dialog" aria-modal="true" aria-labelledby="entry-lobby-title" data-state="idle" tabindex="-1">
      <div class="entry-lobby__scrim" aria-hidden="true"></div>
      <div class="entry-lobby__poster" aria-hidden="true">
        <!-- A coarse-pointer ?tier= diagnostic override keeps the phone poster while loading another set. -->
        <picture>
          <source media="(pointer: coarse)" srcset="/poster/hero-phone.jpg">
          <img src="/poster/hero.jpg" alt="" class="entry-lobby__poster-img">
        </picture>
      </div>

      <header class="entry-lobby__header">
        <div class="entry-lobby__brand-lockup">
          <div class="entry-lobby__mark" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
              <circle cx="50" cy="50" r="45" stroke="currentColor" stroke-width="2.5"></circle>
              <circle cx="50" cy="50" r="40" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.75"></circle>
              <path d="M 23 48 A 27 27 0 0 1 77 48" stroke="currentColor" stroke-width="2"></path>
              <line x1="50" y1="13" x2="50" y2="21" stroke="currentColor" stroke-width="2"></line>
              <line x1="33" y1="20" x2="39" y2="27" stroke="currentColor" stroke-width="1.8"></line>
              <line x1="67" y1="20" x2="61" y2="27" stroke="currentColor" stroke-width="1.8"></line>
              <path d="M 45 25 L 50 19 L 55 25 L 55 69 L 45 69 Z" fill="currentColor"></path>
              <path d="M 33 35 L 41 35 L 41 69 L 33 69 Z" fill="currentColor"></path>
              <path d="M 59 35 L 67 35 L 67 69 L 59 69 Z" fill="currentColor"></path>
              <path d="M 21 47 L 29 47 L 29 69 L 21 69 Z" fill="currentColor"></path>
              <path d="M 71 47 L 79 47 L 79 69 L 71 69 Z" fill="currentColor"></path>
              <path d="M 19 75 L 23 72 L 77 72 L 81 75 L 77 78 L 23 78 Z" fill="currentColor"></path>
              <path d="M 27 81 L 73 81 L 71 85 L 29 85 Z" fill="currentColor"></path>
              <line x1="50" y1="88" x2="50" y2="92" stroke="currentColor" stroke-width="2"></line>
              <line x1="37" y1="88" x2="33" y2="91" stroke="currentColor" stroke-width="1.5"></line>
              <line x1="63" y1="88" x2="67" y2="91" stroke="currentColor" stroke-width="1.5"></line>
            </svg>
          </div>
          <div class="entry-lobby__divider" aria-hidden="true"></div>
          <div class="entry-lobby__wordmark-text">
            <span class="entry-lobby__title" id="entry-lobby-title">FASHION ROTUNDA</span>
            <span class="entry-lobby__subtitle">HAUTE COUTURE ARCHIVE</span>
          </div>
        </div>
        <div class="entry-lobby__header-controls">
          <button type="button" class="entry-lobby__music-switch" data-music="armed" aria-pressed="true">
            <svg class="music-switch__glyph" viewBox="0 0 16 16" aria-hidden="true">
              <ellipse cx="5.2" cy="12.3" rx="3.1" ry="2.3" transform="rotate(-14 5.2 12.3)"></ellipse>
              <rect x="7.6" y="2.6" width="1.3" height="9.8"></rect>
              <path d="M8.9 2.6c2.7 1.6 3.9 3.8 3.2 6.7-.3-2.4-1.5-3.9-3.2-4.6z"></path>
            </svg>
            <span class="music-switch__label">Music on</span>
          </button>
        </div>
      </header>

      <div class="entry-lobby__content">
        <div class="entry-lobby__card">
          <div class="entry-lobby__card-inner-frame" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--tl" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--tr" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--bl" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--br" aria-hidden="true"></div>

          <div class="entry-lobby__idle-pane">
            <p class="entry-lobby__eyebrow">AN INTERACTIVE EXHIBITION OF HAUTE COUTURE &amp; ARCHITECTURE</p>
            <p class="entry-lobby__desc">Step inside the glazed rotunda to explore archival couture silhouettes beneath the daylight dome.</p>
            <noscript>
              <p class="entry-lobby__noscript">JavaScript is required to load and interact with the 3D Fashion Rotunda exhibition.</p>
            </noscript>
            <div class="entry-lobby__action-area">
              <button type="button" class="entry-lobby__load-btn" id="lobby-load-btn">
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--tl" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--tr" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--bl" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--br" aria-hidden="true"></span>
                LOAD EXPERIENCE
              </button>
            </div>
            <p class="entry-lobby__telemetry" aria-hidden="true">WEBGPU NATIVE \\u2022 WEBGL 2 FALLBACK \\u2022 THREE-LIGHT STUDIO RIG \\u2022 KTX2</p>
          </div>

          <div class="entry-lobby__loading-pane" hidden="">
            <h2 class="entry-lobby__loading-title">LOADING YOUR EXPERIENCE</h2>
            <div class="entry-lobby__bar-container">
              <progress class="entry-lobby__progress-bar" max="1" value="0" aria-label="Exhibition loading progress"></progress>
            </div>
            <p class="entry-lobby__status" aria-live="polite">Loading your experience</p>
            <p class="entry-lobby__progress-readout">0.0 MB of 0.0 MB</p>
            <div class="entry-lobby__fact-container">
              <div class="entry-lobby__fact-diamond" aria-hidden="true"></div>
              <span class="entry-lobby__fact-heading">ARCHITECTURAL &amp; GRAPHICS PROVENANCE</span>
              <p class="entry-lobby__fact-text">"Built on WebGPU for next-generation hardware rasterization, with seamless automatic fallback to WebGL 2."</p>
            </div>
          </div>

          <div class="entry-lobby__error-pane" hidden="">
            <div class="entry-lobby__error-icon" aria-hidden="true">
              <svg viewBox="0 0 44 44" fill="none">
                <polygon points="22,4 40,38 4,38" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"></polygon>
                <line x1="22" y1="16" x2="22" y2="28" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"></line>
                <circle cx="22" cy="33" r="1.5" fill="currentColor"></circle>
              </svg>
            </div>
            <h2 class="entry-lobby__error-title">SHOWROOM INITIALIZATION FAILED</h2>
            <p class="entry-lobby__error-message">We were unable to load the 3D showroom assets. Please verify your internet connection and select retry below.</p>
            <button type="button" class="entry-lobby__retry-btn" id="lobby-retry-btn">RETRY LOADING</button>
          </div>
        </div>
      </div>
    </div>`;
