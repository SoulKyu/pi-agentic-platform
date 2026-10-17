import { type SubagentProfile, SubagentsProfilesResult } from "@pap/contracts";
import { useEffect, useState } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";

export type SubagentProfiles =
  | { readonly kind: "loading" }
  | { readonly kind: "needSession" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly profiles: readonly SubagentProfile[]; readonly truncated: boolean };

/**
 * The subagent profiles (M11R155), read-only. `subagents.profiles` reads Pi's agent folders for a session's folder, so the
 * read needs one of the owner's sessions; without any the list says so instead of guessing a folder.
 */
export function useSubagentProfiles(): SubagentProfiles {
  const sessionId = useShellStore((state) => {
    let best: { id: string; updatedAt: number } | null = null;
    for (const session of state.view.sessions.values())
      if (session.archivedAt === null && (best === null || session.updatedAt > best.updatedAt))
        best = session;
    return best?.id ?? null;
  });
  const [result, setResult] = useState<{ readonly for: string; readonly state: SubagentProfiles } | null>(
    null,
  );
  useEffect(() => {
    if (sessionId === null) return;
    let current = true;
    getRuntime()
      .rpc.call("subagents.profiles", { sessionId })
      .then(
        (answer) => {
          const parsed = SubagentsProfilesResult.safeParse(answer);
          if (!parsed.success) reportClientIssue("setting_load_failed");
          const state: SubagentProfiles = parsed.success
            ? { kind: "ready", profiles: parsed.data.profiles, truncated: parsed.data.truncated }
            : { kind: "failed" };
          if (current) setResult({ for: sessionId, state });
        },
        () => {
          reportClientIssue("setting_load_failed");
          if (current) setResult({ for: sessionId, state: { kind: "failed" } });
        },
      );
    return () => {
      current = false;
    };
  }, [sessionId]);
  if (sessionId === null) return { kind: "needSession" };
  return result?.for === sessionId ? result.state : { kind: "loading" };
}
