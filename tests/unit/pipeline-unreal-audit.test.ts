import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep fixture setup and cleanup on the original APIs, outside the audit's intercepted imports.
const temporaryDirectories: string[] = [];
const originalArgv = process.argv;
const mockedModules = [
  'node:fs', 'fs', 'node:fs/promises', 'fs/promises', 'node:child_process', 'child_process',
  '../../pipeline/config.mjs',
];

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  for (const id of mockedModules) vi.doUnmock(id);
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function isChild(parent: string, candidate: string) {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function fixture(present: boolean) {
  const root = fs.mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-audit-'));
  temporaryDirectories.push(root);
  const sourceDir = resolve(root, 'assets-src', 'source');
  const contentDir = resolve(root, 'public', 'content');
  const unrealProject = resolve(root, 'project', 'FashionRotunda.uproject');
  const unrealEditorCmd = resolve(root, 'editor', 'UnrealEditor-Cmd.exe');
  const files: [string, string][] = [
    [resolve(sourceDir, 'unreal', 'mesh.txt'), 'known-good export'],
    [resolve(sourceDir, 'environment', 'sky.txt'), 'known-good environment'],
    [resolve(contentDir, 'catalog.json'), '{"looks":[]}'],
    [resolve(root, 'pipeline', 'unreal', 'export.py'), '# fixture only'],
    ...(present ? [[unrealProject, '{}'], [unrealEditorCmd, 'not an executable']] as [string, string][] : []),
  ];
  for (const [path, contents] of files) {
    fs.mkdirSync(resolve(path, '..'), { recursive: true });
    fs.writeFileSync(path, contents, 'utf8');
  }
  const provenanceDir = resolve(root, 'custom-audit-output');
  return { root, sourceDir, contentDir, unrealProject, unrealEditorCmd, provenanceDir };
}

// Include callback, sync, promise, stream and descriptor-based mutation entry points. Opening a
// descriptor is blocked too, so a writable FileHandle cannot escape the promise interception.
const mutationNames = new Set([
  'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'createWriteStream', 'fchmod', 'fchown',
  'ftruncate', 'futimes', 'lchmod', 'lchown', 'link', 'lutimes', 'mkdir', 'mkdtemp',
  'mkdtempDisposable', 'open', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink',
  'utimes', 'write', 'writeFile', 'writev', 'WriteStream',
]);

async function audit(args: string[], present: boolean) {
  const paths = fixture(present);
  const processAttempts: string[] = [];
  const forbiddenWrites: string[] = [];
  const allowedWrites: { method: string; path: string }[] = [];
  let evidenceRoot = '';
  let runDirectory = '';

  const deny = (attempts: string[], message: string) => {
    attempts.push(message);
    throw new Error(message);
  };
  const guardedProcesses = Object.fromEntries(Object.entries(childProcess).map(([name, value]) => [
    name,
    typeof value === 'function'
      ? vi.fn(function () { return deny(processAttempts, `audit attempted child_process.${name}`); })
      : value,
  ]));
  function guardedFileSystem(api: object, promises: boolean) {
    const guarded: Record<string, unknown> = { ...api };
    for (const [name, value] of Object.entries(api)) {
      if (typeof value !== 'function' || !mutationNames.has(name.replace(/Sync$/, ''))) continue;
      guarded[name] = vi.fn(function (...parameters: unknown[]) {
        // These are the audit's only permitted mutations. All other entry points fail before I/O.
        const path = typeof parameters[0] === 'string' ? resolve(parameters[0]) : '';
        if (!promises && name === 'mkdirSync' && path === evidenceRoot) {
          allowedWrites.push({ method: name, path });
          return fs.mkdirSync(path, parameters[1] as fs.MakeDirectoryOptions);
        }
        if (!promises && name === 'mkdirSync' && isChild(evidenceRoot, path)
          && relative(evidenceRoot, path).split(sep).length === 1 && runDirectory === '') {
          runDirectory = path;
          allowedWrites.push({ method: name, path });
          return fs.mkdirSync(path);
        }
        if (!promises && name === 'writeFileSync' && runDirectory !== '' && isChild(runDirectory, path)) {
          allowedWrites.push({ method: name, path });
          return fs.writeFileSync(path, parameters[1] as string, parameters[2] as BufferEncoding);
        }
        return deny(forbiddenWrites, `audit attempted fs${promises ? '.promises' : ''}.${name}: ${path}`);
      });
    }
    return guarded;
  }
  const guardedPromises = guardedFileSystem(fsPromises, true);
  const guardedFs = { ...guardedFileSystem(fs, false), promises: guardedPromises };
  for (const id of ['node:child_process', 'child_process']) {
    vi.doMock(id, () => ({ ...guardedProcesses, default: guardedProcesses }));
  }
  for (const id of ['node:fs/promises', 'fs/promises']) {
    vi.doMock(id, () => ({ ...guardedPromises, default: guardedPromises }));
  }
  for (const id of ['node:fs', 'fs']) {
    vi.doMock(id, () => ({ ...guardedFs, default: guardedFs }));
  }
  vi.doMock('../../pipeline/config.mjs', () => paths);
  vi.resetModules();
  // The real provenance helpers and entry point execute; only paths and dangerous APIs are replaced.
  const { exportEvidenceRoot, hashTree } = await import('../../pipeline/unreal/provenance.mjs');
  expect(exportEvidenceRoot).toBe(paths.provenanceDir);
  evidenceRoot = exportEvidenceRoot;
  const before = [hashTree(paths.sourceDir), hashTree(paths.contentDir), hashTree(resolve(paths.root, 'project'))];
  process.argv = [originalArgv[0]!, resolve(paths.root, 'pipeline', 'unreal', 'run.mjs'), ...args];
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let error: unknown;
  try {
    // @ts-expect-error The CLI has no typed exports; this test exercises its top-level side effects.
    await import('../../pipeline/unreal/run.mjs');
  } catch (caught) {
    error = caught;
  }
  // Attempts remain failures even if the audited code catches the interception error itself.
  expect(processAttempts, 'the audit must never start a child process').toEqual([]);
  expect(forbiddenWrites, 'the audit must only write its own evidence run').toEqual([]);
  expect([hashTree(paths.sourceDir), hashTree(paths.contentDir), hashTree(resolve(paths.root, 'project'))])
    .toEqual(before);
  return { paths, evidenceRoot, runDirectory, allowedWrites, logs: log.mock.calls, error };
}

describe('Unreal audit entry point I/O contract', () => {
  const modes = [
    { mode: 'default', args: [] },
    { mode: 'dry-run', args: ['--dry-run'] },
    { mode: 'execute', args: ['--execute'] },
    { mode: 'dry-run plus execute', args: ['--dry-run', '--execute'] },
  ];
  const cases = [false, true].flatMap((present) => modes.map((mode) => ({ ...mode, present })));

  it.each(cases)('confines $mode with editor/project present=$present to one evidence run', async ({ args, present }) => {
    const result = await audit(args, present);
    expect(result.error).toBeUndefined();
    const reportPath = resolve(result.runDirectory, 'export-provenance.json');
    expect(result.allowedWrites).toEqual([
      { method: 'mkdirSync', path: result.evidenceRoot },
      { method: 'mkdirSync', path: result.runDirectory },
      { method: 'writeFileSync', path: reportPath },
    ]);
    expect(fs.readdirSync(result.evidenceRoot)).toEqual([relative(result.evidenceRoot, result.runDirectory)]);
    expect(fs.readdirSync(result.runDirectory)).toEqual(['export-provenance.json']);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report).toMatchObject({
      result: 'blocked-before-editor-launch',
      auditExitCode: 0,
      executeRequested: args.includes('--execute'),
      editorSpawned: false,
      knownGoodUnchanged: true,
      isolatedOutputExists: false,
      resolvedPaths: {
        evidenceRoot: result.paths.provenanceDir,
        repository: result.paths.root,
        editor: { path: result.paths.unrealEditorCmd, exists: present },
        authoritativeProject: { path: result.paths.unrealProject, exists: present },
      },
      plannedEnvironment: {
        FR_EXPORT_EVIDENCE_ROOT: result.paths.provenanceDir,
      },
    });
    expect(report.knownGoodAfter).toEqual(report.knownGoodBefore);
    expect(report.knownGoodBefore.unreal).toMatchObject({ exists: true, files: 1 });
    expect(report.knownGoodBefore.content).toMatchObject({ exists: true, files: 1 });
    expect(result.logs).toEqual([
      [`[pipeline:unreal] audit complete: ${reportPath}`],
      [`[pipeline:unreal] planned isolated output: ${report.resolvedPaths.isolatedOutput}`],
      [`[pipeline:unreal] BLOCKED: ${report.blocker}`],
      ...(args.includes('--execute') ? [[
        '[pipeline:unreal] --execute was refused before spawning Unreal; audit exit code 0 records that no project write occurred.',
      ]] : []),
    ]);
  });

  it('rejects unknown options before any process or evidence mutation', async () => {
    const result = await audit(['--unknown'], true);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('unknown pipeline:unreal option(s): --unknown');
    expect(result.allowedWrites).toEqual([]);
    expect(fs.existsSync(result.evidenceRoot)).toBe(false);
    expect(result.logs).toEqual([]);
  });
});
