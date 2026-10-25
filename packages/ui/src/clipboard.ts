/**
 * Copies text the same way over HTTPS and plain HTTP. The Clipboard API exists only in a secure context, so on a LAN served over
 * HTTP (ADR 0004) a selected textarea is copied instead. False when neither path worked: the caller says so to the person.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyBySelection(text);
  }
}

/** The textarea sits beside the focused control, so a dialog's focus trap lets it take focus; then focus goes back. */
function copyBySelection(text: string): boolean {
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.className = "fixed top-0 left-0 opacity-0";
  (back?.parentElement ?? document.body).append(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    back?.focus();
  }
}
