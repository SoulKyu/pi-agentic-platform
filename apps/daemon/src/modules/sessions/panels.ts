import { type Notice, type Panel, type SessionStreamEvent, UI_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { KeyedThrottle } from "./keyed-throttle.ts";

const SAY_EVERY_MS = 10_000;
const TOO_MANY = "An extension opened too many panels. The extra one was cancelled.";

export interface PanelsDeps {
  readonly clock: Clock;
  publish(event: SessionStreamEvent): void;
  /** Tells the worker to cancel the panel (`custom_cancel`): the extension's `custom()` then resolves `undefined`. */
  cancel(id: string): void;
  say(notice: Notice): void;
  readonly throttle: KeyedThrottle;
  /** A render for a panel that was closed was ignored; the caller decides how often to say so. */
  stale(id: string): void;
}

export interface Panels {
  render(id: string, lines: readonly string[]): void;
  close(id: string): void;
  has(id: string): boolean;
  list(): Panel[];
  /** Forgets every panel and its pending render; returns the ids that were open. */
  clear(): string[];
}

/** How many closed ids are remembered, oldest dropped: enough for the records still in flight at a close. */
const REMEMBERED_CLOSED = 64;
const keyOf = (id: string): string => `panel:${id}`;

/**
 * The extension panels a session shows, at most `UI_LIMITS.panels` (M2R82). A render for a fifth is answered with a
 * cancel; a record for an id the daemon never saw (a close after such a cancel) is ignored without a word.
 */
export function createPanels(deps: PanelsDeps): Panels {
  const open = new Map<string, Panel>();
  const closed = new Set<string>();
  const limiter = createRateLimiter(deps.clock, SAY_EVERY_MS);
  return {
    render(id, lines) {
      if (closed.has(id)) {
        deps.stale(id);
        return;
      }
      if (!open.has(id) && open.size >= UI_LIMITS.panels) {
        deps.cancel(id);
        if (limiter.check("too_many").allowed) deps.say({ level: "warning", text: TOO_MANY });
        return;
      }
      const panel: Panel = {
        id,
        lines: lines.slice(0, UI_LIMITS.panelLines).map((line) => line.slice(0, UI_LIMITS.panelLineChars)),
      };
      open.set(id, panel);
      deps.throttle.push(keyOf(id), { kind: "panel", panel });
    },
    close(id) {
      if (!open.delete(id)) return;
      closed.add(id);
      if (closed.size > REMEMBERED_CLOSED) closed.delete(closed.values().next().value as string);
      deps.throttle.flush(keyOf(id));
      deps.publish({ kind: "panel_closed", id });
    },
    has: (id) => open.has(id),
    list: () => [...open.values()],
    clear() {
      const ids = [...open.keys()];
      for (const id of ids) deps.throttle.drop(keyOf(id));
      open.clear();
      closed.clear();
      return ids;
    },
  };
}
