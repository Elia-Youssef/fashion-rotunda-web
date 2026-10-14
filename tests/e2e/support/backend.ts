import { test } from './fixtures';

/** The renderer backend each configured project is expected to exercise. */
export function projectBackend(): 'webgpu' | 'webgl2' {
  return test.info().project.name === 'webgpu' ? 'webgpu' : 'webgl2';
}

/** Force the fallback only in its project; native WebGPU fixtures must not carry webgl=1. */
export function backendPath(path: string): string {
  const url = new URL(path, 'http://localhost');
  if (projectBackend() === 'webgl2') {
    url.searchParams.set('webgl', '1');
  } else {
    url.searchParams.delete('webgl');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
