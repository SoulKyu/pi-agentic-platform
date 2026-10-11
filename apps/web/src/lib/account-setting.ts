import type { SettingKey, SettingWrite } from "@pap/contracts";
import { RpcError, type Runtime } from "../runtime/index.ts";
import { reportClientIssue } from "./report.ts";

export type SaveStatus = "saving" | "saved" | "error";
export type AccountStatus = "local" | "load-error" | SaveStatus;
export type LoadResult =
  | { readonly kind: "loaded"; readonly value: unknown; readonly revision: number }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly code: string };
type Rpc = Runtime["rpc"];
type Timers = { set(fn: () => void, ms: number): number; clear(id: number): void };
const WINDOW_TIMERS: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

/** No deadline of its own: the runtime settles every call when the socket is declared dead (spec C §4.2). */
export async function loadSetting(rpc: Rpc, key: SettingKey): Promise<LoadResult> {
  try {
    const { value, revision } = await rpc.call("settings.get", { key });
    return { kind: "loaded", value, revision };
  } catch (error) {
    const code = error instanceof RpcError ? error.code : "internal";
    return code === "unknown_method" ? { kind: "unsupported" } : { kind: "failed", code };
  }
}

export interface AccountDocumentOptions<V> {
  readonly key: SettingKey;
  write(value: V, baseRevision: number): SettingWrite;
  /** Field by field; never throws. */
  parse(value: unknown): V;
  /** The names of the fields that differ (a list document is one field). */
  changed(previous: V, next: V): readonly string[];
  /** The server copy with the local values of `dirty` laid over it. */
  merge(server: V, local: V, dirty: ReadonlySet<string>): V;
  /** The value the person sees now. */
  local(): V;
  /** Puts a (merged) server copy in place; it must not come back through `change`. */
  adopt(value: V): void;
  onStatus(status: AccountStatus): void;
  readonly delayMs?: number;
  readonly timers?: Timers;
}

export interface AccountDocument<V> {
  /** A local change, already applied by the caller: saved `delayMs` later, once the document has been loaded. */
  change(previous: V, next: V): void;
  /** Each time the socket opens: read the server copy, merge the local changes over it, send them. */
  sync(rpc: Rpc): Promise<void>;
  dispose(): void;
}

type Phase = "unloaded" | "loading" | "loaded" | "load-failed" | "unsupported";

/**
 * One account document kept in step with the server by compare-and-set (owner R3-4, M3-RT-01). Nothing is sent
 * before the first load settles or after a failed one; one save at a time, from the latest revision; a conflict
 * re-reads, merges the fields changed here and retries once; any other failed save waits for the next change or
 * sync (R105); a re-sync keeps a waiting change and sends it after the reload.
 */
export function createAccountDocument<V>(options: AccountDocumentOptions<V>): AccountDocument<V> {
  const timers = options.timers ?? WINDOW_TIMERS;
  const delayMs = options.delayMs ?? 400;
  let rpc: Rpc | null = null;
  let phase: Phase = "unloaded";
  let revision = 0;
  // Bounded by the document's field names.
  let dirty = new Set<string>();
  let timer: number | null = null;
  let inFlight: Promise<void> | null = null;
  let held = false;
  let loads = 0;
  // True from the start of a sync until its own reload begins: a conflict reload ending in that window must not
  // let a change out ahead of the sync's reload.
  let syncing = false;
  let disposed = false;

  const status = (next: AccountStatus): void => {
    if (!disposed) options.onStatus(next);
  };
  const stopTimer = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  /** True when the document is loaded and may save. */
  async function load(call: Rpc): Promise<boolean> {
    const mine = ++loads;
    phase = "loading";
    const result = await loadSetting(call, options.key);
    if (disposed || mine !== loads) return false; // a newer sync owns the document now
    if (result.kind === "unsupported") {
      phase = "unsupported"; // an older daemon: the local values stay, nothing is ever sent
      status("local");
      return false;
    }
    if (result.kind === "failed") {
      phase = "load-failed";
      reportClientIssue("setting_load_failed");
      status("load-error");
      return false;
    }
    revision = result.revision;
    if (result.value !== null)
      options.adopt(options.merge(options.parse(result.value), options.local(), dirty));
    phase = "loaded";
    held = false;
    if (dirty.size === 0) status(result.value === null ? "local" : "saved");
    return true;
  }

  async function save(call: Rpc, retried: boolean): Promise<void> {
    const batch = dirty;
    dirty = new Set();
    status("saving");
    try {
      revision = (await call.call("settings.set", options.write(options.local(), revision))).revision;
      if (dirty.size === 0) status("saved");
    } catch (error) {
      for (const field of batch) dirty.add(field);
      if (disposed) return;
      if (error instanceof RpcError && error.code === "conflict" && !retried) {
        if (await load(call)) await save(call, true);
        return; // a failed reload has reported itself; nothing is sent until a later load succeeds
      }
      held = true; // R105: a failed save is never re-sent by itself
      reportClientIssue("setting_save_failed");
      status("error");
    }
  }

  function pump(): void {
    if (
      disposed ||
      inFlight !== null ||
      held ||
      syncing ||
      phase !== "loaded" ||
      rpc === null ||
      dirty.size === 0
    )
      return;
    inFlight = save(rpc, false)
      .catch(() => {
        // save() settles every failure itself; this only guards a throwing option (a bug), never silently,
        // and never lets the bound on re-sends depend on every option being total.
        held = true;
        reportClientIssue("setting_save_failed");
        status("error");
      })
      .finally(() => {
        inFlight = null;
        pump(); // a change made while the save travelled goes out now, from the new revision
      });
  }

  return {
    change(previous, next) {
      for (const field of options.changed(previous, next)) dirty.add(field);
      if (dirty.size === 0) return;
      held = false;
      if (phase !== "loaded") return; // held until the first load settles, and after a failed one
      stopTimer();
      timer = timers.set(() => {
        timer = null;
        pump();
      }, delayMs);
    },
    async sync(call) {
      rpc = call;
      stopTimer(); // a waiting change stays in `dirty` and goes out after the reload
      phase = "loading"; // the waiting change goes out only after the reload, not when the save in flight ends
      syncing = true;
      if (inFlight) await inFlight;
      syncing = false;
      if (await load(call)) pump();
    },
    dispose() {
      disposed = true;
      stopTimer();
    },
  };
}
