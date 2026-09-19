// Runs pipeline/unreal/export.py inside the Unreal Editor commandlet: no editor window, no clicks.
// The editor loads the project headless, executes the script, and exits. Rendering is allowed because
// the glTF exporter bakes non-trivial material inputs to textures on the GPU. The full editor log goes
// to assets-src/work/unreal-export.log; only the script's own lines and errors are echoed here.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { root, sourceDir, unrealEditorCmd, unrealProject, workDir } from '../config.mjs';

const out = resolve(sourceDir, 'unreal');
mkdirSync(out, { recursive: true });
mkdirSync(workDir, { recursive: true });

const script = resolve(root, 'pipeline', 'unreal', 'export.py');
const logPath = resolve(workDir, 'unreal-export.log');
const log = createWriteStream(logPath);

const args = [
  unrealProject,
  '-run=pythonscript',
  `-script=${script}`,
  '-AllowCommandletRendering',
  // The engine picks the XGE controller for shader compilation and then waits for agents that do not
  // exist on this machine; the first run sat idle at 1,448 dispatched jobs. Local workers it is.
  '-NoXGEShaderCompile',
  '-unattended',
  '-nopause',
  '-nosplash',
  '-stdout',
  '-FullStdOutLogOutput',
];

console.log(`[pipeline:unreal] ${unrealEditorCmd}`);
console.log(`[pipeline:unreal] output ${out}`);
console.log(`[pipeline:unreal] full log ${logPath}`);

const started = Date.now();
const child = spawn(unrealEditorCmd, args, {
  env: { ...process.env, FR_EXPORT_OUT: out },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let carry = '';
function handle(chunk) {
  log.write(chunk);
  carry += chunk.toString();
  const lines = carry.split(/\r?\n/);
  carry = lines.pop() ?? '';
  for (const line of lines) {
    if (line.includes('[fr-export]') || line.includes('LogPython: Error') || line.includes('Traceback')) {
      console.log(line.replace(/^\[[^\]]*\]\[\s*\d+\]/, ''));
    }
  }
}
child.stdout.on('data', handle);
child.stderr.on('data', handle);

child.on('close', (code) => {
  log.end();
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[pipeline:unreal] editor exited with code ${code} after ${seconds} s`);
  process.exitCode = code ?? 1;
});
