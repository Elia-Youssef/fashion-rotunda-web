// The one registration RectAreaLight needs before it can be drawn, and the reason it is a module of its
// own: it imports from 'three/webgpu', so nothing the node tests load may import it.
//
// WebGPURenderer requires explicit LTC texture registration before drawing rect lights.
// node_modules/three/src/nodes/lighting/RectAreaLightNode.js holds the tables in a
// module level `_ltcLib` that starts null (line 14) and reads it without a guard when it builds the shader
// (lines 95 to 102), so the first frame with a rect light in it throws a TypeError until setLTC has run.
// src/lights/RectAreaLight.js lines 12 to 17 say the same thing in the class documentation, naming
// RectAreaLightTexturesLib for WebGPURenderer and RectAreaLightUniformsLib for the old WebGLRenderer.
//
// The call builds four data textures of about 80 kB and needs no renderer, so it can run at boot before
// anything is on screen. The composition root calls it once, wherever the scene is composed.

import { RectAreaLightNode } from 'three/webgpu';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';

let registered = false;

/** Idempotent: the tables are static, so a second call would only rebuild the same four textures. */
export function registerRectAreaLights(): void {
  if (registered) return;
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
  registered = true;
}
