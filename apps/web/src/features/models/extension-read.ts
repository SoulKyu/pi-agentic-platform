import { ExtensionProviders } from "@pap/contracts";
import { create } from "zustand";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { failureCode } from "./failure.ts";
import { isStale } from "./picker/use-available-models.ts";

export type ExtensionRead =
  | { readonly status: "idle" }
  | { readonly status: "reading" }
  /** `stale`: an `unknown_method` answer or a gone chunk: the page and the daemon differ. */
  | { readonly status: "failed"; readonly code: string; readonly stale: boolean }
  /**
   * `refreshing`: read again after a selection write, the last answer still shown meanwhile. `refreshFailed`: the code
   * of the last read again that failed; the answer is the one before it (its marks may be out of date).
   */
  | {
      readonly status: "ready";
      readonly answer: ExtensionProviders;
      readonly refreshing: boolean;
      readonly refreshFailed: string | null;
    };

const IDLE: ExtensionRead = { status: "idle" };

/**
 * What `models.extensions` answered, for the tab (ADR 0070 as amended): Settings and every picker read this one store,
 * so a second opening runs no extension code; `read` runs it on a click, and a selection write made after a read runs
 * it again so `enabled` and `offered` stay true. A read while one runs joins it. The daemon keeps nothing; this page
 * keeps the last answer until a sign-out (the shell store's reset) or a reload.
 */
export const useExtensionRead = create<ExtensionRead>()(() => IDLE);

let generation = 0;
/** A selection write landed while a read ran: that read may predate it, so one more follows. */
let trailing = false;

const failed = (code: string, stale: boolean, kept: ExtensionProviders | null): ExtensionRead =>
  kept === null
    ? { status: "failed", code, stale }
    : { status: "ready", answer: kept, refreshing: false, refreshFailed: code };

export const busy = (state: ExtensionRead): boolean =>
  state.status === "reading" || (state.status === "ready" && state.refreshing);

/** `kept`: the answer a failed refresh leaves on screen (null for a read: its failure is the state). */
function run(kept: ExtensionProviders | null): void {
  const mine = ++generation;
  const settle = (next: ExtensionRead) => {
    if (mine !== generation) return;
    useExtensionRead.setState(next, true);
    if (trailing) {
      trailing = false;
      refreshExtensions();
    }
  };
  getRuntime()
    .rpc.call("models.extensions", {})
    .then(
      (raw) => {
        const parsed = ExtensionProviders.safeParse(raw);
        if (!parsed.success) reportClientIssue("setting_load_failed");
        if (parsed.success)
          settle({ status: "ready", answer: parsed.data, refreshing: false, refreshFailed: null });
        else settle(failed("internal", false, kept));
      },
      (error: unknown) => {
        reportClientIssue("setting_load_failed");
        settle(failed(failureCode(error), isStale(error), kept));
      },
    );
}

/** Runs the owner's global extensions in a helper, on their click: a call while a read runs does nothing. */
export function readExtensions(): void {
  if (busy(useExtensionRead.getState())) return;
  useExtensionRead.setState({ status: "reading" }, true);
  run(null);
}

/** After a selection write: reads again what this tab already read (nothing read: nothing runs), keeping it on screen. */
export function refreshExtensions(): void {
  const state = useExtensionRead.getState();
  if (busy(state)) {
    trailing = true;
    return;
  }
  if (state.status !== "ready") return;
  useExtensionRead.setState({ ...state, refreshing: true }, true);
  run(state.answer);
}

/** Drops the answer and any read in flight: the next account starts from nothing. */
export function forgetExtensions(): void {
  generation += 1;
  trailing = false;
  useExtensionRead.setState(IDLE, true);
}

// Sign-out resets the shell store (AppShell's cleanup) to its empty view, the only one not `loaded`: this store
// follows it, as the terminal store's per-account maps do (`surface-terminal.ts`).
useShellStore.subscribe((state) => {
  if (!state.view.loaded) forgetExtensions();
});
