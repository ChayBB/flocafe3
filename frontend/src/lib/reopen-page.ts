/**
 * Loads the page again through a new URL instead of `location.reload()`. iOS Safari reads a reload
 * as a sign the page broke and offers to reduce its privacy protections.
 */
export function reopenPage(): void {
  const url = new URL(window.location.href);
  url.searchParams.set('reopen', Date.now().toString(36));
  window.location.replace(url.href);
}
