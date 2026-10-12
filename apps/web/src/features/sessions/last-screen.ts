/**
 * The session screen the focus was last inside. A command run from the palette starts with the focus in the palette,
 * so it acts on this screen instead of declining.
 */
let last: Element | null = null;

export function rememberScreen(screen: Element | null): void {
  last = screen;
}

/** Where a command goes: the screen holding the focus, else the one that held it last (if it is still on the page). */
export function targetScreen(active: Element | null): Element | null {
  const holder = active?.closest("[data-session-screen]") ?? null;
  if (holder) return holder;
  return last?.isConnected ? last : null;
}
