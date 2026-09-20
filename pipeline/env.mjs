// Builds the browser environment from the authored EXR without modifying the source.
//
// Poliigon's EXR uses DWA compression, which Blender/OpenImageIO reads correctly but ffmpeg's
// decoder on this machine does not. Blender writes a Radiance HDR because three's HDRLoader reads
// that format directly on both WebGPU and WebGL 2.

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { blenderExe, contentDir, root, sourceDir } from './config.mjs';
import { ENVIRONMENT_FILE, ENVIRONMENT_WIDTH } from './environment.mjs';

const source = resolve(sourceDir, 'environment', 'school-field-cloudy-2k.exr');
const output = resolve(contentDir, ENVIRONMENT_FILE);
const temporary = resolve(contentDir, 'env', `.school-field-cloudy-${process.pid}.hdr`);
const converter = resolve(root, 'pipeline', 'blender', 'env.py');

function dimensionsOfRadiance(path) {
  const head = readFileSync(path).subarray(0, 4096).toString('ascii');
  if (!head.startsWith('#?RADIANCE')) {
    throw new Error(`environment output is not a Radiance HDR: ${path}`);
  }
  const match = head.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
  if (match === null) {
    throw new Error(`environment output has no Radiance resolution line: ${path}`);
  }
  return { width: Number(match[2]), height: Number(match[1]) };
}

mkdirSync(resolve(contentDir, 'env'), { recursive: true });
rmSync(temporary, { force: true });

const converted = spawnSync(
  blenderExe,
  [
    '--background',
    '--factory-startup',
    '--python',
    converter,
    '--',
    source,
    temporary,
    String(ENVIRONMENT_WIDTH),
  ],
  { stdio: 'inherit' },
);

if (converted.error !== undefined) {
  throw converted.error;
}
if (converted.status !== 0) {
  throw new Error(`environment conversion exited ${converted.status ?? 'without a status'}`);
}

const dimensions = dimensionsOfRadiance(temporary);
if (dimensions.width !== ENVIRONMENT_WIDTH || dimensions.height !== ENVIRONMENT_WIDTH / 2) {
  throw new Error(
    `environment output is ${dimensions.width}x${dimensions.height}, expected ` +
      `${ENVIRONMENT_WIDTH}x${ENVIRONMENT_WIDTH / 2}`,
  );
}

// Publish only a complete, validated temporary. Conversion and validation failures therefore leave
// the last known-good runtime asset untouched.
copyFileSync(temporary, output);
rmSync(temporary, { force: true });
console.log(`environment: ${ENVIRONMENT_FILE}, ${statSync(output).size} bytes`);
