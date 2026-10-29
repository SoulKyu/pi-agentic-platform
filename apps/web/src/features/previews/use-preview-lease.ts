import { type BoxRef, type PreviewView } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { previewKey, usePreviewsStore } from "../../stores/previews-store.ts";

/** A lease dies 5 minutes after its last renewal (decision 6); a pane renews every minute. */
export const RENEW_MS = 60_000;

export type LeaseState = "closed" | "open" | "restarted" | "gone";
interface Held {
  readonly lease: string;
  /** The service id the pane opened: a restart under another id is never swapped into an open pane (UX2-R77). */
  readonly id: string | null;
}
interface View {
  readonly state: LeaseState;
  readonly url: string | null;
  readonly error: string | null;
  readonly serviceId: string | null;
  /** What the stream showed of the service when an open was refused: a refusal about a box that has since started is stale. */
  readonly mark: string | null;
}

const CLOSED: View = { state: "closed", url: null, error: null, serviceId: null, mark: null };
const markOf = (service: PreviewView | undefined): string =>
  service === undefined ? "none" : `${service.id}:${service.startedAt}:${service.state}`;
const ended = (state: "gone" | "restarted", error: string | null = null): View => ({
  state,
  url: null,
  error,
  serviceId: null,
  mark: null,
});

/** What the stream says of the service a pane opened: nothing yet decides nothing (a pane never reads a missing service as gone before the first snapshot). */
function stillOpen(
  held: Held | null,
  service: PreviewView | undefined,
  ready: boolean,
): "open" | "gone" | "restarted" {
  if (!ready) return "open";
  if (service === undefined || service.state !== "running") return "gone";
  return held?.id != null && service.id !== held.id ? "restarted" : "open";
}

/**
 * UX2-R77: a preview pane's lease follows the owner's clicks. `armed` is true only when the owner's own click mounted the
 * pane; the lease mints on `open()` or on an armed mount, renews every 60 s, and is closed at unmount (best effort: it
 * dies within 5 minutes anyway), so the token caps count open panes. `box` must be stable across renders.
 */
export function usePreviewLease(box: BoxRef, name: string, armed: boolean) {
  const key = previewKey(box, name);
  const service = usePreviewsStore((state) => state.services.get(key));
  const [lost, setLost] = useState<string | null>(null);
  const [view, setView] = useState<View>(CLOSED);
  const [reloads, setReloads] = useState(0);
  const held = useRef<Held | null>(null);
  const mounted = useRef(false);
  const minting = useRef(false);

  const close = useCallback((lease: string) => {
    // Best effort: the lease dies by itself within 5 minutes, so a failed close is only logged.
    getRuntime()
      .rpc.call("previews.close", { lease })
      .catch(() => reportClientIssue("preview_close_failed"));
  }, []);
  const release = useCallback(() => {
    const was = held.current;
    held.current = null;
    if (was) close(was.lease);
  }, [close]);

  const mint = useCallback(() => {
    if (minting.current) return;
    minting.current = true;
    const { rpc } = getRuntime();
    const id = usePreviewsStore.getState().services.get(key)?.id ?? held.current?.id ?? null;
    rpc.call("previews.open", { box, name }, { commandId: rpc.newCommandId() }).then(
      ({ url, lease }) => {
        minting.current = false;
        if (!mounted.current) return close(lease);
        const old = held.current;
        held.current = { lease, id };
        if (old) close(old.lease);
        setLost(null);
        setView({ state: "open", url, error: null, serviceId: id, mark: null });
      },
      (failure: unknown) => {
        minting.current = false;
        if (!mounted.current) return;
        release();
        const code = failure instanceof RpcError ? failure.code : "internal";
        setView(
          code === "not_found"
            ? ended("gone")
            : { ...CLOSED, error: code, mark: markOf(usePreviewsStore.getState().services.get(key)) },
        );
      },
    );
  }, [box, name, key, close, release]);

  const renew = useCallback(async () => {
    const was = held.current;
    if (!was) return;
    try {
      await getRuntime().rpc.call("previews.renew", { lease: was.lease });
      if (mounted.current) setLost(null);
    } catch (failure) {
      if (!mounted.current) return;
      if (!(failure instanceof RpcError) || failure.code !== "not_found") {
        // Not a verdict on the lease (the link dropped, the daemon was busy): say so, and try again at the next renewal.
        reportClientIssue("preview_renew_failed");
        setLost(failure instanceof RpcError ? failure.code : "connection_lost");
        return;
      }
      const { services, ready } = usePreviewsStore.getState();
      const next = stillOpen(was, services.get(key), ready);
      if (next === "open") return mint(); // the same service still runs: one new open
      held.current = null;
      setView(ended(next));
    }
  }, [key, mint]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      release();
    };
  }, [release]);

  useEffect(() => {
    if (armed) mint();
  }, [armed, mint]);

  // The stream ends the pane at once: the service stopped, or a restart gave it another id.
  useEffect(
    () =>
      usePreviewsStore.subscribe((state) => {
        const was = held.current;
        if (!was) return;
        const next = stillOpen(was, state.services.get(key), state.ready);
        if (next === "open") return;
        release();
        setView(ended(next));
      }),
    [key, release],
  );

  useEffect(() => {
    if (view.state !== "open") return;
    const timer = setInterval(() => void renew(), RENEW_MS);
    return () => clearInterval(timer);
  }, [view.state, renew]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);
  // A refusal because the box was stopped is dropped once the service is another one (or none) from what it was then.
  const stale = view.error === "box_stopped" && view.mark !== markOf(service);
  return {
    state: view.state,
    url: view.url,
    error: stale ? null : view.error,
    lost,
    open: mint,
    /** Closes the lease now (a window being unloaded cannot wait for its cleanup). */
    release,
    reload,
    reloads,
  };
}
