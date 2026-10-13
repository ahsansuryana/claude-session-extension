import { describe, expect, it } from 'vitest';
import { manifest } from '../scripts/build.mjs';
import { ENTRIES } from '../scripts/entries.mjs';

/**
 * Build-configuration invariants.
 *
 * These are the things that fail at runtime in ways unit tests of the modules
 * can never see: `chrome.action` is undefined unless the manifest declares an
 * `action`, and content scripts must each carry the `world` their code assumes.
 */
describe('manifest', () => {
  it('is manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('declares an action so chrome.action exists in the worker', () => {
    // Without this key, `chrome.action` is undefined and every badge call
    // throws "Cannot read properties of undefined".
    expect(manifest.action).toBeTruthy();
    expect(typeof manifest.action).toBe('object');
  });

  it('requests only the permissions the extension uses', () => {
    expect(manifest.permissions.sort()).toEqual(['alarms', 'storage']);
    // The dock and dialogs use an anchor click for downloads, so the
    // `downloads` permission is not needed.
    expect(manifest.permissions).not.toContain('downloads');
  });

  it('is scoped to claude.ai only', () => {
    expect(manifest.host_permissions).toEqual(['https://claude.ai/*']);
  });

  it('registers the MAIN-world bridge at document_start', () => {
    const main = manifest.content_scripts.find((c) => c.world === 'MAIN');
    expect(main).toBeTruthy();
    // It must be installed before the isolated script can call it.
    expect(main?.run_at).toBe('document_start');
    expect(main?.js).toEqual(['main-world.js']);
  });

  it('registers the UI script at document_idle in the isolated world', () => {
    const ui = manifest.content_scripts.find((c) => c.world === 'ISOLATED');
    expect(ui).toBeTruthy();
    expect(ui?.run_at).toBe('document_idle');
    expect(ui?.js).toEqual(['content.js']);
  });

  it('runs the MAIN bridge before the UI everywhere', () => {
    expect(manifest.content_scripts[0]?.world).toBe('MAIN');
  });

  it('never runs content scripts in subframes', () => {
    for (const cs of manifest.content_scripts) expect(cs.all_frames).toBe(false);
  });

  it('targets a Chrome that supports world: MAIN', () => {
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(111);
  });
});

describe('entries', () => {
  it('bundles each script as a standalone classic script', () => {
    // Content scripts are not modules: every entry must be self-contained.
    expect(ENTRIES.map((e) => e.file).sort()).toEqual([
      'content.js',
      'main-world.js',
      'service-worker.js',
    ]);
  });

  it('uses legal identifiers for the IIFE wrappers', () => {
    // A dash in `name` is an illegal JS identifier and fails the build.
    for (const e of ENTRIES) expect(e.name).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  });
});