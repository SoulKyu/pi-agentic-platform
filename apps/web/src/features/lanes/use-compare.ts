import type { LaneView, ResultOf } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

type Columns = ResultOf<"lanes.compare">["columns"];

const COMPARE_ERRORS: Readonly<Record<string, MessageKey>> = {
  not_found: "compare.error.not_found",
  capacity: "compare.error.capacity",
  timeout: "compare.error.timeout",
  bad_request: "compare.error.bad_request",
  read_only: "compare.error.read_only",
};

/** Every code the compare and close calls declare has its own words; anything else reads as a plain failure. */
export const compareFailureKey = (failure: unknown): MessageKey =>
  (failure instanceof RpcError ? COMPARE_ERRORS[failure.code] : undefined) ?? "compare.error.other";

/** What changes a column's figures: the lanes' state, tests and facts. A change reads the comparison again. */
export const laneSignature = (lanes: readonly LaneView[]): string =>
  lanes.map((lane) => `${lane.id}:${lane.state}:${lane.tests.state}:${lane.facts?.checkedAt ?? 0}`).join("|");

/**
 * `lanes.compare` of the group, read again when a lane's signature changes or on `reload`. An older answer never
 * replaces a newer one; the last good columns stay while the next load runs.
 */
export function useCompare(fanoutId: string, known: boolean, signature: string) {
  const [columns, setColumns] = useState<Columns | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (!known) return undefined;
    let current = true;
    getRuntime()
      .rpc.call("lanes.compare", { fanoutId })
      .then(
        (answer) => {
          if (!current) return;
          setColumns(answer.columns);
          setError(null);
        },
        (failure: unknown) => {
          if (current) setError(compareFailureKey(failure));
        },
      );
    return () => {
      current = false;
    };
  }, [fanoutId, known, signature, loads]);
  const reload = useCallback(() => setLoads((count) => count + 1), []);
  return { columns, error, reload };
}

const TEST_REFUSED = {
  none: "compare.runTests.refused.none",
  unapproved: "compare.runTests.refused.unapproved",
  running: "compare.runTests.refused.running",
  not_active: "compare.runTests.refused.not_active",
} as const satisfies Record<string, MessageKey>;

export interface RunTests {
  readonly busy: boolean;
  /** Waiting for the inline "Run anyway". */
  readonly tainted: boolean;
  readonly problem: MessageKey | null;
  run(confirmTainted?: boolean): void;
  cancel(): void;
}

/** "Run tests" (M9R96): a `tainted` answer asks inline and sends again with `confirmTainted`. */
export function useRunTests(laneId: string): RunTests {
  const [busy, setBusy] = useState(false);
  const [tainted, setTainted] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  // Promise chains, not try/finally: the React Compiler bails out on a finalizer.
  const run = (confirmTainted = false) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const { rpc } = getRuntime();
    rpc
      .call(
        "lanes.runScript",
        { laneId, kind: "test", ...(confirmTainted ? { confirmTainted: true } : {}) },
        { commandId: rpc.newCommandId() },
      )
      .then(
        (answer) => {
          setTainted(!answer.ok && answer.reason === "tainted");
          if (!answer.ok && answer.reason !== "tainted") setProblem(TEST_REFUSED[answer.reason]);
        },
        () => {
          setTainted(false);
          setProblem("compare.runTests.failed");
        },
      )
      .finally(() => setBusy(false));
  };
  return { busy, tainted, problem, run, cancel: () => setTainted(false) };
}
