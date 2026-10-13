import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs';
import { ENTRIES } from './entries.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

export const manifest = {
  manifest_version: 3,
  name: 'Session Transfer',
  version: pkg.version,
  description:
    'Save a Claude conversation in one browser profile and continue it in another.',
  minimum_chrome_version: '111',
  permissions: ['storage', 'alarms'],
  host_permissions: ['https://claude.ai/*'],
  // Declared so `chrome.action` exists in the service worker. Without an
  // `action` key the API is simply undefined and every badge call throws.
  action: {
    default_title: 'Session Transfer',
  },
  background: {
    service_worker: 'service-worker.js',
  },
  content_scripts: [
    {
      matches: ['https://claude.ai/*'],
      js: ['main-world.js'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: false,
    },
    {
      matches: ['https://claude.ai/*'],
      js: ['content.js'],
      run_at: 'document_idle',
      world: 'ISOLATED',
      all_frames: false,
    },
  ],
};

async function bundle({ emptyOutDir }) {
  for (const [i, entry] of ENTRIES.entries()) {
    await build({
      root,
      configFile: false,
      logLevel: 'warn',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: dist,
        emptyOutDir: emptyOutDir && i === 0,
        // Chrome 111+ is the floor (world: 'MAIN'). Vite 8 minifies with oxc,
        // so esbuild must not be referenced here.
        minify: true,
        sourcemap: true,
        lib: {
          entry: path.join(root, entry.input),
          formats: ['iife'],
          name: entry.name,
          fileName: () => entry.file,
        },
      },
    });
  }
  fs.writeFileSync(
    path.join(dist, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

async function main() {
  if (process.argv.includes('--watch')) {
    let building = false;
    let queued = false;
    const rebuild = async () => {
      if (queued) return;
      queued = true;
      while (building) await new Promise((r) => setTimeout(r, 100));
      building = true;
      try {
        await bundle({ emptyOutDir: true });
        console.log('[build] dist/ updated');
      } catch (err) {
        console.error('[build] failed:', err.message);
      } finally {
        building = false;
        queued = false;
      }
    };
    await rebuild();
    let timer = null;
    watch(path.join(root, 'src'), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 120);
    });
    console.log('[build] watching src/ - load dist/ unpacked in chrome://extensions');
  } else {
    await bundle({ emptyOutDir: true });
    const files = fs.readdirSync(dist).filter((f) => !f.endsWith('.map'));
    console.log('[build] dist/:', files.join(', '));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});