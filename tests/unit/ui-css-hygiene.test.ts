import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readStylesheet } from '../support/stylesheet';

const lobbyPath = 'src/ui/entry-lobby.css';
const noticePath = 'src/ui/startup-failure.css';

describe('component stylesheet ownership and reduced motion', () => {
  it('keeps the cover-to-black scrim transition disabled by equal specificity and later order', () => {
    const css = readFileSync(lobbyPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const mediaAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(mediaAt).toBeGreaterThan(0);
    const scrim = ".entry-lobby[data-state='cover-to-black'] .entry-lobby__scrim";
    const transitions = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => /(?:^|;)\s*transition:/.test(match[2]));
    const candidates = transitions.filter((match) => match[1].split(',').some(
      (selector) => selector.trim() === scrim,
    ));
    expect(candidates, 'state-specific transition and its reduced-motion override').toHaveLength(2);
    expect(candidates[0].index).toBeLessThan(mediaAt);
    expect(candidates[0][2]).toContain('transition: opacity var(--dur-cover-black)');
    expect(candidates[1].index).toBeGreaterThan(mediaAt);
    expect(candidates[1][2]).toMatch(/transition:\s*none\s*;/);
    expect(candidates[1][2]).not.toContain('!important');
    const selectors = candidates[1][1].split(',').map((selector) => selector.trim());
    for (const selector of ['.entry-lobby', '.entry-lobby__scrim', '.entry-lobby__load-btn',
      '.entry-lobby__music-switch', ".entry-lobby[data-state='cover-to-black']"]) {
      expect(selectors, `${selector} retains its reduced-motion override`).toContain(selector);
    }
  });

  it('loads startup notice styling from the composition root with all four notice rules', () => {
    const module = readFileSync('src/main.ts', 'utf8');
    expect(module).toContain("import './ui/startup-failure.css';");
    const notice = readStylesheet(noticePath);
    const lobby = readFileSync(lobbyPath, 'utf8');
    for (const [selector, property, value] of [
      ['.startup-notice', 'display', 'grid'],
      ['.startup-notice', 'position', 'fixed'],
      ['.startup-notice', 'inset', '0'],
      ['.startup-notice', 'z-index', 'var(--z-loss-notice)'],
      ['.startup-notice__title', 'font-weight', '600'],
      ['.startup-notice__message', 'color', 'var(--text-muted)'],
      ['.startup-notice__reload', 'justify-self', 'center'],
      ['.startup-notice__reload', 'cursor', 'pointer'],
    ]) {
      expect(notice.declaration(selector, property), `${selector} ${property}`).toBe(value);
      expect(lobby).not.toContain(`${selector} {`);
    }
  });
});
