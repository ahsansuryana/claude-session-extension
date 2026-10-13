/** Types for the build scripts, which are plain ESM JavaScript. */

export interface BuildEntry {
  input: string;
  file: string;
  /** IIFE global name; must be a legal JS identifier. */
  name: string;
}

export const ENTRIES: BuildEntry[];

export interface ManifestContentScript {
  matches: string[];
  js: string[];
  run_at: string;
  world: 'MAIN' | 'ISOLATED';
  all_frames: boolean;
}

export interface Manifest {
  manifest_version: number;
  name: string;
  version: string;
  description: string;
  minimum_chrome_version: string;
  permissions: string[];
  host_permissions: string[];
  /** Required: without it `chrome.action` is undefined in the worker. */
  action: { default_title: string };
  background: { service_worker: string };
  content_scripts: ManifestContentScript[];
}

export const manifest: Manifest;