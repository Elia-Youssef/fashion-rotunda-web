import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentSecurityPolicy } from './src/content-security-policy';
import { createContentResolver } from './src/content/resolver';
import { walkContentFiles } from './pipeline/r2/lib/objects.mjs';

/** Validates the manifest before emitting both the URL map and the matching document policy. */
export function contentBuildSettings(origin: string, manifest?: unknown, paths: string[] = []) {
  const resolver = createContentResolver(origin, manifest);
  for (const path of paths) resolver.resolve(path);
  return {
    define: {
      __CONTENT_ORIGIN__: JSON.stringify(resolver.origin),
      __CONTENT_MANIFEST__: JSON.stringify(resolver.origin === '' ? null : manifest),
    },
    policy: contentSecurityPolicy(resolver.origin),
  };
}

/** Each configuration owns one validated snapshot, independent of hook order and later builds. */
export function createShowroomConfig(environment: Readonly<Record<string, string | undefined>> = process.env) {
  // Explicit process environment only; configuration never opens credential or dotenv files.
  const origin = environment['VITE_CONTENT_ORIGIN'] ?? '';
  const manifestFile = environment['VITE_CONTENT_MANIFEST'];
  let manifest: unknown;
  let paths: string[] = [];
  if (origin.trim() !== '') {
    if (!manifestFile) throw new Error('content: VITE_CONTENT_MANIFEST is required with VITE_CONTENT_ORIGIN');
    manifest = JSON.parse(readFileSync(resolve(manifestFile), 'utf8')) as unknown;
    paths = walkContentFiles(resolve('public/content'));
  }
  const settings = contentBuildSettings(origin, manifest, paths);
  const contentBuildPlugin = {
    name: 'content-manifest',
    config() {
      return { define: settings.define };
    },
  } satisfies Plugin;
  const productionCspPlugin = {
    name: 'production-content-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [{
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: settings.policy,
          },
          // Enforce the policy before Vite's scripts, preloads and stylesheets are encountered.
          injectTo: 'head-prepend',
        }];
      },
    },
  } satisfies Plugin;
  return {
    plugins: [
      contentBuildPlugin, productionCspPlugin, omitEmittedBasisTranscoderPlugin,
    ] satisfies [Plugin, Plugin, Plugin],
    // A phone on the same network can open the server. WebGPU requires a secure context,
    // so a LAN address over plain HTTP falls back to WebGL 2 by design.
    server: { host: true },
  };
}

// The two Basis Universal file names the page serves from public/content/basis/ and points
// KTX2Loader at (src/scene/loaders.ts). A copy of either name inside the bundle output is always
// the bundler's emission of three's own fallback references, never a file the page requests.
const TRANSCODER_BASENAMES = ['basis_transcoder.js', 'basis_transcoder.wasm'] as const;

/**
 * The emitted asset fields the guard reads, declared structurally because the bundler exposes no
 * stable asset type. vite 8 emits through rolldown, whose output assets carry fileName, name,
 * names and originalFileNames, where name and originalFileNames name the source file an emission
 * came from (transformToMutableRollupOutputAsset in rolldown's bindingify-input-options chunk).
 */
interface EmittedAssetFields {
  readonly fileName: string;
  readonly name?: unknown;
  readonly names?: unknown;
  readonly originalFileNames?: unknown;
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function declaredSourceNames(entry: EmittedAssetFields): string[] {
  const declared: string[] = [];
  for (const field of [entry.name, entry.names, entry.originalFileNames]) {
    if (typeof field === 'string') {
      declared.push(field);
    } else if (Array.isArray(field)) {
      for (const value of field) {
        if (typeof value === 'string') declared.push(value);
      }
    }
  }
  return declared.map(basename);
}

function isEmittedTranscoderCopy(entry: EmittedAssetFields): boolean {
  const basenames: readonly string[] = TRANSCODER_BASENAMES;
  if (declaredSourceNames(entry).some((value) => basenames.includes(value))) {
    return true;
  }
  // The bundler's own output name, basis_transcoder-<hash>.<ext>, read back when an asset shape
  // stops declaring the source names above.
  return basenames.includes(basename(entry.fileName))
    || /^basis_transcoder-[A-Za-z0-9_-]+\.(?:js|wasm)$/.test(basename(entry.fileName));
}

/**
 * three's KTX2Loader keeps module-level new URL fallbacks for the transcoder pair
 * (examples/jsm/loaders/KTX2Loader.js lines 106-107), and the bundler statically resolves every
 * new URL(..., import.meta.url) into a hashed asset. The page always points KTX2Loader at the
 * served pair under /content/basis/ instead (src/scene/loaders.ts), so the fallback branch that
 * reads those constants never runs and the emitted pair is dead weight in dist/assets. This
 * drops exactly those copies; the served files under public/content/basis/ are copied verbatim
 * and never enter the bundle, so what the page loads is unchanged.
 */
export const omitEmittedBasisTranscoderPlugin = {
  name: 'omit-emitted-basis-transcoder',
  apply: 'build',
  generateBundle(_options: unknown, bundle: Record<string, unknown>): void {
    for (const fileName of Object.keys(bundle)) {
      const entry: unknown = bundle[fileName];
      if (typeof entry !== 'object' || entry === null) continue;
      const asset = entry as EmittedAssetFields & { type?: unknown };
      if (asset.type !== 'asset') continue;
      if (isEmittedTranscoderCopy(asset)) {
        delete bundle[fileName];
      }
    }
  },
} satisfies Plugin;

export default defineConfig(() => createShowroomConfig());
