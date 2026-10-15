import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../src/content-security-policy';
import { createShowroomConfig } from '../../vite.config';

const config = createShowroomConfig({});
const [, productionCspPlugin] = config.plugins;

const directives = CONTENT_SECURITY_POLICY.split(';').map((entry) => entry.trim().split(/\s+/));
const sources = new Map(directives.map(([name, ...values]) => [name, values]));

describe('production content security policy', () => {
  it.each([
    ['script-src', ["'self'", "'unsafe-eval'"], 'module scripts, Basis bindings and decoder WASM'],
    ['style-src', ["'self'"], 'external application and UI stylesheets'],
    ['img-src', ["'self'"], 'poster, thumbnails and brand icon'],
    ['connect-src', ["'self'", 'blob:'], 'full/half catalogues, GLBs, collision, HDR, Basis and music'],
    ['worker-src', ['blob:'], 'KTX2 texture workers'],
  ])('limits %s to the sources for %s (%s)', (directive, expected) => {
    expect(sources.get(directive as string)).toEqual(expected);
  });

  it.each(['default-src', 'base-uri', 'object-src', 'frame-src', 'form-action'])(
    'closes %s', (directive) => {
      expect(sources.get(directive)).toEqual(["'none'"]);
    },
  );

  it('has no wildcard source', () => {
    expect(directives.flat().some((token) => token.includes('*'))).toBe(false);
  });

  it('prohibits inline script execution', () => {
    expect(sources.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('allows string evaluation only in script-src', () => {
    expect(directives.filter(([, ...values]) => values.includes("'unsafe-eval'")))
      .toEqual([['script-src', "'self'", "'unsafe-eval'"]]);
  });

  it('uses only the inventoried directives with no duplicate or header-only directive', () => {
    expect(directives.map(([name]) => name).sort()).toEqual([
      'base-uri', 'connect-src', 'default-src', 'form-action', 'frame-src',
      'img-src', 'object-src', 'script-src', 'style-src', 'worker-src',
    ]);
  });

  it('registers the plugin for builds only', () => {
    expect(config.plugins).toContain(productionCspPlugin);
    expect(productionCspPlugin.apply).toBe('build');
  });

  it('prepends the exported policy as a meta tag after Vite transforms the HTML', () => {
    expect(productionCspPlugin.transformIndexHtml.order).toBe('post');
    expect(productionCspPlugin.transformIndexHtml.handler()).toEqual([{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: CONTENT_SECURITY_POLICY,
      },
      injectTo: 'head-prepend',
    }]);
  });
});
