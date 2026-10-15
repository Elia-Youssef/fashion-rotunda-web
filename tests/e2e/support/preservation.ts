import { deepStrictEqual, ok } from 'node:assert/strict';
import { TIERS } from '../../../src/tiers/table';
import type { Page } from '@playwright/test';

// Drawing buffers round fractional pixels down; allow at most one pixel on either axis.
const BACKING_ROUNDING_PX = 1;
// The proof panel formats the effective pixel ratio to two decimal places.
const PIXEL_RATIO_DECIMALS = 2;
const PROOF_REFRESH_TIMEOUT_MS = 5_000;

interface CanvasReading {
  box: { x: number; y: number; width: number; height: number };
  backing: { width: number; height: number };
  devicePixelRatio: number;
  pixelRatioCap: number;
  pixelRatio: number;
  renderScale: number;
  scaleX: number;
  scaleY: number;
  backend: string | null;
  tier: string;
  look: string | null;
  variant: string | null;
  camera: string | null;
  post: string | null;
}

/** Capture live state and rows together after the panel publishes its refresh completion counter. */
export async function nextProofReading(page: Page) {
  return page.evaluate(({ caps, timeout }) => new Promise<{
    canvas: CanvasReading;
    camera: { mode: string; position: number[]; target: number[] };
    scene: { meshes: number; materials: Record<string, number> };
    memory: string | null;
    frames: number;
    drawCalls: number;
  }>((resolve, reject) => {
    const list = document.querySelector('.proof-panel__list');
    if (list === null) { reject(new Error('proof panel is unavailable')); return; }
    const previousRefresh = list.getAttribute('data-refresh');
    const observer = new MutationObserver(() => {
      if (list.getAttribute('data-refresh') === previousRefresh) return;
      observer.disconnect();
      clearTimeout(timer);
      try {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas#scene');
        const camera = window.archvizCamera;
        const hooks = window.archvizE2E;
        if (canvas === null || camera === undefined || hooks === undefined) {
          throw new Error('the e2e canvas, camera, or scene handle is unavailable');
        }
        const row = (name: string): string => {
          const term = [...list.querySelectorAll('.proof-panel__term')].find(
            (node) => node.textContent === name,
          );
          const value = term?.nextElementSibling?.textContent;
          if (!value) throw new Error(`missing proof row: ${name}`);
          return value;
        };
        // The proof panel row carries the tier as data; the badge in the footer strip only prints it.
        const tier = row('tier');
        if (tier !== 'base' && tier !== 'mid' && tier !== 'high') {
          throw new Error(`unknown proof tier: ${tier}`);
        }
        const rect = canvas.getBoundingClientRect();
        const description = hooks.describeScene();
        resolve({
          canvas: {
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            backing: { width: canvas.width, height: canvas.height },
            devicePixelRatio: window.devicePixelRatio,
            pixelRatioCap: caps[tier],
            pixelRatio: Number(row('pixel ratio')),
            renderScale: Number(row('render scale')),
            scaleX: canvas.width / (rect.width * window.devicePixelRatio),
            scaleY: canvas.height / (rect.height * window.devicePixelRatio),
            backend: canvas.dataset.backend ?? null,
            tier,
            look: canvas.dataset.look ?? null,
            variant: canvas.dataset.variant ?? null,
            camera: canvas.dataset.camera ?? null,
            post: canvas.dataset.post ?? null,
          },
          camera: {
            mode: camera.mode,
            position: [...camera.orbit.position],
            target: [...camera.orbit.target],
          },
          scene: { meshes: description.meshes, materials: description.materials },
          memory: canvas.dataset.memory ?? null,
          frames: Number(canvas.dataset.frames ?? '0'),
          drawCalls: Number(row('draw calls').replace(/ calls$/, '')),
        });
      } catch (error) { reject(error); }
    });
    const timer = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error('proof panel did not refresh'));
    }, timeout);
    observer.observe(list, { attributes: true, attributeFilter: ['data-refresh'] });
  }), {
    caps: { base: TIERS.base.pixelRatioCap, mid: TIERS.mid.pixelRatioCap, high: TIERS.high.pixelRatioCap },
    timeout: PROOF_REFRESH_TIMEOUT_MS,
  });
}

function assertResolution(reading: CanvasReading, label: string): void {
  const ratio = Math.min(reading.devicePixelRatio, reading.pixelRatioCap) * reading.renderScale;
  for (const [name, value] of Object.entries({
    devicePixelRatio: reading.devicePixelRatio, pixelRatioCap: reading.pixelRatioCap,
    renderScale: reading.renderScale, width: reading.box.width, height: reading.box.height,
  })) ok(Number.isFinite(value) && value > 0, `${label}: valid ${name}`);
  deepStrictEqual(reading.pixelRatio, Number(ratio.toFixed(PIXEL_RATIO_DECIMALS)),
    `${label}: published pixel ratio matches capped DPR times render scale`);
  for (const axis of ['width', 'height'] as const) {
    ok(Math.abs(reading.backing[axis] - reading.box[axis] * ratio) <= BACKING_ROUNDING_PX,
      `${label}: backing ${axis} matches capped DPR times render scale`);
  }
  deepStrictEqual(reading.scaleX, reading.backing.width / (reading.box.width * reading.devicePixelRatio),
    `${label}: derived scaleX matches backing width`);
  deepStrictEqual(reading.scaleY, reading.backing.height / (reading.box.height * reading.devicePixelRatio),
    `${label}: derived scaleY matches backing height`);
}

export function assertCanvasPreserved(before: CanvasReading, after: CanvasReading, label: string): void {
  assertResolution(before, `${label} before`);
  assertResolution(after, `${label} after`);
  // Keep all identity fields, including CSS geometry, DPR and its cap, exact.
  deepStrictEqual(after, {
    ...before, backing: after.backing, renderScale: after.renderScale, pixelRatio: after.pixelRatio,
    scaleX: after.scaleX, scaleY: after.scaleY,
  }, `${label}: canvas/runtime identity is preserved`);
  if (before.renderScale === after.renderScale) {
    deepStrictEqual(after.backing, before.backing, `${label}: unchanged scale preserves backing size`);
  }
}

export function stableDrawCalls(
  previous: Awaited<ReturnType<typeof nextProofReading>>,
  current: Awaited<ReturnType<typeof nextProofReading>>,
): number | null {
  if (!Number.isInteger(current.drawCalls) || current.drawCalls <= 0 ||
    previous.drawCalls !== current.drawCalls ||
    previous.canvas.renderScale !== current.canvas.renderScale ||
    previous.canvas.post !== current.canvas.post) return null;
  return current.drawCalls;
}

export function assertRendererPreserved(
  before: Omit<Awaited<ReturnType<typeof nextProofReading>>, 'drawCalls'>,
  after: Omit<Awaited<ReturnType<typeof nextProofReading>>, 'drawCalls'>,
  label: string,
): void {
  assertCanvasPreserved(before.canvas, after.canvas, label);
  deepStrictEqual(after, { ...before, canvas: after.canvas, frames: after.frames },
    `${label}: persistent renderer state is preserved`);
}
