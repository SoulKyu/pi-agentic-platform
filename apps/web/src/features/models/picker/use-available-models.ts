import { AvailableModels } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { isStaleChunk } from "../../../lib/lazy.tsx";
import { reportClientIssue } from "../../../lib/report.ts";
import { getRuntime } from "../../../runtime/index.ts";
import { RpcError } from "../../../runtime/rpc.ts";
import { shownText, toPickerModel, type PickerModel } from "./model-picker.vm.ts";

export type AvailableState =
  | { readonly status: "loading" }
  /** `stale`: an `unknown_method` answer or a gone chunk, so the page and the daemon differ: ask for a reload. */
  | {
      readonly status: "failed";
      readonly stale: boolean;
      readonly reload: () => void;
      /** Text the owner of the data already has for the failure; the list shows its own generic line without it. */
      readonly message?: string;
    }
  | {
      readonly status: "ready";
      readonly models: readonly PickerModel[];
      readonly labels: ReadonlyMap<string, string>;
      readonly origin: "scope" | "signed-in" | "session";
      readonly truncated: boolean;
    };

type Ready = Extract<AvailableState, { status: "ready" }>;

const LOADING: AvailableState = { status: "loading" };

/** The contract's own schema, caps included: a provider count or model count past them is a failed answer. */
export function parseAvailable(raw: unknown): Ready | null {
  const parsed = AvailableModels.safeParse(raw);
  if (!parsed.success) return null;
  const labels = new Map<string, string>();
  for (const provider of parsed.data.providers) labels.set(provider.id, shownText(provider.name));
  return {
    status: "ready",
    models: parsed.data.models.map(toPickerModel),
    labels,
    origin: parsed.data.origin,
    truncated: parsed.data.truncated,
  };
}

export const isStale = (error: unknown): boolean =>
  (error instanceof RpcError && error.code === "unknown_method") || isStaleChunk(error);

/**
 * `models.available` for a folder (or none). Loads when `enabled` turns true (the list opens), every time it opens. The
 * state lives in the component (MPR19): a change of `cwd`, a close or a sign-out leaves nothing behind, and an answer
 * for another folder or another opening is dropped.
 */
export function useAvailableModels(cwd: string | null, enabled: boolean): AvailableState {
  const [attempt, setAttempt] = useState(0);
  const [wasEnabled, setWasEnabled] = useState(enabled);
  const [result, setResult] = useState<{
    readonly for: string | null;
    readonly state: AvailableState;
  } | null>(null);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) setResult(null);
  }
  const reload = useCallback(() => {
    setResult(null);
    setAttempt((count) => count + 1);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getRuntime()
      .rpc.call("models.available", cwd === null ? {} : { cwd })
      .then(
        (answer) => {
          const ready = parseAvailable(answer);
          if (ready === null) reportClientIssue("setting_load_failed");
          if (live) setResult({ for: cwd, state: ready ?? { status: "failed", stale: false, reload } });
        },
        (error: unknown) => {
          reportClientIssue("setting_load_failed");
          if (live) setResult({ for: cwd, state: { status: "failed", stale: isStale(error), reload } });
        },
      );
    return () => {
      live = false;
    };
  }, [cwd, enabled, attempt, reload]);
  return enabled && result !== null && result.for === cwd ? result.state : LOADING;
}
