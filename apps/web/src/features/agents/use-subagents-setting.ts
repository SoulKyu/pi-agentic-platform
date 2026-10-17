import { AgentsSettings } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

type Subagents = AgentsSettings["subagents"];
type Read =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly doc: AgentsSettings; readonly revision: number };

export interface SubagentsSetting {
  /** Null until the document was read, and after a read that failed: the controls are not offered then. */
  readonly value: Subagents | null;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly notice: string | null;
  change(patch: Partial<Subagents>): void;
}

/**
 * The `subagents` part of the owner's `agents` account document (M11R155), through `settings.get` / `settings.set` with the
 * revision it read (compare-and-set). The whole document is written back, so the new-agent defaults beside it are kept.
 * Nothing is shown as changed until the daemon accepted it; a conflict reads the document again.
 */
export function useSubagentsSetting(): SubagentsSetting {
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("settings.get", { key: "agents" })
      .then(
        (answer) => {
          if (!current) return;
          const parsed = AgentsSettings.safeParse(answer.value ?? {});
          if (!parsed.success) reportClientIssue("setting_load_failed");
          setRead(
            parsed.success
              ? { kind: "ready", doc: parsed.data, revision: answer.revision }
              : { kind: "failed" },
          );
        },
        () => {
          if (!current) return;
          reportClientIssue("setting_load_failed");
          setRead({ kind: "failed" });
        },
      );
    return () => {
      current = false;
    };
  }, [loads]);

  const change = useCallback(
    (patch: Partial<Subagents>) => {
      if (busy || read.kind !== "ready") return;
      const doc: AgentsSettings = { ...read.doc, subagents: { ...read.doc.subagents, ...patch } };
      setBusy(true);
      setNotice(null);
      const rpc = getRuntime().rpc;
      rpc
        .call(
          "settings.set",
          { key: "agents", value: doc, baseRevision: read.revision },
          { commandId: rpc.newCommandId() },
        )
        .then(
          (answer) => setRead({ kind: "ready", doc, revision: answer.revision }),
          (failure: unknown) => {
            if (failure instanceof RpcError && failure.code === "conflict") {
              setNotice(t("subagents.settings.conflict"));
              setLoads((count) => count + 1);
            } else {
              reportClientIssue("setting_save_failed");
              setNotice(t("subagents.settings.saveFailed"));
            }
          },
        )
        .finally(() => setBusy(false));
    },
    [busy, read],
  );

  return {
    value: read.kind === "ready" ? read.doc.subagents : null,
    failed: read.kind === "failed",
    busy,
    notice,
    change,
  };
}
