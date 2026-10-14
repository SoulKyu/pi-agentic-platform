import type { FileMeta } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";

/** Reloads from offset 0 after a chunk of another version, this many times in a row, then gives up (M8R116). */
const MAX_RESTARTS = 2;

export type OpenFileNote = "changed" | "unstable" | null;

export interface OpenFile {
  readonly status: "loading" | "ready" | "error";
  /** The code of the failed first read (`not_found`...). */
  readonly code: string | null;
  readonly meta: FileMeta | null;
  readonly text: string;
  /** Where the next chunk starts; null when the whole file is loaded. */
  readonly nextOffset: number | null;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly note: OpenFileNote;
  /** The whole file came from the chunks of one version: the only state an editor may open on. */
  readonly complete: boolean;
  loadMore(): void;
  reload(): void;
  /** The file was saved by this page: its new meta and text are what is loaded. */
  replace(meta: FileMeta, text: string): void;
}

interface State {
  readonly status: OpenFile["status"];
  readonly code: string | null;
  readonly meta: FileMeta | null;
  readonly text: string;
  readonly nextOffset: number | null;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly note: OpenFileNote;
  readonly stable: boolean;
}

const LOADING: State = {
  status: "loading",
  code: null,
  meta: null,
  text: "",
  nextOffset: null,
  loadingMore: false,
  moreFailed: false,
  note: null,
  stable: true,
};

const sameVersion = (a: FileMeta, b: FileMeta): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs;

/** One file, read in chunks. Every read of an older generation (a reload, another file) is dropped. */
export function useOpenFile(path: string): OpenFile {
  const [state, setState] = useState<State>(LOADING);
  const generation = useRef(0);
  const first = useRef<FileMeta | null>(null);
  const restarts = useRef(0);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });

  const readFirst = useCallback(
    (note: OpenFileNote) => {
      const mine = ++generation.current;
      first.current = null;
      getRuntime()
        .rpc.call("files.read", { path, offset: 0 })
        .then(
          (answer) => {
            if (generation.current !== mine) return;
            first.current = answer.meta;
            setState({
              ...LOADING,
              status: "ready",
              meta: answer.meta,
              text: answer.text,
              nextOffset: answer.nextOffset,
              note,
              stable: note !== "unstable",
            });
          },
          (failure: unknown) => {
            if (generation.current !== mine) return;
            setState({
              ...LOADING,
              status: "error",
              code: failure instanceof RpcError ? failure.code : "internal",
            });
          },
        );
    },
    [path],
  );

  useEffect(() => {
    readFirst(null);
    return () => {
      generation.current += 1; // a read still in flight answers nobody
    };
  }, [readFirst]);

  const loadMore = useCallback(() => {
    const { nextOffset, loadingMore } = latest.current;
    if (nextOffset === null || loadingMore) return;
    const mine = generation.current;
    setState((current) => ({ ...current, loadingMore: true, moreFailed: false }));
    getRuntime()
      .rpc.call("files.read", { path, offset: nextOffset })
      .then(
        (answer) => {
          if (generation.current !== mine) return;
          const base = first.current;
          if (base !== null && !sameVersion(base, answer.meta)) {
            if (restarts.current < MAX_RESTARTS) {
              restarts.current += 1;
              readFirst("changed");
            } else {
              restarts.current = 0;
              readFirst("unstable");
            }
            return;
          }
          restarts.current = 0;
          setState((current) => ({
            ...current,
            text: current.text + answer.text,
            nextOffset: answer.nextOffset,
            loadingMore: false,
          }));
        },
        () => {
          if (generation.current !== mine) return;
          setState((current) => ({ ...current, loadingMore: false, moreFailed: true }));
        },
      );
  }, [path, readFirst]);

  const reload = useCallback(() => {
    restarts.current = 0;
    setState(LOADING);
    readFirst(null);
  }, [readFirst]);

  const replace = useCallback((saved: FileMeta, text: string) => {
    generation.current += 1; // a chunk of the old version still in flight answers nobody
    first.current = saved;
    restarts.current = 0;
    setState({ ...LOADING, status: "ready", meta: saved, text, nextOffset: null });
  }, []);

  return {
    ...state,
    replace,
    complete: state.status === "ready" && state.stable && state.nextOffset === null,
    loadMore,
    reload,
  };
}
