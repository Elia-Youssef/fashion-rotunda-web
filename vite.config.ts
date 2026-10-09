import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { CONTENT_SECURITY_POLICY } from './src/content-security-policy';

export const productionCspPlugin = {
  name: 'production-content-security-policy',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler() {
      return [{
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: CONTENT_SECURITY_POLICY,
        },
        // Enforce the policy before Vite's scripts, preloads and stylesheets are encountered.
        injectTo: 'head-prepend',
      }];
    },
  },
} satisfies Plugin;

// host true binds the dev server to every interface, so a phone on the same network can open it.
// WebGPU needs a secure context, so a LAN address over plain HTTP falls back to WebGL 2 by design.
export default defineConfig({
  plugins: [productionCspPlugin],
  server: {
    host: true,
  },
});
