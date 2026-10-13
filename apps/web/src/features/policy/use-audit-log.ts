import type { AuditView } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { MAX_ROWS } from "./audit.vm.ts";
import { failureText } from "./failure.ts";

const PAGE = 100;

interface Listing {
  readonly entries: readonly AuditView[];
  readonly nextBefore: number | null;
}
const EMPTY: Listing = { entries: [], nextBefore: null };

/**
 * `audit.list` page by page (M5R93). One request at a time; the filter is what was last applied, and a page that
 * arrives for an older filter is dropped before the newer filter is asked for (M2R55).
 */
export function useAuditLog() {
  const [listing, setListing] = useState<Listing>(EMPTY);
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a stale page settles: the effect below then asks for the filter applied meanwhile.
  const [restarts, setRestarts] = useState(0);
  const wanted = useRef("");
  // Bumped by every applied filter: a page asked under an older epoch is stale even when the text came back.
  const epoch = useRef(0);
  const inflight = useRef(false);
  const alive = useRef(true);
  const shown = useRef<Listing>(EMPTY);

  const fetchPage = useCallback((older: boolean) => {
    if (inflight.current) return;
    const asked = wanted.current;
    const born = epoch.current;
    const before = older ? shown.current.nextBefore : null;
    inflight.current = true;
    setBusy(true);
    getRuntime()
      .rpc.call("audit.list", {
        limit: PAGE,
        ...(asked === "" ? {} : { sessionId: asked }),
        ...(before === null ? {} : { before }),
      })
      .then(
        (page) => {
          if (!alive.current || born !== epoch.current) return;
          const have = older ? shown.current.entries : [];
          const known = new Set(have.map((entry) => entry.id));
          const next: Listing = {
            entries: [...have, ...page.entries.filter((entry) => !known.has(entry.id))],
            nextBefore: page.nextBefore,
          };
          shown.current = next;
          setListing(next);
          setLoaded(true);
          setError(null);
        },
        (failure: unknown) => {
          if (alive.current && born === epoch.current) setError(failureText(failure));
        },
      )
      .finally(() => {
        inflight.current = false;
        if (!alive.current) return;
        if (born === epoch.current) setBusy(false);
        else setRestarts((count) => count + 1);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    fetchPage(false);
  }, [fetchPage, restarts]);

  const apply = useCallback(
    (value: string) => {
      const next = value.trim();
      if (next === wanted.current) return;
      wanted.current = next;
      epoch.current += 1;
      shown.current = EMPTY;
      setFilter(next);
      setListing(EMPTY);
      setLoaded(false);
      setError(null);
      fetchPage(false);
    },
    [fetchPage],
  );

  const more = listing.nextBefore !== null && listing.entries.length < MAX_ROWS;
  return {
    entries: listing.entries,
    filter,
    loaded,
    busy,
    error,
    canLoadOlder: more,
    capped: listing.nextBefore !== null && !more,
    apply,
    loadOlder: () => fetchPage(true),
    // After a failed older page the rows stay and that page is asked again; after a failed first page it starts over.
    retry: () => fetchPage(listing.entries.length > 0),
  };
}
