/** FileSaver.js's precedent: Safari and Firefox start the download after the click, so the URL must outlive it. */
const REVOKE_DELAY_MS = 40_000;
const revokeLater = (revoke: () => void): void => {
  setTimeout(revoke, REVOKE_DELAY_MS);
};

/** Hands a JSON file to the browser through a Blob URL, revoked on a later task (`schedule` is injectable for tests). */
export function downloadJsonFile(
  filename: string,
  text: string,
  schedule: (revoke: () => void) => void = revokeLater,
): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  schedule(() => URL.revokeObjectURL(url));
}
