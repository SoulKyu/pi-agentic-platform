import "./register-lanes-catalog.ts";
import { Button, InlineError, LoadingLine } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { visibleLog } from "./log-text.ts";

interface Log {
  readonly text: string;
  readonly next: number | null;
  readonly size: number;
  readonly capped: boolean;
}

/** The setup log, read 256 KiB at a time and shown as plain mono text: a script's output is untrusted. */
export function ScriptLogDialog({ laneId, onClose }: { readonly laneId: string; onClose(): void }) {
  const t = useT();
  const [log, setLog] = useState<Log | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  // The first read starts from the initial `loading`, so the effect sets nothing before the answer.
  const fetchChunk = useCallback(
    (offset: number) => {
      getRuntime()
        .rpc.call("lanes.scriptLog", { laneId, kind: "setup", offset })
        .then(
          (chunk) => {
            setLog((was) => ({
              text: (offset === 0 || was === null ? "" : was.text) + visibleLog(chunk.text),
              next: chunk.nextOffset,
              size: chunk.size,
              capped: chunk.capped,
            }));
            setLoading(false);
          },
          () => {
            setFailed(true);
            setLoading(false);
          },
        );
    },
    [laneId],
  );
  useEffect(() => fetchChunk(0), [fetchChunk]);
  const read = (offset: number) => {
    setLoading(true);
    setFailed(false);
    fetchChunk(offset);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("lanes.log.title")}
      closeLabel={t("lanes.action.close")}
    >
      <div className="flex flex-col gap-s2 p-s3">
        {log !== null && log.text !== "" ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-code text-fg">
            {log.text}
          </pre>
        ) : null}
        {log !== null && log.size === 0 && !failed ? (
          <p className="text-ui text-muted">{t("lanes.log.empty")}</p>
        ) : null}
        {log?.capped === true ? <p className="text-ui text-muted">{t("lanes.log.capped")}</p> : null}
        {loading ? <LoadingLine label={t("lanes.log.loading")} /> : null}
        {failed ? (
          <div className="flex flex-col items-start gap-s2">
            <InlineError announce="background">{t("lanes.log.failed")}</InlineError>
            <Button onClick={() => read(log?.next ?? 0)}>{t("lanes.action.tryAgain")}</Button>
          </div>
        ) : null}
        {log?.next != null && !loading && !failed ? (
          <div>
            <Button onClick={() => read(log.next ?? 0)}>{t("lanes.log.loadMore")}</Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
