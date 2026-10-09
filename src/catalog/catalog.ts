// catalog.json, the one document that says what the page loads. The shape is fixed in
// the catalogue data contract, so parsing is strict: a field that is missing, empty or of the wrong
// type throws with the field's path. A silently dropped look is a blank plinth with nothing on
// screen to explain it, which is far more expensive to diagnose than a thrown error at boot.

/** One look: a garment baked together with its mannequin, plus the text and media that describe it. */
export interface CatalogLook {
  id: string;
  name: string;
  description: string;
  thumbnail: string | null;
  file: string;
  variants: string[];
  defaultVariant: string;
  mannequinNode: string;
}

/** A named camera pose in metres; `fov` is vertical degrees, the three.js convention. */
export interface CatalogView {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface Catalog {
  version: number;
  environment: { file: string };
  rotunda: { file: string };
  plinth: { file: string };
  looks: CatalogLook[];
  views: Record<string, CatalogView>;
}

/** The only document version this loader understands. A different number means a different shape. */
export const CATALOG_VERSION = 1;

/** The inspection camera's default pose, and the pose every proof number is measured at. */
export const PROOF_VIEW = 'proof';

function fail(field: string, why: string): never {
  throw new Error(`catalog: ${field} ${why}`);
}

/**
 * Turns an unknown value into a field map. Object.entries is what makes this work without a type
 * assertion: narrowing `unknown` with typeof leaves `object`, which has no index signature, so a
 * plain property read would not compile.
 */
function readFields(value: unknown, path: string): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'is not an object');
  }
  return new Map<string, unknown>(Object.entries(value));
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(path, 'is not a non-empty string');
  }
  return value;
}

/** A media reference the export may legitimately lack. Absent is an error; null is the way to say it. */
function readNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return readString(value, path);
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'is not a finite number');
  }
  return value;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, 'is not an array');
  }
  return value;
}

function readVector3(value: unknown, path: string): [number, number, number] {
  const items = readArray(value, path);
  if (items.length !== 3) {
    fail(path, `has ${items.length} numbers, not 3`);
  }
  return [
    readNumber(items[0], `${path}[0]`),
    readNumber(items[1], `${path}[1]`),
    readNumber(items[2], `${path}[2]`),
  ];
}

function readLook(value: unknown, path: string): CatalogLook {
  const look = readFields(value, path);
  const variantItems = readArray(look.get('variants'), `${path}.variants`);
  if (variantItems.length === 0) {
    fail(`${path}.variants`, 'is empty');
  }
  const variants = variantItems.map((item, index) => readString(item, `${path}.variants[${index}]`));
  const defaultVariant = readString(look.get('defaultVariant'), `${path}.defaultVariant`);
  if (!variants.includes(defaultVariant)) {
    fail(`${path}.defaultVariant`, `is "${defaultVariant}", which is not one of the variants`);
  }
  return {
    id: readString(look.get('id'), `${path}.id`),
    name: readString(look.get('name'), `${path}.name`),
    description: readString(look.get('description'), `${path}.description`),
    thumbnail: readNullableString(look.get('thumbnail'), `${path}.thumbnail`),
    file: readString(look.get('file'), `${path}.file`),
    variants,
    defaultVariant,
    mannequinNode: readString(look.get('mannequinNode'), `${path}.mannequinNode`),
  };
}

function readView(value: unknown, path: string): CatalogView {
  const view = readFields(value, path);
  return {
    position: readVector3(view.get('position'), `${path}.position`),
    target: readVector3(view.get('target'), `${path}.target`),
    fov: readNumber(view.get('fov'), `${path}.fov`),
  };
}

/**
 * Validates the parsed JSON and returns it in the project's own types. Unknown extra fields are
 * ignored on purpose: the optimize pipeline may add keys the page does not read yet, and a new key
 * must never stop the page from loading.
 */
export function parseCatalog(json: unknown): Catalog {
  const root = readFields(json, 'catalog');
  const version = readNumber(root.get('version'), 'version');
  if (version !== CATALOG_VERSION) {
    fail('version', `is ${version}, and this loader reads version ${CATALOG_VERSION}`);
  }

  const rotundaFile = readString(readFields(root.get('rotunda'), 'rotunda').get('file'), 'rotunda.file');
  const plinthFile = readString(readFields(root.get('plinth'), 'plinth').get('file'), 'plinth.file');
  const environmentFile = readString(
    readFields(root.get('environment'), 'environment').get('file'),
    'environment.file',
  );

  const lookItems = readArray(root.get('looks'), 'looks');
  if (lookItems.length === 0) {
    fail('looks', 'is empty');
  }
  const looks = lookItems.map((item, index) => readLook(item, `looks[${index}]`));
  const seen = new Set<string>();
  for (const look of looks) {
    if (seen.has(look.id)) {
      fail('looks', `lists the id "${look.id}" twice`);
    }
    seen.add(look.id);
  }

  const viewFields = readFields(root.get('views'), 'views');
  if (!viewFields.has(PROOF_VIEW)) {
    fail(`views.${PROOF_VIEW}`, 'is missing, and it is the camera the page starts at');
  }
  const views: Record<string, CatalogView> = {};
  for (const [name, value] of viewFields) {
    views[name] = readView(value, `views.${name}`);
  }

  return {
    version,
    environment: { file: environmentFile },
    rotunda: { file: rotundaFile },
    plinth: { file: plinthFile },
    looks,
    views,
  };
}

/**
 * Joins a content base ('/content' or '/content/half') to a file path from the catalogue without
 * ever producing a double slash, which Vite's preview server answers with a redirect.
 */
export function contentUrl(base: string, file: string): string {
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  const right = file.startsWith('/') ? file.slice(1) : file;
  return `${left}/${right}`;
}

/**
 * Fetches and validates catalog.json. `fetchFn` exists for the unit tests; in the page the global
 * fetch is used, bound to globalThis because a detached reference throws in Chrome.
 */
export async function loadCatalog(url: string, fetchFn?: typeof fetch): Promise<Catalog> {
  const request = fetchFn ?? globalThis.fetch.bind(globalThis);
  const response = await request(url);
  if (!response.ok) {
    throw new Error(`catalog: ${url} answered ${response.status}`);
  }
  const json: unknown = await response.json();
  return parseCatalog(json);
}
