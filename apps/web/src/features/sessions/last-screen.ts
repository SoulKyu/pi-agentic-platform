/**
 * The session screen the focus was last inside, weakly held so a closed screen can be collected (M4R114). A command run
 * from the palette starts with the focus in the palette, so it acts on this screen instead of declining.
 */
let last: WeakRef<Element> | null = null;

export function rememberScreen(screen: Element | null): void {
  last = screen ? new WeakRef(screen) : null;
}

/** Where a command goes: the screen holding the focus, else the one that held it last (if it is still on the page). */
export function targetScreen(active: Element | null): Element | null {
  const holder = active?.closest("[data-session-screen]") ?? null;
  if (holder) return holder;
  const screen = last?.deref() ?? null;
  return screen?.isConnected ? screen : null;
}
