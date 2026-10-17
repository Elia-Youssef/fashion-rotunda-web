// Logical content paths stay independent of the transport and its object layout.
const LOCAL_CONTENT_BASE = '/content';
const BASIS_DIRECTORY = 'basis/';
const BASIS_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'];
// SHA-256 encodes 256 bits as 64 hexadecimal characters.
const SHA256_HEX = /^[a-f0-9]{64}$/;

declare const __CONTENT_ORIGIN__: string;
declare const __CONTENT_MANIFEST__: unknown;

export function contentOrigin(value: string): string {
  if (value.trim() === '') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== trimmed) {
    throw new Error('content: configured origin must be an HTTP(S) origin without a path or credentials');
  }
  return url.origin;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function logicalPath(path: string): void {
  if (path === '' || path.startsWith('/') || path.includes('\\') ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      /[?#%:\s]/.test(path)) {
    throw new Error(`content: invalid logical path ${path}`);
  }
}

export interface ContentResolver {
  readonly origin: string;
  resolve(path: string): string;
  join(base: string, file: string): string;
}

/** No manifest lookup or additional request occurs in the default local mode. */
export function createContentResolver(originValue = '', manifest?: unknown): ContentResolver {
  const origin = contentOrigin(originValue);
  const urls = new Map<string, string>();
  if (origin !== '') {
    if (!record(manifest) || contentOrigin(String(manifest['origin'])) !== origin ||
        !Array.isArray(manifest['files'])) {
      throw new Error('content: a manifest matching the configured origin is required');
    }
    for (const entry of manifest['files']) {
      if (!record(entry) || typeof entry['path'] !== 'string' || typeof entry['url'] !== 'string' ||
          typeof entry['key'] !== 'string' || typeof entry['sha256'] !== 'string' ||
          !SHA256_HEX.test(entry['sha256']) || typeof entry['bytes'] !== 'number' ||
          !Number.isSafeInteger(entry['bytes']) || entry['bytes'] < 0) {
        throw new Error('content: invalid manifest entry');
      }
      const path = entry['path'];
      logicalPath(path);
      const fixed = BASIS_FILES.some((name) => path === `${BASIS_DIRECTORY}${name}`);
      const extension = path.split('.').pop()?.toLowerCase();
      const key = fixed ? `content/${path}` : `content/${entry['sha256']}.${extension}`;
      if (entry['key'] !== key || entry['url'] !== `${origin}/${key}` || urls.has(path)) {
        throw new Error(`content: invalid or duplicate manifest address for ${path}`);
      }
      urls.set(path, entry['url']);
    }
    for (const name of BASIS_FILES) {
      if (!urls.has(`${BASIS_DIRECTORY}${name}`)) {
        throw new Error(`content: manifest missing ${BASIS_DIRECTORY}${name}`);
      }
    }
  }
  function resolve(path: string): string {
    if (path === BASIS_DIRECTORY) {
      // KTX2Loader appends the fixed filenames, so the pair shares one fixed directory.
      return origin === '' ? `${LOCAL_CONTENT_BASE}/${path}` : `${origin}/content/${path}`;
    }
    logicalPath(path);
    if (origin === '') return `${LOCAL_CONTENT_BASE}/${path}`;
    const url = urls.get(path);
    if (url === undefined) throw new Error(`content: manifest missing ${path}`);
    return url;
  }
  return {
    origin,
    resolve,
    join(base, file) {
      const left = base.endsWith('/') ? base.slice(0, -1) : base;
      const right = file.startsWith('/') ? file.slice(1) : file;
      const joined = `${left}/${right}`;
      // Preserve the existing join contract in local mode.
      if (origin === '') return joined;
      if (!joined.startsWith(`${LOCAL_CONTENT_BASE}/`)) {
        throw new Error(`content: unsupported logical base ${base}`);
      }
      return resolve(joined.slice(LOCAL_CONTENT_BASE.length + 1));
    },
  };
}

export const contentResolver = createContentResolver(
  typeof __CONTENT_ORIGIN__ === 'undefined' ? '' : __CONTENT_ORIGIN__,
  typeof __CONTENT_MANIFEST__ === 'undefined' ? undefined : __CONTENT_MANIFEST__,
);
