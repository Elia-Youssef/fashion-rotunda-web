import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// The three publishing bridges the composition root imports from src/proof/publishers.ts, executed here
// without importing the page's renderer and boot side effects, the way the governor publication
// test does. The features and memory publishers must keep their published strings byte-identical
// while touching the dataset only when a published value changes; the timestamp bridge must keep
// at most one resolve in flight without ever delaying the frame that asks for it.

const source = ts.createSourceFile('publishers.ts', readFileSync('src/proof/publishers.ts', 'utf8'), ts.ScriptTarget.Latest, true);

function evaluate<T>(name: string): T {
  const found = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (found === undefined) throw new Error(`missing ${name} in src/proof/publishers.ts`);
  const compiled = ts.transpileModule(found.getText(source).replace('export ', ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(`${compiled}\nreturn ${name};`)() as T;
}

const createPostStatePublisher = evaluate<
  (
    dataset: DOMStringMap,
    publishGovernor: (diagnostics: unknown) => void,
  ) => (features: unknown, diagnostics: unknown) => void
>('createPostStatePublisher');
const createMemoryPublisher = evaluate<
  (dataset: DOMStringMap) => (geometries: number, textures: number) => void
>('createMemoryPublisher');
const createTimestampResolveBridge = evaluate<
  (resolve: () => Promise<unknown>, onError: (error: unknown) => void) => () => void
>('createTimestampResolveBridge');

/** A dataset that records every key read and write, so a test can prove a publisher stayed silent. */
function recordingDataset() {
  const reads = new Set<string>();
  const current = new Map<string, string>();
  const writeLog: string[] = [];
  const dataset = new Proxy({} as DOMStringMap, {
    get(_target, key) {
      if (typeof key === 'string') reads.add(key);
      return current.get(key as string);
    },
    set(_target, key, value: string) {
      writeLog.push(value);
      current.set(key as string, value);
      return true;
    },
  });
  return { dataset, reads, current, writeLog };
}

interface Features {
  ao: boolean;
  traa: boolean;
  msaa: boolean;
  ssgi: 'off' | 'half' | 'full';
  ssr: boolean;
  bloom: boolean;
  lut: boolean;
  vignette: boolean;
  dof: 'off' | 'ready' | 'on';
}

function features(partial: Partial<Features>): Features {
  return {
    ao: false,
    traa: false,
    msaa: false,
    ssgi: 'off',
    ssr: false,
    bloom: false,
    lut: false,
    vignette: false,
    dof: 'off',
    ...partial,
  };
}

describe('createPostStatePublisher', () => {
  it('formats the fixed feature order byte-identically, with off for null and for nothing on', () => {
    const { dataset } = recordingDataset();
    const publish = createPostStatePublisher(dataset, () => {});

    publish(null, null);
    expect(dataset.post).toBe('off');

    publish(features({}), null);
    expect(dataset.post).toBe('off');

    publish(
      features({ ao: true, traa: true, msaa: true, ssgi: 'half', ssr: true, bloom: true, lut: true, vignette: true, dof: 'on' }),
      null,
    );
    expect(dataset.post).toBe('ao,traa,msaa,ssgi-half,ssr,bloom,lut,vignette,dof');

    publish(features({ traa: true, ssgi: 'full', ssr: true, bloom: true, lut: true, vignette: true, dof: 'ready' }), null);
    expect(dataset.post).toBe('traa,ssgi,ssr,bloom,lut,vignette');

    publish(features({ ao: true, msaa: true, lut: true, vignette: true }), null);
    expect(dataset.post).toBe('ao,msaa,lut,vignette');
  });

  it('formats only when the features record is new and forwards the governor record every call', () => {
    const { dataset, reads, current } = recordingDataset();
    const publishGovernor = vi.fn<(diagnostics: unknown) => void>();
    const publish = createPostStatePublisher(dataset, publishGovernor);
    const first = features({ traa: true, lut: true, vignette: true });

    publish(first, 'diag-1');
    expect(dataset.post).toBe('traa,lut,vignette');
    expect(publishGovernor).toHaveBeenCalledTimes(1);
    expect(publishGovernor).toHaveBeenLastCalledWith('diag-1');

    // The same record: no dataset access at all, the governor record still rides.
    reads.clear();
    publish(first, 'diag-2');
    expect(publishGovernor).toHaveBeenCalledTimes(2);
    expect(publishGovernor).toHaveBeenLastCalledWith('diag-2');
    expect(reads.size).toBe(0);
    expect(current.get('post')).toBe('traa,lut,vignette');

    // A new record with equal content reformats, but the attribute guard keeps the DOM quiet.
    const equalCopy = features({ traa: true, lut: true, vignette: true });
    publish(equalCopy, 'diag-3');
    expect(publishGovernor).toHaveBeenCalledTimes(3);
    expect(current.get('post')).toBe('traa,lut,vignette');

    publish(features({ traa: true, ssr: true, lut: true, vignette: true, dof: 'on' }), 'diag-4');
    expect(current.get('post')).toBe('traa,ssr,lut,vignette,dof');
  });

  it('gives two publishers their own published record', () => {
    // One dataset per publisher: the attribute guard reads the dataset it is given, so one
    // shared attribute would mask the second formatting pass behind a suppressed write and
    // the readout would look the same either way. The write logs are the witness: the second
    // publisher's first call writes even though the first already published the same string,
    // which one shared last-formatted record would skip without a write of its own.
    const firstDataset = recordingDataset();
    const secondDataset = recordingDataset();
    const record = features({ lut: true, vignette: true });
    const first = createPostStatePublisher(firstDataset.dataset, () => {});
    const second = createPostStatePublisher(secondDataset.dataset, () => {});

    first(record, null);
    expect(firstDataset.writeLog).toEqual(['lut,vignette']);
    second(record, null);
    expect(secondDataset.writeLog).toEqual(['lut,vignette']);
  });
});

describe('createMemoryPublisher', () => {
  it('writes geometries/textures on the first call and on every count change', () => {
    const { dataset, writeLog } = recordingDataset();
    const publish = createMemoryPublisher(dataset);

    publish(3, 7);
    expect(dataset.memory).toBe('3/7');
    publish(4, 7);
    expect(dataset.memory).toBe('4/7');
    publish(4, 9);
    expect(dataset.memory).toBe('4/9');
    // Back to an earlier pair: still a change against the last seen counts.
    publish(3, 7);
    expect(dataset.memory).toBe('3/7');
    expect(writeLog).toEqual(['3/7', '4/7', '4/9', '3/7']);
  });

  it('touches the dataset neither to read nor to write while both counts stand still', () => {
    const { dataset, reads, current } = recordingDataset();
    const publish = createMemoryPublisher(dataset);

    publish(3, 7);
    reads.clear();
    for (let frame = 0; frame < 100; frame += 1) {
      publish(3, 7);
    }
    expect(reads.size).toBe(0);
    expect(current.get('memory')).toBe('3/7');
  });

  it('gives two publishers their own last-seen counts', () => {
    const { dataset, writeLog } = recordingDataset();
    const first = createMemoryPublisher(dataset);
    const second = createMemoryPublisher(dataset);

    first(3, 7);
    second(3, 7);
    expect(writeLog).toEqual(['3/7', '3/7']);
  });
});

describe('createTimestampResolveBridge', () => {
  function deferred(): { promise: Promise<number>; settle: (ms: number) => void; reject: (error: unknown) => void } {
    let settle!: (ms: number) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<number>((res, rej) => {
      settle = res;
      reject = rej;
    });
    return { promise, settle, reject };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('issues one resolve while one is in flight and the next one after it settles', async () => {
    const first = deferred();
    let calls = 0;
    const given: unknown[] = [];
    const bridge = createTimestampResolveBridge(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve(calls);
    }, (error) => given.push(error));

    bridge();
    bridge();
    bridge();
    expect(calls).toBe(1);

    first.settle(4.2);
    await tick();
    bridge();
    expect(calls).toBe(2);
    expect(given).toEqual([]);
  });

  it('re-arms after a rejection, reports the error once and keeps issuing afterwards', async () => {
    const failing = deferred();
    let calls = 0;
    const errors: unknown[] = [];
    const bridge = createTimestampResolveBridge(() => {
      calls += 1;
      return calls === 1 ? failing.promise : Promise.resolve(calls);
    }, (error) => errors.push(error));

    bridge();
    failing.reject(new Error('resolve failed'));
    await tick();
    expect(errors).toHaveLength(1);

    bridge();
    bridge();
    expect(calls).toBe(2);
    await tick();
    expect(errors).toHaveLength(1);
  });

  it('returns without awaiting the resolve, so a frame never stalls on the GPU', () => {
    const pending = deferred();
    const bridge = createTimestampResolveBridge(() => pending.promise, () => {});
    let returned = false;
    const step = (): void => {
      bridge();
      returned = true;
    };
    step();
    expect(returned).toBe(true);
  });
});
