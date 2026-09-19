import { defineConfig } from 'vite';

// host true binds the dev server to every interface, so a phone on the same network can open it.
// WebGPU needs a secure context, so a LAN address over plain HTTP falls back to WebGL 2 by design.
export default defineConfig({
  server: {
    host: true,
  },
});
