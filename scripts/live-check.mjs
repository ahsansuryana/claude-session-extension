import { build } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: path.join(root, '.playwright-mcp'),
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: path.join(root, 'scripts/live-check.entry.ts'),
      formats: ['iife'],
      name: 'SessionTransferLiveCheck',
      fileName: () => 'live-check.js',
    },
  },
});

console.log('built .playwright-mcp/live-check.js');