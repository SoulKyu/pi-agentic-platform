import type { ReviewDoc } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";

const EMPTY: ReviewDoc = { seen: [], comments: [] };

export interface ReviewState {
  readonly status: "loading" | "ready" | "error";
  readonly doc: ReviewDoc;
  /** The code of the last read or save that failed; cleared by the next success. */
  readonly error: string | null;
  /**
   * Saves `mutate(doc)` with the revision held (compare-and-set). On a `conflict` it reads again and applies the same
   * change to what the server has, which merges by comment id and Seen by path, then tries once more. One change at a
   * time. False when nothing was saved; the view then shows what the server has.
   */
  update(mutate: (doc: ReviewDoc) => ReviewDoc): Promise<boolean>;
  reload(): void;
}

const codeOf = (failure: unknown): string => (failure instanceof RpcError ? failure.code : "internal");

/** The lane's review document (Seen files and comments), one copy for the pane. */
export function useReviewState(laneId: string): ReviewState {
  const [held, setHeld] = useState<{ doc: ReviewDoc; revision: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<{ doc: ReviewDoc; revision: number } | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const [attempt, setAttempt] = useState(0);

  const publish = useCallback((next: { doc: ReviewDoc; revision: number }) => {
    latest.current = next;
    if (mounted.current) setHeld(next);
  }, []);
  const read = useCallback(async () => {
    const answer = await getRuntime().rpc.call("lanes.reviewState.get", { laneId });
    return { doc: answer.doc, revision: answer.revision };
  }, [laneId]);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    read().then(
      (next) => {
        if (!current) return;
        publish(next);
        setError(null);
      },
      (failure: unknown) => {
        if (current) setError(codeOf(failure));
      },
    );
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [read, publish, attempt]);

  const save = useCallback(
    async (mutate: (doc: ReviewDoc) => ReviewDoc): Promise<boolean> => {
      let base = latest.current;
      if (base === null) return false;
      const { rpc } = getRuntime();
      for (const retry of [false, true]) {
        const next = mutate(base.doc);
        if (next === base.doc) return true;
        publish({ doc: next, revision: base.revision });
        try {
          const saved = await rpc.call(
            "lanes.reviewState.set",
            { laneId, doc: next, baseRevision: base.revision },
            { commandId: rpc.newCommandId() },
          );
          publish({ doc: next, revision: saved.revision });
          if (mounted.current) setError(null);
          return true;
        } catch (failure) {
          const code = codeOf(failure);
          // A timeout leaves the outcome unknown: the server's copy is the truth, and nothing is sent again.
          const fresh = await read().catch(() => null);
          if (fresh) publish(fresh);
          if (code === "conflict" && !retry && fresh) {
            base = fresh;
            continue;
          }
          if (mounted.current) setError(code);
          return false;
        }
      }
      return false;
    },
    [laneId, publish, read],
  );

  const update = useCallback(
    (mutate: (doc: ReviewDoc) => ReviewDoc): Promise<boolean> => {
      const run = chain.current.then(() => save(mutate));
      chain.current = run.catch(() => false);
      return run;
    },
    [save],
  );

  return {
    status: held !== null ? "ready" : error !== null ? "error" : "loading",
    doc: held?.doc ?? EMPTY,
    error,
    update,
    reload: () => {
      setError(null);
      setAttempt((count) => count + 1);
    },
  };
}
