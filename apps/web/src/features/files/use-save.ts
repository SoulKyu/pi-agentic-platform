import type { FileMeta } from "@pap/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import type { Buffer } from "./use-buffers.ts";
import type { OpenFile } from "./use-open-file.ts";

/**
 * Runs a save that may need the password: `run` calls `attempt`, and on `step_up_required` asks once and calls it
 * again with the same `commandId` (R124). The shell builds it from the auth feature; features never import each other.
 */
export interface StepUp {
  run<T>(attempt: (commandId: string) => Promise<T>, commandId: string): Promise<T>;
  readonly prompt: ReactNode;
}

export const NO_STEP_UP: StepUp = { run: (attempt, commandId) => attempt(commandId), prompt: null };

export type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  /** The save needs the person's "Save anyway?" first; `baseEtag` is what it will be written against. */
  | { readonly kind: "ask"; readonly baseEtag: string | null }
  | { readonly kind: "conflict" }
  | { readonly kind: "unknown" }
  | { readonly kind: "tooLarge" }
  | { readonly kind: "stepUpCancelled" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

/** A frame over 1 MiB closes the socket for every stream on it (M8R26): a text is refused well before that. */
const FRAME_SOFT_LIMIT_BYTES = 900_000;
const encoder = new TextEncoder();
const frameBytes = (text: string): number => encoder.encode(JSON.stringify(text)).byteLength;

/** The etag the daemon gives a text: the first 32 hex digits of its SHA-256. Null where the page cannot hash (not a secure context). */
async function etagOf(text: string): Promise<string | null> {
  const subtle = globalThis.isSecureContext ? globalThis.crypto?.subtle : undefined;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Files with a write on its way: a viewer remounted mid-save (tab left and reopened) must not start a second one. */
const saving = new Set<string>();

const codeOf = (failure: unknown): string => (failure instanceof RpcError ? failure.code : "internal");

export interface SaveInput {
  readonly path: string;
  readonly file: OpenFile;
  readonly buffer: Buffer | undefined;
  readonly stepUp: StepUp;
  /** The edit is saved or thrown away. */
  drop(path: string): void;
}

export interface Save {
  readonly state: SaveState;
  /** The Reload question is open. */
  readonly reloading: boolean;
  /** The disk holds another version than the one the edit started from. */
  readonly conflicted: boolean;
  /** `text` is what the editor holds right now (Mod-s); without it, the committed draft. */
  save(text?: string): void;
  confirmAsk(): void;
  cancelAsk(): void;
  overwrite(): void;
  askReload(): void;
  cancelReload(): void;
  confirmReload(): void;
}

/** Saving one file: the write, and what its answers mean (conflict, protected file, size, unknown outcome). */
export function useSave({ path, file, buffer, stepUp, drop }: SaveInput): Save {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [reloading, setReloading] = useState(false);
  const [moved, setMoved] = useState(false);
  const alive = useRef(true);
  const [stale, setStale] = useState(false);
  const latest = useRef({ file, buffer, stepUp });
  useEffect(() => {
    latest.current = { file, buffer, stepUp };
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const set = (next: SaveState) => {
    if (alive.current) setState(next);
  };

  const finish = (saved: FileMeta, text: string) => {
    drop(path);
    latest.current.file.replace(saved, text);
    setMoved(false);
    setStale(false);
    set({ kind: "saved" });
  };

  const verify = async (text: string) => {
    try {
      const answer = await getRuntime().rpc.call("files.read", { path, offset: 0 });
      const hash = await etagOf(text);
      if (hash !== null && answer.meta.etag === hash) finish(answer.meta, text);
      else set({ kind: "unknown" });
    } catch {
      set({ kind: "unknown" }); // the person is told; nothing is sent again
    }
  };

  const failed = async (failure: unknown, text: string, baseEtag: string | null) => {
    const code = codeOf(failure);
    if (code === "conflict") {
      setStale(true);
      set({ kind: "conflict" });
    } else if (code === "protected_path") set({ kind: "ask", baseEtag });
    else if (code === "step_up_required") set({ kind: "stepUpCancelled" });
    else if (code === "payload_too_large") set({ kind: "tooLarge" });
    else if (code === "not_found") set({ kind: "gone" });
    else if (code === "timeout" || code === "connection_lost") await verify(text);
    else set({ kind: "failed" });
  };

  const send = async (text: string, baseEtag: string | null, confirmProtected: boolean) => {
    if (saving.has(path)) return; // a second Mod-s while the first is on its way
    saving.add(path);
    const { rpc } = getRuntime();
    set({ kind: "saving" });
    try {
      const answer = await latest.current.stepUp.run(
        (commandId) =>
          rpc.call(
            "files.write",
            { path, text, baseEtag, ...(confirmProtected ? { confirmProtected: true as const } : {}) },
            { commandId },
          ),
        rpc.newCommandId(),
      );
      finish(answer.meta, text);
    } catch (failure) {
      await failed(failure, text, baseEtag);
    } finally {
      saving.delete(path);
    }
  };

  const request = (baseEtag: string | null, confirmed: boolean, given?: string) => {
    const { buffer: edit, file: open } = latest.current;
    const text = given ?? edit?.draft;
    if (text === undefined) return;
    if (given !== undefined && given === (edit?.baseText ?? open.text)) return; // nothing was changed
    if (frameBytes(text) > FRAME_SOFT_LIMIT_BYTES) {
      set({ kind: "tooLarge" });
      return;
    }
    const protection = latest.current.file.meta?.protection ?? "none";
    if (protection !== "none" && !confirmed) {
      set({ kind: "ask", baseEtag });
      return;
    }
    send(text, baseEtag, confirmed).catch(() => set({ kind: "failed" }));
  };

  // A window that comes back to the front: a clean file that moved on disk is read again, a dirty one is a conflict.
  useEffect(() => {
    const onFocus = () => {
      const { file: open, buffer: edit } = latest.current;
      const known = open.meta;
      if (known === null || open.status !== "ready") return;
      getRuntime()
        .rpc.call("files.read", { path, offset: 0 })
        .then((answer) => {
          if (!alive.current) return;
          const current = latest.current;
          if (current.buffer === undefined) {
            const same = answer.meta.mtimeMs === known.mtimeMs && answer.meta.etag === known.etag;
            if (!same && current.file.meta === known) current.file.reload();
          } else if (answer.meta.etag !== edit?.baseEtag) setMoved(true);
        })
        .catch(() => reportClientIssue("file_check_failed"));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [path]);

  const staleBase = buffer !== undefined && file.meta !== null && buffer.baseEtag !== file.meta.etag;

  return {
    state,
    reloading,
    conflicted: (stale || moved || staleBase) && state.kind !== "saving",
    save: (text) =>
      request(latest.current.buffer?.baseEtag ?? latest.current.file.meta?.etag ?? null, false, text),
    confirmAsk: () => {
      if (state.kind === "ask") request(state.baseEtag, true);
    },
    cancelAsk: () => set({ kind: "idle" }),
    overwrite: () => {
      set({ kind: "saving" });
      getRuntime()
        .rpc.call("files.read", { path, offset: 0 })
        .then(
          (answer) => {
            if (answer.meta.etag === null) set({ kind: "failed" });
            else request(answer.meta.etag, false);
          },
          (failure: unknown) => set({ kind: codeOf(failure) === "not_found" ? "gone" : "failed" }),
        );
    },
    askReload: () => setReloading(true),
    cancelReload: () => setReloading(false),
    confirmReload: () => {
      drop(path);
      setReloading(false);
      setMoved(false);
      setStale(false);
      set({ kind: "idle" });
      latest.current.file.reload();
    },
  };
}
