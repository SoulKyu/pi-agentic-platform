/** The drag type of an explorer row (`features/files/ExplorerRow.tsx`; features never import each other, M8R77). */
export const PATH_DRAG_TYPE = "application/x-pap-path";

/** A drag worth a drop here: files from the desktop, or an explorer row. */
export function acceptsDrag(transfer: DataTransfer): boolean {
  const types = Array.from(transfer.types);
  return types.includes("Files") || types.includes(PATH_DRAG_TYPE);
}

/**
 * The files of a drop and how many folders it held. Read inside the event handler: the entries are gone after it.
 * A browser without entries gives the plain list.
 */
export function filesOf(transfer: DataTransfer): { readonly files: File[]; readonly folders: number } {
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === "file");
  if (items.length === 0) return { files: Array.from(transfer.files ?? []), folders: 0 };
  const files: File[] = [];
  let folders = 0;
  for (const item of items) {
    if (item.webkitGetAsEntry?.()?.isDirectory) folders++;
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return { files, folders };
}

/**
 * Files on the clipboard (a screenshot, a copied file). When text came with them (a cell copied from a sheet carries
 * a picture too) the paste stays text.
 */
export function pastedFiles(transfer: DataTransfer): File[] {
  if (transfer.getData("text/plain") !== "") return [];
  return filesOf(transfer).files;
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_NAME_CHARS = 80;

/** A file name for display: invisible and bidi characters removed, clipped (names are untrusted text). */
export function displayName(name: string): string {
  const clean = Array.from(name.replace(INVISIBLE, ""));
  return clean.length > MAX_NAME_CHARS ? `${clean.slice(0, MAX_NAME_CHARS).join("")}…` : clean.join("");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
