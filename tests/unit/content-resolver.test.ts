import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentUrl } from '../../src/catalog/catalog';
import { createContentResolver } from '../../src/content/resolver';
import { contentSecurityPolicy, CONTENT_SECURITY_POLICY } from '../../src/content-security-policy';
import configure, { contentBuildSettings, createShowroomConfig } from '../../vite.config';
import { walkContentFiles } from '../../pipeline/r2/lib/objects.mjs';

// Frozen request inventory of both shipped sets, including shared files and both audio formats.
const defaultRequests = [
  '/content/catalog.json', '/content/collision.glb', '/content/manifest.json',
  '/content/plinth.glb', '/content/rotunda.glb',
  '/content/basis/basis_transcoder.js', '/content/basis/basis_transcoder.wasm',
  '/content/env/school-field-cloudy-1k.hdr',
  '/content/half/catalog.json', '/content/half/collision.glb',
  '/content/half/plinth.glb', '/content/half/rotunda.glb',
  '/content/half/looks/blue-silk-dress.glb', '/content/half/looks/geoffrey-beene.glb',
  '/content/half/looks/jumpsuit-dress.glb', '/content/half/looks/mondrian-dress.glb',
  '/content/half/looks/new-look-dress.glb', '/content/half/looks/wallis-dress.glb',
  '/content/half/looks/zoot-suit.glb',
  '/content/half/thumbs/blue-silk-dress.jpg', '/content/half/thumbs/geoffrey-beene.jpg',
  '/content/half/thumbs/jumpsuit-dress.jpg', '/content/half/thumbs/mondrian-dress.jpg',
  '/content/half/thumbs/new-look-dress.jpg', '/content/half/thumbs/wallis-dress.jpg',
  '/content/half/thumbs/zoot-suit.jpg',
  '/content/looks/blue-silk-dress.glb', '/content/looks/geoffrey-beene.glb',
  '/content/looks/jumpsuit-dress.glb', '/content/looks/mondrian-dress.glb',
  '/content/looks/new-look-dress.glb', '/content/looks/wallis-dress.glb', '/content/looks/zoot-suit.glb',
  '/content/music/music-01.m4a', '/content/music/music-01.ogg', '/content/music/music.json',
  '/content/thumbs/blue-silk-dress.jpg', '/content/thumbs/geoffrey-beene.jpg',
  '/content/thumbs/jumpsuit-dress.jpg', '/content/thumbs/mondrian-dress.jpg',
  '/content/thumbs/new-look-dress.jpg', '/content/thumbs/wallis-dress.jpg', '/content/thumbs/zoot-suit.jpg',
];
const paths = defaultRequests.map((url) => url.slice('/content/'.length));
const origin = 'https://static.example.invalid';
function remoteManifest() {
  return {
    origin,
    files: paths.map((path, index) => {
      const sha256 = index.toString(16).padStart(64, '0');
      const key = path.startsWith('basis/') ? `content/${path}` : `content/${sha256}.${path.split('.').pop()}`;
      return { path, sha256, bytes: index + 1, key, url: `${origin}/${key}` };
    }),
  };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('content transport contract', () => {
  it('keeps the full default request list byte-identical and covers every shipped content file', () => {
    expect(walkContentFiles('public/content')).toEqual([...paths].sort());
    expect(paths.map((path) => contentUrl('/content', path))).toEqual(defaultRequests);
    expect(paths.map((path) => createContentResolver().resolve(path))).toEqual(defaultRequests);
    const local = createContentResolver('', { files: [] });
    expect(local.join('/content/half/', '/looks/wallis-dress.glb')).toBe('/content/half/looks/wallis-dress.glb');
  });

  it('resolves every remote request from the manifest and preserves the Basis directory contract', () => {
    const manifest = remoteManifest();
    const remote = createContentResolver(origin + '/', manifest);
    expect(paths.map((path) => remote.resolve(path))).toEqual(manifest.files.map((entry) => entry.url));
    expect(paths.map((path) => remote.join('/content/', '/' + path)))
      .toEqual(manifest.files.map((entry) => entry.url));
    expect(remote.join('/content', 'basis/')).toBe(`${origin}/content/basis/`);
    for (const name of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
      expect(remote.join('/content', 'basis/') + name).toBe(remote.resolve('basis/' + name));
    }
  });

  it('fails loudly on a missing manifest entry at load and during configuration', () => {
    const manifest = remoteManifest();
    manifest.files = manifest.files.filter((entry) => entry.path !== 'half/catalog.json');
    const remote = createContentResolver(origin, manifest);
    expect(() => remote.resolve('half/catalog.json')).toThrow('manifest missing half/catalog.json');
    expect(() => contentBuildSettings(origin, manifest, paths)).toThrow('manifest missing half/catalog.json');
  });

  it('requires both fixed Basis entries before any remote load', () => {
    const manifest = remoteManifest();
    manifest.files = manifest.files.filter((entry) => !entry.path.endsWith('.wasm'));
    expect(() => createContentResolver(origin, manifest)).toThrow('manifest missing basis/basis_transcoder.wasm');
  });

  it('rejects malformed, duplicate, mismatched or unhashed remote addresses', () => {
    const manifest = remoteManifest();
    const first = manifest.files[0];
    for (const replacement of [
      { ...first, url: 'https://other.example.invalid/content/catalog.json' },
      { ...first, key: 'content/catalog.json' }, { ...first, sha256: 'bad' },
      { ...first, bytes: -1 }, { ...first, path: '../catalog.json' },
    ]) {
      expect(() => createContentResolver(origin, { ...manifest, files: [replacement, ...manifest.files.slice(1)] }))
        .toThrow();
    }
    expect(() => createContentResolver(origin, { ...manifest, files: [...manifest.files, first] })).toThrow();
    expect(() => createContentResolver(origin, { ...manifest, origin: 'https://other.example.invalid' })).toThrow();
    expect(() => createContentResolver(origin)).toThrow();
    for (const path of ['../bad.glb', '/bad.glb', 'looks//bad.glb', 'looks/bad.glb?x=1']) {
      expect(() => createContentResolver().resolve(path)).toThrow('invalid logical path');
    }
  });

  it('widens only connect-src and img-src for exactly the configured origin', () => {
    expect(contentSecurityPolicy()).toBe(CONTENT_SECURITY_POLICY);
    const remote = contentSecurityPolicy(origin).split('; ');
    expect(remote.filter((directive) => directive.includes(origin))).toEqual([
      `img-src 'self' ${origin}`, `connect-src 'self' blob: ${origin}`,
    ]);
    expect(remote.filter((directive) => !directive.includes(origin)))
      .toEqual(CONTENT_SECURITY_POLICY.split('; ').filter((directive) =>
        !directive.startsWith('img-src ') && !directive.startsWith('connect-src ')));
    for (const bad of ['https://static.example.invalid/path', 'https://user:pass@static.example.invalid',
      'https://static.example.invalid?x=1', 'data:text/plain,policy', "https://static.example.invalid 'unsafe-inline'"]) {
      expect(() => contentSecurityPolicy(bad)).toThrow();
    }
  });

  it('injects one validated manifest and a matching policy, with local-only defaults', () => {
    vi.stubEnv('VITE_CONTENT_ORIGIN', '');
    vi.stubEnv('VITE_CONTENT_MANIFEST', 'does-not-exist.json');
    const [contentBuildPlugin, productionCspPlugin] = createShowroomConfig().plugins;
    expect(contentBuildPlugin.config()).toEqual({ define: {
      __CONTENT_ORIGIN__: '""', __CONTENT_MANIFEST__: 'null',
    } });
    const manifest = remoteManifest();
    const settings = contentBuildSettings(origin, manifest, paths);
    expect(JSON.parse(settings.define.__CONTENT_ORIGIN__)).toBe(origin);
    expect(JSON.parse(settings.define.__CONTENT_MANIFEST__)).toEqual(manifest);
    expect(settings.policy).toBe(contentSecurityPolicy(origin));
    vi.stubEnv('VITE_CONTENT_ORIGIN', origin);
    const directory = mkdtempSync(join(tmpdir(), 'content-config-'));
    const file = join(directory, 'manifest.json');
    writeFileSync(file, JSON.stringify(manifest));
    try {
      vi.stubEnv('VITE_CONTENT_MANIFEST', file);
      const [remoteContentPlugin, remoteCspPlugin] = createShowroomConfig().plugins;
      expect(remoteContentPlugin.config()).toEqual({ define: settings.define });
      expect(remoteCspPlugin.transformIndexHtml.handler()[0].attrs.content).toBe(settings.policy);
    } finally {
      unlinkSync(file);
      rmdirSync(directory);
    }
    vi.stubEnv('VITE_CONTENT_MANIFEST', '');
    expect(() => createShowroomConfig()).toThrow('VITE_CONTENT_MANIFEST is required');
    vi.stubEnv('VITE_CONTENT_ORIGIN', '');
    createShowroomConfig().plugins[0].config();
    expect(productionCspPlugin.transformIndexHtml.handler()[0].attrs.content).toBe(CONTENT_SECURITY_POLICY);
  });

  it('isolates remote and local configurations across interleaved hooks in one process', () => {
    const manifest = remoteManifest();
    const directory = mkdtempSync(join(tmpdir(), 'content-config-isolation-'));
    const file = join(directory, 'manifest.json');
    writeFileSync(file, JSON.stringify(manifest));
    try {
      vi.stubEnv('VITE_CONTENT_ORIGIN', origin);
      vi.stubEnv('VITE_CONTENT_MANIFEST', file);
      // Vite widens the callback's return type; this callback returns the factory's plugin tuple.
      const remote = configure({ command: 'build', mode: 'production' }) as ReturnType<typeof createShowroomConfig>;
      const [remoteContent, remoteCsp] = remote.plugins;
      const remoteSettings = contentBuildSettings(origin, manifest, paths);
      vi.stubEnv('VITE_CONTENT_ORIGIN', '');
      vi.stubEnv('VITE_CONTENT_MANIFEST', 'does-not-exist.json');
      const local = configure({ command: 'build', mode: 'production' }) as ReturnType<typeof createShowroomConfig>;
      const [localContent, localCsp] = local.plugins;
      expect(remoteContent.config()).toEqual({ define: remoteSettings.define });
      // The local document hook runs before its own content hook, after the other build's hook.
      expect(localCsp.transformIndexHtml.handler()[0].attrs.content).toBe(CONTENT_SECURITY_POLICY);
      expect(remoteCsp.transformIndexHtml.handler()[0].attrs.content).toBe(remoteSettings.policy);
      expect(localContent.config()).toEqual({ define: {
        __CONTENT_ORIGIN__: '""', __CONTENT_MANIFEST__: 'null',
      } });
      expect(remoteCsp.transformIndexHtml.handler()[0].attrs.content).toBe(remoteSettings.policy);
      expect(remoteContent.config()).toEqual({ define: remoteSettings.define });
      expect(localCsp.transformIndexHtml.handler()[0].attrs.content).not.toContain(origin);
    } finally {
      unlinkSync(file);
      rmdirSync(directory);
    }
  });

  it('creates the default local document policy without a content hook or manifest read', () => {
    vi.stubEnv('VITE_CONTENT_ORIGIN', '');
    vi.stubEnv('VITE_CONTENT_MANIFEST', 'does-not-exist.json');
    const config = configure({ command: 'build', mode: 'production' }) as ReturnType<typeof createShowroomConfig>;
    const [content, csp] = config.plugins;
    expect(csp.transformIndexHtml.handler()[0].attrs.content).toBe(CONTENT_SECURITY_POLICY);
    expect(content.config()).toEqual({ define: {
      __CONTENT_ORIGIN__: '""', __CONTENT_MANIFEST__: 'null',
    } });
  });

  it('uses the configured resolver in the live catalogue join and transcoder loader', async () => {
    const manifest = remoteManifest();
    vi.stubGlobal('__CONTENT_ORIGIN__', origin);
    vi.stubGlobal('__CONTENT_MANIFEST__', manifest);
    vi.resetModules();
    const catalog = await import('../../src/catalog/catalog');
    const loaders = await import('../../src/scene/loaders');
    const request = vi.fn<typeof fetch>(async () => new Response(readFileSync('public/content/catalog.json')));
    await catalog.loadCatalog(catalog.contentUrl('/content', 'catalog.json'), request);
    expect(request).toHaveBeenCalledWith(manifest.files[0].url);
    expect(loaders.transcoderPath('/content/half')).toBe(`${origin}/content/basis/`);
    const { createShowroomConfig, omitEmittedBasisTranscoderPlugin } = await import('../../vite.config');
    const config = createShowroomConfig({});
    const [contentBuildPlugin] = config.plugins;
    expect(config.plugins).toContain(contentBuildPlugin);
    expect(config.plugins).toContain(omitEmittedBasisTranscoderPlugin);
    const chunk = { type: 'chunk', fileName: 'scene.js', code: JSON.stringify(loaders.transcoderPath('/content')) };
    const bundle: Record<string, unknown> = { 'scene.js': chunk };
    for (const entry of manifest.files.filter((entry) => entry.path.startsWith('basis/'))) {
      const name = entry.path.slice('basis/'.length);
      bundle[name] = { type: 'asset', fileName: name, originalFileNames: [entry.path] };
    }
    omitEmittedBasisTranscoderPlugin.generateBundle({}, bundle);
    expect(bundle).toEqual({ 'scene.js': chunk });
  });

  it('does not catch a missing remote half catalogue and fall back to the full set', async () => {
    const manifest = remoteManifest();
    manifest.files = manifest.files.filter((entry) => entry.path !== 'half/catalog.json');
    vi.stubGlobal('__CONTENT_ORIGIN__', origin);
    vi.stubGlobal('__CONTENT_MANIFEST__', manifest);
    const request = vi.fn<typeof fetch>(async () => new Response(readFileSync('public/content/catalog.json')));
    vi.stubGlobal('fetch', request);
    vi.resetModules();
    const { loadContentSet } = await import('../../src/catalog/bootstrap');
    await expect(loadContentSet(true)).rejects.toThrow('manifest missing half/catalog.json');
    expect(request).not.toHaveBeenCalled();
  });
});
