/**
 * Triggers a real browser file download for an already-fetched Blob (e.g. a
 * CSV/PDF report export read via `response.blob()` — see
 * report-export-client.ts). Not a redirect/window.open to a URL: the blob
 * itself is wrapped in an object URL, clicked via a throwaway anchor, then
 * cleaned up.
 *
 * The object URL must not be revoked before `.click()` has fired — some
 * browsers resolve the download asynchronously off the anchor's href, so a
 * synchronous revoke immediately after click() can race it. Revoking after a
 * short delay (rather than never) avoids leaking the URL's backing memory.
 */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
