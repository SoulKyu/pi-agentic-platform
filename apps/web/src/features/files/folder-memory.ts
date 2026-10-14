/** The expanded folders of each root, for the page's life (M8R76). Few roots are browsed; the oldest root is forgotten. */
const MAX_REMEMBERED_ROOTS = 16;
export const remembered = new Map<string, readonly string[]>();

export function resetFolderMemory(): void {
  remembered.clear();
}

export const rememberedRoots = (): number => remembered.size;

export function remember(root: string, expanded: readonly string[]): void {
  remembered.delete(root);
  remembered.set(root, expanded);
  for (const stale of remembered.keys()) {
    if (remembered.size <= MAX_REMEMBERED_ROOTS) break;
    remembered.delete(stale);
  }
}
