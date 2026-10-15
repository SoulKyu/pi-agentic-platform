import "../../i18n/register-home.ts";
import type { ProjectSummary, ToolPreset } from "@pap/contracts";
import { errorKey, t } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import type { HomeActions } from "./home-actions.ts";
import type { HomeMode } from "./home-mode.ts";
import { laneLaunch, triggerLaunch } from "./launch-text.ts";

/**
 * Session (§3.1): `sessions.create` in the folder, then the text as the first message. A refused or unknown prompt keeps
 * the text in the new session's composer, so it is never lost; sent or not, that session's transcript says (Review Focus 1).
 */
export async function startSession(cwd: string, text: string, preset: ToolPreset): Promise<string> {
  const { rpc } = getRuntime();
  const { sessionId } = await rpc.call("sessions.create", { cwd, preset });
  const message = text.trim();
  if (message !== "") {
    try {
      await rpc.call("sessions.prompt", { sessionId, text: message });
    } catch {
      useComposerPrefill.getState().push(sessionId, message);
    }
  }
  return sessionId;
}

/** What a refused `sessions.create` says; a capacity refusal from a daemon that counted adds "n / n workers". */
function failureText(failure: unknown): string {
  const said = t(errorKey(failure instanceof RpcError ? failure.code : "internal"));
  const workers = failure instanceof RpcError ? failure.workers : undefined;
  return workers ? `${said} ${t("error.capacityWorkers", { used: workers.used, max: workers.max })}` : said;
}

/**
 * What Launch does per mode (§3.1): Lane, Fan-out and Trigger hand their prefill to the shell, Session runs here.
 * Its own chunk with the words of its errors: the first paint carries none of it. The words are read when they are
 * needed, with the live `t`: the catalog this chunk registers is not in a translator captured at render. Resolves to the
 * error to show, or null.
 */
export async function runLaunch(
  actions: HomeActions,
  preset: ToolPreset,
  mode: HomeMode,
  project: ProjectSummary,
  text: string,
): Promise<string | null> {
  if (mode === "trigger") {
    actions.newTrigger(project.id, triggerLaunch(text));
    return null;
  }
  if (mode === "lane" || mode === "fanout") {
    return actions.newLane(laneLaunch(text, project.root, mode === "fanout"))
      ? null
      : t("home.launch.noLaneHost");
  }
  // A timeout is never re-sent (R105): the failure says the session may exist.
  return startSession(project.root, text, preset).then((sessionId) => {
    actions.open({ kind: "session", id: sessionId });
    return null;
  }, failureText);
}
