import type { LaneView } from "@pap/contracts";
import { useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureKey } from "./failure-text.ts";

const SETUP_REFUSED = {
  none: "lanes.setup.refused.none",
  unapproved: "lanes.setup.refused.unapproved",
  running: "lanes.setup.refused.running",
  not_active: "lanes.setup.refused.not_active",
} as const satisfies Record<string, MessageKey>;

export interface RunSetup {
  readonly busy: boolean;
  /** Waiting for the inline "Run anyway". */
  readonly tainted: boolean;
  readonly problem: MessageKey | null;
  run(confirmTainted?: boolean): void;
  cancel(): void;
}

/** "Run setup": a `tainted` answer asks inline and sends again with `confirmTainted` (M9R65). */
export function useRunSetup(laneId: string): RunSetup {
  const [busy, setBusy] = useState(false);
  const [tainted, setTainted] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const run = (confirmTainted = false) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const { rpc } = getRuntime();
    rpc
      .call(
        "lanes.runScript",
        { laneId, kind: "setup", ...(confirmTainted ? { confirmTainted: true } : {}) },
        { commandId: rpc.newCommandId() },
      )
      .then(
        (answer) => {
          setTainted(!answer.ok && answer.reason === "tainted");
          if (!answer.ok && answer.reason !== "tainted") setProblem(SETUP_REFUSED[answer.reason]);
        },
        (failure: unknown) => {
          setTainted(false);
          setProblem(failureKey(failure, "lanes.setup.failed"));
        },
      )
      .finally(() => setBusy(false));
  };
  return { busy, tainted, problem, run, cancel: () => setTainted(false) };
}

export interface NewSession {
  readonly busy: boolean;
  readonly problem: MessageKey | null;
  /** Starts a session in the lane; `onStarted` gets its id. */
  start(): void;
}

export function useNewSession(
  lane: Pick<LaneView, "id">,
  onStarted: (sessionId: string) => void,
): NewSession {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const start = () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const { rpc } = getRuntime();
    rpc
      .call("lanes.newSession", { laneId: lane.id }, { commandId: rpc.newCommandId() })
      .then(
        (created) => onStarted(created.sessionId),
        (failure: unknown) => setProblem(failureKey(failure, "lanes.session.newFailed")),
      )
      .finally(() => setBusy(false));
  };
  return { busy, problem, start };
}
