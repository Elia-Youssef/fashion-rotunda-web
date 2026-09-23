// Audits the Unreal export route without launching Unreal.  UnrealEditor-Cmd may write logs,
// DerivedDataCache and project Saved/Intermediate state even when the Python export script writes
// elsewhere.  Until that behaviour is isolated and demonstrated, this launcher refuses to spawn it.

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { root, unrealEditorCmd, unrealProject } from '../config.mjs';
import {
  assertMatchingManifests,
  createEvidenceRun,
  exportEvidenceRoot,
  hashKnownGoodTrees,
  projectInventory,
} from './provenance.mjs';

const args = process.argv.slice(2);
const executeRequested = args.includes('--execute');
const unknown = args.filter((arg) => arg !== '--dry-run' && arg !== '--execute');
if (unknown.length > 0) {
  throw new Error(`unknown pipeline:unreal option(s): ${unknown.join(', ')}`);
}

const before = hashKnownGoodTrees();
const run = createEvidenceRun();
const script = resolve(root, 'pipeline', 'unreal', 'export.py');
const plannedCommand = [
  unrealEditorCmd,
  unrealProject,
  '-run=pythonscript',
  `-script=${script}`,
  '-AllowCommandletRendering',
  '-NoXGEShaderCompile',
  '-unattended',
  '-nopause',
  '-nosplash',
  '-stdout',
  '-FullStdOutLogOutput',
];

// No spawn is intentionally present in this module.  This check belongs after the first snapshot so
// the evidence proves the known-good output was unchanged even for a requested (refused) execution.
const after = hashKnownGoodTrees();
for (const key of Object.keys(before)) {
  assertMatchingManifests(before[key], after[key], key);
}

const blocker = [
  'UnrealEditor-Cmd is not executed by this route.',
  'The editor can write project Saved/Intermediate/DerivedDataCache and logs independently of FR_EXPORT_OUT;',
  'there is no validated invocation in this repository that redirects every one of those writes outside the',
  'read-only authoritative project.',
  existsSync(unrealEditorCmd)
    ? 'The configured editor executable exists, but isolation remains unproven.'
    : `The configured editor executable is also absent: ${unrealEditorCmd}.`,
].join(' ');

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  result: 'blocked-before-editor-launch',
  auditExitCode: 0,
  executeRequested,
  editorSpawned: false,
  blocker,
  resolvedPaths: {
    repository: root,
    authoritativeProject: projectInventory(unrealProject),
    editor: { path: unrealEditorCmd, exists: existsSync(unrealEditorCmd) },
    exporterScript: { path: script, exists: existsSync(script) },
    evidenceRoot: exportEvidenceRoot,
    isolatedOutput: run.outputDirectory,
  },
  plannedCommand,
  plannedEnvironment: {
    FR_EXPORT_OUT: run.outputDirectory,
    FR_EXPORT_EVIDENCE_ROOT: exportEvidenceRoot,
  },
  knownGoodBefore: before,
  knownGoodAfter: after,
  knownGoodUnchanged: true,
  isolatedOutputExists: existsSync(run.outputDirectory),
  nextSafeStep: 'Use an Unreal execution environment whose project-generated writes are redirected to an isolated copy, then repeat this audit and compare manifests before allowing a commandlet launch.',
};

const reportPath = resolve(run.runDirectory, 'export-provenance.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`[pipeline:unreal] audit complete: ${reportPath}`);
console.log(`[pipeline:unreal] planned isolated output: ${run.outputDirectory}`);
console.log(`[pipeline:unreal] BLOCKED: ${blocker}`);
if (executeRequested) {
  console.log('[pipeline:unreal] --execute was refused before spawning Unreal; audit exit code 0 records that no project write occurred.');
}
