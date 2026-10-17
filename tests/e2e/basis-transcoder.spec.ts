import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { openShowroom } from './support/showroom';
import { expect, test } from './support/fixtures';

// The Basis transcoder pair is served content: the page points KTX2Loader at /content/basis/
// (src/scene/loaders.ts), and the build must not emit a second, hashed copy of either file into
// dist/assets. The first test reads the build output the preview server serves (the webServer
// config runs the production build before these tests); the second traces the requests the page
// actually makes once a look has been decoded.

test('builds no basis transcoder copy into dist/assets', async () => {
  const emitted = readdirSync(join(process.cwd(), 'dist', 'assets'));
  expect(
    emitted.filter((name) => name.includes('basis_transcoder')),
    'basis transcoder files in the bundle output',
  ).toEqual([]);
  for (const basename of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    expect(
      existsSync(join(process.cwd(), 'dist', 'content', 'basis', basename)),
      `the served copy dist/content/basis/${basename}`,
    ).toBe(true);
  }
});

test('fetches the transcoder from content, never from the bundle', async ({ page, request }) => {
  // The opening waits until the frame that draws the look, by which point the room's KTX2
  // textures are transcoded, and after it the page fetches no further transcoder file, so the
  // resource timing buffer holds exactly the page's own two transcoder fetches.
  await openShowroom(page, request, '/?gate=off&e2e=1&music=off&attract=0');

  const transcoderRequests = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((pathname) => pathname.includes('basis_transcoder')),
  );
  expect(transcoderRequests.sort(), 'transcoder request paths').toEqual([
    '/content/basis/basis_transcoder.js',
    '/content/basis/basis_transcoder.wasm',
  ]);
});
