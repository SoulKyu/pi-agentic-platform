import type { SessionSummary } from "@pap/contracts";
import { create } from "zustand";
import { reportClientIssue } from "../../lib/report.ts";
import type { Runtime } from "../../runtime/index.ts";

export const MAX_CACHED_SESSIONS = 500;

interface SessionsCacheState {
  readonly sessions: readonly SessionSummary[];
  readonly status: "idle" | "loading" | "loaded" | "error";
  /** Never rejects; a call while one runs returns that same promise, so two answers never race. */
  refresh(rpc: Runtime["rpc"]): Promise<void>;
}

// One request at a time: a second caller shares it, so a stale answer cannot overwrite a newer one.
let inFlight: Promise<void> | null = null;

/** The session list the shell shows names from: newest first, at most 500. */
export const useSessionsCache = create<SessionsCacheState>()((set) => ({
  sessions: [],
  status: "idle",
  refresh: (rpc) => {
    inFlight ??= (async () => {
      set({ status: "loading" });
      try {
        const { sessions } = await rpc.call("sessions.list", {});
        const newest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
        set({ sessions: newest.slice(0, MAX_CACHED_SESSIONS), status: "loaded" });
      } catch {
        reportClientIssue("sessions_list_failed"); // the list stays as it was
        set({ status: "error" });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));
