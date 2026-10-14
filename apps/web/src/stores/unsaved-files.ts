/** The folders whose files pane holds unsaved edits, for the shell to ask before it closes one. One entry per open pane. */
const roots = new Set<string>();

export function setUnsavedFiles(root: string, unsaved: boolean): void {
  if (unsaved) roots.add(root);
  else roots.delete(root);
}

export const hasUnsavedFiles = (root: string): boolean => roots.has(root);

export function resetUnsavedFiles(): void {
  roots.clear();
}
