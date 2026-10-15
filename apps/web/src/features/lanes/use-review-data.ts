import type { ReviewList, ReviewScope } from "@pap/contracts";
import type { LaneTurn, ReviewFile } from "./review-types.ts";
import { useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";

type Phase<T> =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly value: T }
  | { readonly phase: "error"; readonly code: string };
const LOADING = { phase: "loading" } as const;

const codeOf = (failure: unknown): string => (failure instanceof RpcError ? failure.code : "internal");

/**
 * One read, newest answer only: a reply for a scope left, or for an older attempt, is dropped. `key` names what is
 * asked; while a new key loads, the state says loading. `ask` is read when the key or the attempt moves.
 */
function useRead<T>(key: string | null, attempt: number, ask: () => Promise<T>): Phase<T> {
  const [held, setHeld] = useState<{ key: string; attempt: number; state: Phase<T> } | null>(null);
  const generation = useRef(0);
  const latest = useRef(ask);
  useEffect(() => {
    latest.current = ask;
  });
  useEffect(() => {
    if (key === null) return;
    const mine = ++generation.current;
    latest
      .current()
      .then(
        (value): Phase<T> => ({ phase: "ready", value }),
        (failure: unknown): Phase<T> => ({ phase: "error", code: codeOf(failure) }),
      )
      .then((state) => {
        if (generation.current === mine) setHeld({ key, attempt, state });
      });
    return () => {
      generation.current += 1;
    };
  }, [key, attempt]);
  return key !== null && held?.key === key && held.attempt === attempt ? held.state : LOADING;
}

export type ListState = Phase<ReviewList>;
export type TurnsState = Phase<readonly LaneTurn[]>;

/** `lanes.review` for a scope; null asks for nothing. */
export function useReviewList(laneId: string, scope: ReviewScope | null, attempt: number): ListState {
  return useRead(scope === null ? null : `${laneId}\0${JSON.stringify(scope)}`, attempt, () =>
    getRuntime().rpc.call("lanes.review", { laneId, scope: scope ?? { kind: "branch" } }),
  );
}

/** `lanes.turns` of the session, newest first; read only while `enabled`. */
export function useReviewTurns(laneId: string, sessionId: string | null, enabled: boolean): TurnsState {
  return useRead(enabled && sessionId !== null ? `${laneId}\0${sessionId}` : null, 0, async () => {
    const answer = await getRuntime().rpc.call("lanes.turns", { laneId, sessionId: sessionId ?? "" });
    return [...answer.turns].sort((a, b) => b.index - a.index);
  });
}

export type FileTextsState = Phase<FileTexts>;

export interface FileTexts {
  readonly before: string;
  readonly after: string;
  readonly binary: boolean;
  readonly truncated: boolean;
}

/** The two sides of one listed file (M9R76): the list's from-commit against the worktree, or against the end commit. */
export function useReviewFileDiff(
  worktree: string,
  list: ReviewList,
  file: ReviewFile | null,
  attempt: number,
): FileTextsState {
  const to = list.to.kind === "live" ? "live" : list.to.oid;
  const key =
    file === null || file.binary
      ? null
      : `${worktree}\0${list.from.oid}\0${to}\0${file.path}\0${file.identity}`;
  return useRead(key, attempt, async () => {
    if (file === null) throw new Error("no file");
    const answer = await getRuntime().rpc.call("vcs.fileDiff", {
      root: worktree,
      path: file.path,
      ...(file.oldPath === null ? {} : { oldPath: file.oldPath }),
      from: { kind: "commit", oid: list.from.oid },
      to: list.to.kind === "live" ? { kind: "worktree" } : { kind: "commit", oid: list.to.oid },
    });
    return {
      before: answer.before ?? "",
      after: answer.after ?? "",
      binary: answer.binary,
      truncated: answer.truncated,
    };
  });
}
