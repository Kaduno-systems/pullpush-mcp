import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: true,
  // src/index.ts already starts with its own `#!/usr/bin/env node` shebang,
  // which esbuild preserves as-is. Do NOT also set a `banner` here — that
  // would prepend a second shebang line, which Node treats as a syntax
  // error (only line 1 is special-cased as a hashbang).
  splitting: false,
  shims: false,
});
