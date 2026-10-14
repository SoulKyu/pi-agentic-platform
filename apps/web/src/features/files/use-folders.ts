import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useVcs } from "../../stores/vcs-store.ts";
import { remember, remembered } from "./folder-memory.ts";
import { touchExpanded, type Folder } from "./files.vm.ts";

/** Listings kept at once: the open folders (at most MAX_EXPANDED) and the last few closed ones; older closed ones go. */
const MAX_LISTED = 40;

function put(
  current: ReadonlyMap<string, Folder>,
  path: string,
  folder: Folder,
  keep: ReadonlySet<string>,
): ReadonlyMap<string, Folder> {
  const next = new Map(current);
  next.delete(path);
  next.set(path, folder);
  for (const stale of next.keys()) {
    if (next.size <= MAX_LISTED) break;
    if (!keep.has(stale) && stale !== path) next.delete(stale);
  }
  return next;
}

export interface Folders {
  readonly expanded: readonly string[];
  /** Listings by folder path; a folder asked for and not yet answered is absent. */
  readonly folders: ReadonlyMap<string, Folder>;
  toggle(path: string): void;
  refresh(): void;
}

/**
 * The listings of one root and its open folders. A folder loads when it opens (`files.list`, once); all of them load
 * again when the root's vcs status moves (`status.at`), on window focus and on `refresh()`. An answer of an older
 * request round is dropped.
 */
export function useFolders(root: string, showIgnored: boolean): Folders {
  const [expanded, setExpanded] = useState<readonly string[]>(() => remembered.get(root) ?? []);
  const [folders, setFolders] = useState<ReadonlyMap<string, Folder>>(new Map());
  const [round, setRound] = useState(0);
  const asked = useRef({ round: "", paths: new Set<string>(), inflight: new Set<string>() });
  const live = useRef("");
  const open = useRef(new Set<string>());

  const statusAt = useVcs(root)?.at;
  const previousAt = useRef(statusAt);
  useEffect(() => {
    if (previousAt.current !== undefined && statusAt !== undefined) {
      setRound((count) => count + 1);
    }
    previousAt.current = statusAt;
  }, [statusAt]);

  useEffect(() => {
    const onFocus = () => setRound((count) => count + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    const id = `${root}|${showIgnored}|${round}`;
    live.current = id;
    open.current = new Set([root, ...expanded]);
    if (asked.current.round !== id) asked.current = { round: id, paths: new Set(), inflight: new Set() };
    const { rpc } = getRuntime();
    const asking = asked.current;
    for (const path of [root, ...expanded]) {
      // Asked this round and answered, but the listing was evicted since: it is asked again.
      if (asking.inflight.has(path) || (asking.paths.has(path) && folders.has(path))) continue;
      asking.paths.add(path);
      asking.inflight.add(path);
      rpc.call("files.list", { path, showIgnored }).then(
        (answer) => {
          asking.inflight.delete(path);
          if (live.current !== id) return;
          const folder: Folder = { status: "ready", entries: answer.entries, truncated: answer.truncated };
          setFolders((current) => put(current, path, folder, open.current));
        },
        (failure: unknown) => {
          asking.inflight.delete(path);
          if (live.current !== id) return;
          const code = failure instanceof RpcError ? failure.code : "internal";
          const folder: Folder = { status: "error", code, entries: [], truncated: false };
          setFolders((current) => put(current, path, folder, open.current));
        },
      );
    }
  }, [root, showIgnored, round, expanded, folders]);

  useEffect(
    () => () => {
      live.current = "";
    },
    [],
  );

  const toggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = current.includes(path)
          ? current.filter((entry) => entry !== path)
          : touchExpanded(current, path);
        remember(root, next);
        return next;
      });
    },
    [root],
  );
  const refresh = useCallback(() => setRound((count) => count + 1), []);
  return { expanded, folders, toggle, refresh };
}
