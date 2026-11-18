/**
 * Saves a Blob the API returned (a PDF, an export) as a file.
 *
 * Authenticated files must be fetched through the API client — it carries the
 * bearer token and the API's own origin. A plain `<a href="/api/...">` does
 * neither: in production the client is served by a static host that rewrites every
 * path to `index.html`, so such a link opened the app shell instead of the file.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick so the browser has started the download first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
