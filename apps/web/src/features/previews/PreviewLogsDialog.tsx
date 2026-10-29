import "../../i18n/register-previews.ts";
import { SERVICE_LIMITS, type BoxRef } from "@pap/contracts";
import { Button, InlineError, LoadingLine } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useCallback, useEffect, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { cutUnits, stripHidden } from "../../lib/untrusted-text.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

// Terminal colour and cursor sequences: a service prints them, and the dialog shows plain text.
const CSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const plain = (line: string): string =>
  cutUnits(stripHidden(line.replace(CSI, "")), SERVICE_LIMITS.lineChars);

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly code: string }
  | { readonly kind: "ready"; readonly lines: readonly string[] };

interface Props {
  readonly box: BoxRef;
  readonly name: string;
  onClose(): void;
}

/**
 * A service's recent output (UX2-R44). The daemon redacts it with the owner's secrets; here every line is React text in a
 * mono block, never markup, with hidden characters and colour codes removed. Read on open and on REFRESH, never by timer.
 */
export function PreviewLogsDialog({ box, name, onClose }: Props) {
  const t = useT();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const { kind, id } = box;
  const fetchLogs = useCallback(() => {
    getRuntime()
      .rpc.call("previews.logs", { box: { kind, id } as BoxRef, name })
      .then(
        ({ lines }) => setLoad({ kind: "ready", lines: lines.slice(0, SERVICE_LIMITS.logLines).map(plain) }),
        (failure: unknown) =>
          setLoad({ kind: "error", code: failure instanceof RpcError ? failure.code : "internal" }),
      );
  }, [kind, id, name]);
  useEffect(fetchLogs, [fetchLogs]);
  const refresh = () => {
    setLoad({ kind: "loading" });
    fetchLogs();
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("previews.logs.title", { name })}
      closeLabel={t("ui.close")}
      footer={
        <Button variant="secondary" onClick={refresh} disabled={load.kind === "loading"}>
          {t("previews.logs.refresh")}
        </Button>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        {load.kind === "loading" ? <LoadingLine label={t("app.loading")} /> : null}
        {load.kind === "error" ? <InlineError announce="action">{t(errorKey(load.code))}</InlineError> : null}
        {load.kind === "ready" && load.lines.length === 0 ? (
          <p className="text-ui text-muted">{t("previews.logs.empty")}</p>
        ) : null}
        {load.kind === "ready" && load.lines.length > 0 ? (
          <div
            data-preview-logs=""
            className="max-h-96 overflow-auto rounded-sm bg-surface p-s2 font-mono text-code text-fg"
          >
            {load.lines.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
