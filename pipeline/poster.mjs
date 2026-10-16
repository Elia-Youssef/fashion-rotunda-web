// Derive the phone lobby still from the shipped full poster. No source asset is overwritten.
// Run: node pipeline/poster.mjs [--out FILE]

import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ffmpegExe, root } from './config.mjs';

// A 960 px still covers phone landscape layouts while trading fine marble detail for transfer size.
const PHONE_POSTER_WIDTH = 960;
// FFmpeg's JPEG quantizer 5 keeps the architectural silhouettes within the 100 KB phone allowance.
const JPEG_QUANTIZER = 5;
const MAX_POSTER_BYTES = 100_000;

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out')) {
  throw new Error('Usage: node pipeline/poster.mjs [--out FILE]');
}
const source = resolve(root, 'public/poster/hero.jpg');
const output = resolve(args[1] ?? resolve(root, 'public/poster/hero-phone.jpg'));
if (output.toLowerCase() === source.toLowerCase()) throw new Error('The full poster is read-only');
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(ffmpegExe, [
  '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
  '-i', source, '-map_metadata', '-1', '-frames:v', '1',
  '-vf', `scale=${PHONE_POSTER_WIDTH}:-2:flags=lanczos`,
  '-c:v', 'mjpeg', '-q:v', String(JPEG_QUANTIZER), '-pix_fmt', 'yuvj420p',
  '-threads', '1', '-fflags', '+bitexact', '-flags:v', '+bitexact', output,
], { encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Poster encoding failed (${result.status}): ${result.stderr}`);
const bytes = statSync(output).size;
if (bytes > MAX_POSTER_BYTES) throw new Error(`Phone poster is ${bytes} bytes, limit ${MAX_POSTER_BYTES}`);
console.log(`phone poster: ${bytes} bytes, width ${PHONE_POSTER_WIDTH} -> ${output}`);
