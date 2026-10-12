import { useState } from "react";
import { useT, type MessageKey } from "../../i18n/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";

interface Announcement {
  readonly key: MessageKey;
  readonly vars?: Record<string, string | number>;
}

/**
 * What a polite live region says (DESIGN §12): the end of a run and a new approval, plus whatever the screen asks it to
 * (the branch a switch landed on). The words are chosen at render, so a locale switch changes them. A run starting
 * clears the region, so the same words announce again at the next end.
 */
export function useAnnouncer(view: SessionView): {
  readonly text: string;
  say(key: MessageKey, vars?: Record<string, string | number>): void;
} {
  const t = useT();
  const running = view.status === "running";
  const approvals = view.dialogs.filter((dialog) => dialog.method === "approval").length;
  const [seen, setSeen] = useState({ running, approvals });
  const [said, setSaid] = useState<Announcement | null>(null);
  // Adjusting state while rendering (React's "state from props" pattern): each transition is read once.
  if (seen.running !== running || seen.approvals !== approvals) {
    setSeen({ running, approvals });
    if (running) setSaid(null);
    else if (seen.running && view.status === "idle") setSaid({ key: "sessions.announce.runEnded" });
    if (approvals > seen.approvals) setSaid({ key: "sessions.announce.approval" });
  }
  return {
    text: said ? t(said.key, said.vars) : "",
    say: (key, vars) => setSaid(vars ? { key, vars } : { key }),
  };
}
