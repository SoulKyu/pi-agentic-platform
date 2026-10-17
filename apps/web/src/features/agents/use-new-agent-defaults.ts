import { AgentSandbox, AgentsSettings } from "@pap/contracts";
import { useEffect, useState } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";

export interface NewAgentStart {
  readonly required: boolean;
  readonly network: boolean;
}

/** The safe start: the contract's own sandbox default (on, no network). It is also what an unreadable or missing document means. */
const SAFE: NewAgentStart = AgentSandbox.parse({});

/** How long the form waits for the document before it starts from the safe default. */
const DEADLINE_MS = 5000;

export interface NewAgentDefaults {
  /** Null until the read has settled or the deadline has passed. */
  readonly start: NewAgentStart | null;
  /** The deadline passed with no answer: `start` is the safe default. */
  readonly late: boolean;
}

/**
 * The sandbox the new-agent form starts from: the `agents` account document's `newAgent.sandbox` (M11R99). Null until the
 * read has settled; a failed read or a document that does not parse starts from the safe default, and says so once. A read
 * that has not answered after 5 s starts from the safe default too, and the dialog says so.
 */
export function useNewAgentDefaults(): NewAgentDefaults {
  const [state, setState] = useState<NewAgentDefaults>({ start: null, late: false });
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      if (live) setState((previous) => (previous.start === null ? { start: SAFE, late: true } : previous));
    }, DEADLINE_MS);
    getRuntime()
      .rpc.call("settings.get", { key: "agents" })
      .then(
        (answer) => {
          const parsed = AgentsSettings.safeParse(answer.value ?? {});
          if (!parsed.success) reportClientIssue("setting_load_failed");
          return parsed.success ? parsed.data.newAgent.sandbox : SAFE;
        },
        () => {
          reportClientIssue("setting_load_failed");
          return SAFE;
        },
      )
      .then((next) => {
        // The form reads its start once: an answer after the deadline changes nothing.
        if (live) setState((previous) => (previous.start === null ? { start: next, late: false } : previous));
      });
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);
  return state;
}
