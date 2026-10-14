import { toast } from "@pap/ui";
import { errorKey, t } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { randomId } from "../../runtime/random-id.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { feedTerminals } from "../../stores/terminal-feed.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { useTerminalReady } from "./surface-view.ts";

// Its own chunk (surface.ts imports it on demand): the terminal store, its reducer and the create call stay out of
// the initial bundle until a session surface is on screen.

/** Opens the `terminal` stream into the store; `ready` turns on at its first snapshot. Returns the stop. */
export function startTerminalFeed(): () => void {
  const ready = useTerminalReady.getState();
  ready.set(false);
  const unwatch = useTerminalStore.subscribe((state) => {
    if (!state.view.loaded) resetTerminalMemory(); // sign-out reset: the next account starts from nothing
    if (state.view.loaded) ready.set(true);
  });
  const stop = feedTerminals(getRuntime().subscriptions, () => reportClientIssue("terminal_feed_failed"));
  return () => {
    stop();
    unwatch();
    ready.set(false);
  };
}

/** The newest running terminal tagged with the session (the list is oldest first). */
function taggedTerminal(sessionId: string): string | null {
  const tagged = useTerminalStore
    .getState()
    .view.list.filter((one) => one.sessionId === sessionId && one.status === "running");
  return tagged.at(-1)?.id ?? null;
}

// The terminal a create just answered with, until the stream next speaks: the stream event may trail the answer.
// The terminal a create just answered with, until the store lists it (the stream event may trail the answer) and then
// no longer does (it exited or closed). An unrelated store change leaves it alone (MC32).
const recent = new Map<string, { readonly id: string; seen: boolean }>();
useTerminalStore.subscribe((state) => {
  if (!state.view.loaded) resetTerminalMemory(); // sign-out reset: the next account starts from nothing
  for (const [sessionId, entry] of recent) {
    const listed = state.view.terminals.get(entry.id);
    if (listed) entry.seen = true;
    if (listed?.status === "exited" || (!listed && entry.seen)) recent.delete(sessionId);
  }
});

const inFlight = new Map<string, Promise<string | null>>();
// A create whose outcome is unknown is retried with the same id, so the daemon answers the terminal it made.
const unknownOutcome = new Map<string, string>();
/** Forgets every per-account memory of this module; the terminal store's reset (sign-out) calls it. */
function resetTerminalMemory(): void {
  recent.clear();
  inFlight.clear();
  unknownOutcome.clear();
}

const OUTCOME_UNKNOWN = ["timeout", "connection_lost"];
const MAX_REMEMBERED = 32;

function create(sessionId: string, cwd: string): Promise<string | null> {
  const requestId = unknownOutcome.get(sessionId) ?? randomId(16);
  unknownOutcome.delete(sessionId);
  const run = getRuntime()
    .rpc.call("terminal.create", { requestId, cwd, sessionId, cols: 80, rows: 24 })
    .then((result) => {
      if (recent.size >= MAX_REMEMBERED) recent.delete(recent.keys().next().value as string);
      recent.set(sessionId, { id: result.terminalId, seen: false });
      return result.terminalId;
    })
    .catch((failure: unknown) => {
      const code = failure instanceof RpcError ? failure.code : "internal";
      if (OUTCOME_UNKNOWN.includes(code) && unknownOutcome.size < MAX_REMEMBERED)
        unknownOutcome.set(sessionId, requestId);
      toast({ message: t(errorKey(code)), tone: "error" });
      return null;
    })
    .finally(() => inFlight.delete(sessionId));
  inFlight.set(sessionId, run);
  return run;
}

/** This session's terminal: the tagged one, else one created for its folder. Clicks while a create runs share it. */
export function terminalFor(sessionId: string, cwd: string): Promise<string | null> {
  if (!useTerminalReady.getState().ready) return Promise.resolve(null); // the list of terminals is not known yet
  const existing = taggedTerminal(sessionId) ?? recent.get(sessionId)?.id ?? null;
  if (existing !== null) return Promise.resolve(existing);
  return inFlight.get(sessionId) ?? create(sessionId, cwd);
}

/** How many unknown-outcome request ids are remembered (capped at 32). */
export const rememberedRequests = (): number => unknownOutcome.size;

/** The size of each per-account map, for the sign-out test. */
export const terminalMemory = () => ({
  recent: recent.size,
  inFlight: inFlight.size,
  unknownOutcome: unknownOutcome.size,
});
