import { defineConfig } from 'vitest/config';

// Unit tests live in tests/unit and run in node. A test that needs the DOM declares
// `// @vitest-environment jsdom` on its first line. Shared by every suite; change it deliberately.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
