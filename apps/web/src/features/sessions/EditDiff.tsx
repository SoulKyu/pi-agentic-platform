import { LoadingLine } from "@pap/ui";
import { DiffView, languageFor } from "@pap/ui/code";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import "./register-tools-catalog.ts";
import { parseEdits, type EditArgs } from "../../stores/tool-summary.ts";
import type { ToolItem } from "./transcript.vm.ts";

const MAX_EDITS = 8;

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly edit: EditArgs }
  | { readonly phase: "plain" };

/**
 * An opened edit card: the full arguments come from `sessions.toolOutput`, and each edit is one diff of its old text
 * against its new. Arguments that do not parse, or a request that fails, show `fallback`, the card as it was.
 */
export function EditDiff({
  item,
  sessionId,
  fallback,
}: {
  readonly item: ToolItem;
  readonly sessionId: string;
  readonly fallback: ReactNode;
}) {
  const t = useT();
  const [state, setState] = useState<State>({ phase: "loading" });
  const { toolCallId, resultEntryId } = item;

  useEffect(() => {
    let live = true;
    const params = { sessionId, toolCallId, ...(resultEntryId ? { resultEntryId } : {}) };
    getRuntime()
      .rpc.call("sessions.toolOutput", params)
      .then(
        (result) => {
          const edit = parseEdits(result.args);
          if (live) setState(edit ? { phase: "ready", edit } : { phase: "plain" });
        },
        () => {
          if (live) setState({ phase: "plain" });
        },
      );
    return () => {
      live = false;
    };
  }, [sessionId, toolCallId, resultEntryId]);

  const edit = state.phase === "ready" ? state.edit : null;
  const language = useMemo(() => (edit ? languageFor(edit.path) : null), [edit]);
  const labels = useMemo(
    () => ({ label: t("sessions.tool.edit.diff"), noChanges: t("sessions.tool.edit.same") }),
    [t],
  );

  if (state.phase === "loading") return <LoadingLine label={t("sessions.tool.edit.loading")} />;
  if (!edit) return <>{fallback}</>;
  return (
    <div className="flex flex-col gap-s2">
      {edit.edits.slice(0, MAX_EDITS).map((pair, index) => (
        <div key={index} className="max-h-64 overflow-auto rounded-sm border border-border">
          <DiffView
            before={pair.oldText}
            after={pair.newText}
            language={language}
            labels={labels}
            onLoadError={() => reportClientIssue("lazy_chunk_failed")}
          />
        </div>
      ))}
      {edit.edits.length > MAX_EDITS ? (
        <p className="text-ui text-muted">
          {t("sessions.tool.edit.more", { count: edit.edits.length - MAX_EDITS })}
        </p>
      ) : null}
    </div>
  );
}
