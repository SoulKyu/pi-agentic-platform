import { useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";

export interface DiffTarget {
  readonly path: string;
  readonly oldPath: string | null;
  /** Moves when the file's content moved (its status letters and counts): a new signature reads the diff again. */
  readonly signature: string;
}

export interface FileDiffTexts {
  readonly before: string;
  readonly after: string;
  readonly binary: boolean;
  readonly truncated: boolean;
}

export type FileDiffState =
  | { readonly phase: "idle" }
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly diff: FileDiffTexts }
  | { readonly phase: "error"; readonly code: string };

type Settled = Exclude<FileDiffState, { phase: "idle" | "loading" }>;
const LOADING: FileDiffState = { phase: "loading" };
const IDLE: FileDiffState = { phase: "idle" };

/**
 * The head-to-worktree diff of one file (`vcs.fileDiff`). Only the newest request may answer: a reply for a file
 * left, or for an older signature, is dropped. While a newer signature of the same file loads, the last diff stays.
 * A null target asks for nothing. `attempt` asks again (Retry).
 */
export function useFileDiff(root: string, target: DiffTarget | null, attempt: number): FileDiffState {
  const [held, setHeld] = useState<{ key: string; state: Settled } | null>(null);
  const generation = useRef(0);
  const path = target?.path ?? null;
  const oldPath = target?.oldPath ?? null;
  const signature = target?.signature ?? null;
  const key = path === null ? null : `${root}\0${path}\0${oldPath ?? ""}`;

  useEffect(() => {
    if (path === null || key === null) return;
    const mine = ++generation.current;
    const params = {
      root,
      path,
      ...(oldPath === null ? {} : { oldPath }),
      from: { kind: "head" } as const,
      to: { kind: "worktree" } as const,
    };
    getRuntime()
      .rpc.call("vcs.fileDiff", params)
      .then(
        (answer) => {
          if (generation.current !== mine) return;
          const diff = {
            before: answer.before ?? "",
            after: answer.after ?? "",
            binary: answer.binary,
            truncated: answer.truncated,
          };
          setHeld({ key, state: { phase: "ready", diff } });
        },
        (failure: unknown) => {
          if (generation.current !== mine) return;
          const code = failure instanceof RpcError ? failure.code : "internal";
          setHeld({ key, state: { phase: "error", code } });
        },
      );
    return () => {
      generation.current += 1;
    };
  }, [root, path, oldPath, signature, key, attempt]);

  if (key === null) return IDLE;
  return held !== null && held.key === key ? held.state : LOADING;
}
