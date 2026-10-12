import type { SessionView } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";

type Labels = Readonly<Record<string, Pick<SessionView, "name" | "cwd">>>;

let last: Labels = {};

/** The name and folder of each loaded view, the same object while none changed: a streamed token re-renders nobody. */
function labelsOf(views: Readonly<Record<string, SessionView>>): Labels {
  const next: Record<string, Pick<SessionView, "name" | "cwd">> = {};
  let same = Object.keys(views).length === Object.keys(last).length;
  for (const [id, view] of Object.entries(views)) {
    const before = last[id];
    if (before && before.name === view.name && before.cwd === view.cwd) next[id] = before;
    else {
      same = false;
      next[id] = { name: view.name, cwd: view.cwd };
    }
  }
  if (same) return last;
  last = next;
  return next;
}

/** What `itemTitle` reads from the session views (M4R86), subscribed narrowly. */
export const useViewLabels = (): Labels => useSessionStore((state) => labelsOf(state.views));
