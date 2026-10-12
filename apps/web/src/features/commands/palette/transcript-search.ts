import type { SearchHit } from "@pap/contracts";
import { useEffect, useState } from "react";
import { getRuntime, RpcError } from "../../../runtime/index.ts";

/** The daemon expands a prefix from 3 code points; a shorter word is not worth a round trip (M4R106). */
export const MIN_SEARCH_POINTS = 3;
export const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 20;

export interface TranscriptSearch {
  readonly status: "idle" | "loading" | "done" | "error";
  readonly hits: SearchHit[];
  readonly code?: string;
}

interface Settled {
  readonly q: string;
  readonly status: "done" | "error";
  readonly hits: SearchHit[];
  readonly code?: string;
}

/** The text to search, or null when the query is for actions only (`>`) or too short. */
export function searchText(query: string): string | null {
  const q = query.trim();
  return q.startsWith(">") || [...q].length < MIN_SEARCH_POINTS ? null : q;
}

const IDLE: TranscriptSearch = { status: "idle", hits: [] };
const LOADING: TranscriptSearch = { status: "loading", hits: [] };

/**
 * Transcript hits for a palette query, asked 150 ms after the last change. A change or an unmount drops the pending
 * timer and whatever answer is still on its way, so an older answer never replaces a newer one.
 */
export function useTranscriptSearch(query: string): TranscriptSearch {
  const q = searchText(query);
  const [settled, setSettled] = useState<Settled | null>(null);
  useEffect(() => {
    if (q === null) return;
    let current = true;
    const timer = setTimeout(() => {
      // A runtime that cannot be built settles as an error too, never an exception out of a timer.
      Promise.resolve()
        .then(() => getRuntime().rpc.call("search.query", { q, limit: SEARCH_LIMIT }))
        .then(
          ({ hits }) => current && setSettled({ q, status: "done", hits }),
          (failure: unknown) =>
            current &&
            setSettled({
              q,
              status: "error",
              hits: [],
              code: failure instanceof RpcError ? failure.code : "internal",
            }),
        );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q]);
  if (q === null) return IDLE;
  if (settled?.q !== q) return LOADING;
  return settled.code === undefined
    ? { status: settled.status, hits: settled.hits }
    : { status: settled.status, hits: settled.hits, code: settled.code };
}
