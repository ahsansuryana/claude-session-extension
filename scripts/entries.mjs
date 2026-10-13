/**
 * Build entry points.
 *
 * Shared between `build.mjs` (which bundles them) and `tests/manifest.test.ts`
 * (which asserts the resulting configuration).
 */

/**
 * Each entry is bundled separately into a self-contained IIFE. Content scripts
 * are loaded by Chrome as classic scripts, so they cannot share chunks - every
 * entry must be standalone.
 *
 * `name` must be a legal JS identifier; a dash fails the build.
 */
export const ENTRIES = [
  { input: 'src/bridge/main.ts', file: 'main-world.js', name: 'SessionTransferMain' },
  { input: 'src/content/index.ts', file: 'content.js', name: 'SessionTransferContent' },
  {
    input: 'src/background/service-worker.ts',
    file: 'service-worker.js',
    name: 'SessionTransferWorker',
  },
];