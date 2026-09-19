// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Git worktrees lint themselves from inside their own folder; from here they are duplicate
  // copies of the same files.
  // public/ holds shipped content and vendored transcoder files (basis_transcoder.js), never source.
  { ignores: ['dist/**', 'node_modules/**', '.worktrees/**', 'public/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
  },
  {
    files: ['*.config.js', '*.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // tools/*.mjs drives a browser from node, so it needs both global sets; without this block
    // no-undef flags process, navigator, window and console in gpu-check.mjs.
    files: ['tools/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // The asset pipeline is plain node scripts.
    files: ['pipeline/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
