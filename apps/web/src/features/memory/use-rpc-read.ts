import { useEffect, useRef, useState } from "react";
import { type ClientIssue, reportClientIssue } from "../../lib/report.ts";

export type Read<T> =
  { readonly kind: "loading" } | { readonly kind: "ready"; readonly value: T } | { readonly kind: "failed" };

type Settled<T> =
  { readonly key: string; readonly value: T } | { readonly key: string; readonly failed: true };

/**
 * One read of the daemon for `key`: loading until it answers, again when `key` changes, and again when `reload()` is
 * called (the old answer stays on screen meanwhile). `enabled: false` reads nothing. A failed read is reported once and
 * shown as `failed`; `reload()` retries it.
 */
export function useRpcRead<T>(key: string, enabled: boolean, read: () => Promise<T>, issue: ClientIssue) {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [stamp, setStamp] = useState(0);
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    latest.current().then(
      (value) => {
        if (live) setSettled({ key, value });
      },
      () => {
        reportClientIssue(issue);
        if (live) setSettled({ key, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [key, enabled, stamp, issue]);
  const current = settled !== null && settled.key === key ? settled : null;
  const load: Read<T> =
    current === null
      ? { kind: "loading" }
      : "failed" in current
        ? { kind: "failed" }
        : { kind: "ready", value: current.value };
  return { load, reload: () => setStamp((value) => value + 1) };
}
