import { reportClientIssue } from "../../lib/report.ts";
import type { Timers } from "../../runtime/connection.ts";
import { windowTimers } from "../../runtime/index.ts";
import type { TerminalOutcome } from "../../stores/reply-ports.ts";
import { useTerminalTypists } from "../../stores/terminal-typists.ts";
import { showTerminalFor } from "./surface.ts";
import { useSurfaceView } from "./surface-view.ts";

/** How long the terminal has to mount and get ready, counted from the moment its id is known (UX1-R19). */
const ATTACH_WAIT_MS = 10_000;
const POLL_MS = 100;

/** Asks the terminal's typist until it types or refuses; `timeout` when the pane never mounts or never gets ready. */
function typeWhenReady(
  terminalId: string,
  text: string,
  timers: Timers,
): Promise<Exclude<TerminalOutcome, "too_long" | "busy">> {
  return new Promise((resolve) => {
    const attempt = (waited: number): void => {
      try {
        const answer = useTerminalTypists.getState().typists[terminalId]?.handOff(text) ?? "not_ready";
        if (answer !== "not_ready") return resolve(answer);
        if (waited >= ATTACH_WAIT_MS) return resolve("timeout");
        timers.set(() => attempt(waited + POLL_MS), POLL_MS);
      } catch {
        // A later attempt runs from a timer, outside handOff's try: it settles here or the session stays in flight.
        reportClientIssue("terminal_hand_off_failed");
        resolve("unavailable");
      }
    };
    attempt(0);
  });
}

async function handOff(
  tabKey: string,
  sessionId: string,
  text: string,
  timers: Timers,
): Promise<TerminalOutcome> {
  let outcome: TerminalOutcome;
  try {
    const terminalId = await showTerminalFor(tabKey, sessionId);
    outcome = terminalId === null ? "unavailable" : await typeWhenReady(terminalId, text, timers);
  } catch {
    reportClientIssue("terminal_hand_off_failed");
    outcome = "unavailable";
  }
  // The inline message is in Chat: a phone shows one pane at a time, so a refusal brings the owner back to it.
  if (outcome !== "typed" && document.documentElement.dataset["shell"] === "mobile") {
    useSurfaceView.getState().show(tabKey, "chat");
  }
  return outcome;
}

const inFlight = new Map<string, { readonly text: string; readonly run: Promise<TerminalOutcome> }>();

/**
 * Types the text into the session's terminal (UX1-R18) and moves the focus there; the owner's Enter runs it. A second
 * click while one is in flight gets the first's answer (UX1-R24). Nothing is ever retried.
 */
export function toTerminal(
  tabKey: string,
  sessionId: string,
  text: string,
  deps: { readonly timers?: Timers } = {},
): Promise<TerminalOutcome> {
  const running = inFlight.get(sessionId);
  // Only the same text shares the answer: another block must not be told that its text was typed.
  if (running) return running.text === text ? running.run : Promise.resolve("busy");
  const run = handOff(tabKey, sessionId, text, deps.timers ?? windowTimers).finally(() => {
    inFlight.delete(sessionId);
  });
  inFlight.set(sessionId, { text, run });
  return run;
}
