import { cancelsComposition } from "@pap/ui";
import { reportClientIssue } from "../../lib/report.ts";
import { readContext, type ShellContext } from "./context.ts";
import type { Platform } from "./keys.ts";
import { runCommand } from "../../lib/command-registry.ts";
import { matchingCommands, type ResolvedRule } from "./resolve.ts";

export interface DispatcherDeps {
  readonly win: Window;
  readonly platform: Platform;
  rules(): readonly ResolvedRule[];
  shell(): ShellContext;
}

/** A handler that throws counts as unclaimed: one bounded log line, never the error text. */
function claimed(command: string): boolean {
  try {
    return runCommand(command);
  } catch {
    reportClientIssue("command_failed");
    return false;
  }
}

/** One capture-phase listener for the whole app (Orca use-global-keybindings.ts). Returns its removal. */
export function installDispatcher(deps: DispatcherDeps): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || cancelsComposition(event) || event.key === "Process")
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-shortcut-recorder]")) return;
    const context = readContext(deps.win.document, deps.shell());
    for (const command of matchingCommands(event, deps.rules(), context, deps.platform)) {
      if (claimed(command)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  };
  deps.win.addEventListener("keydown", onKeyDown, { capture: true });
  return () => deps.win.removeEventListener("keydown", onKeyDown, { capture: true });
}
