/** Filename slug + file download, no `chrome.downloads` permission required. */

const MAX_SLUG = 60;

/** Lowercase, non-alphanumerics collapsed to dashes, trimmed, length-capped. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug || 'session';
}

/** Extension is part of the name so a downloaded file is recognisable on disk. */
export function bundleFilename(name: string): string {
  return `${slugify(name)}.claude-session.json`;
}

/** Write JSON to a file in the user's downloads folder. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a delay so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}