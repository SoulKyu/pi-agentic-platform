import "../../i18n/register-launch.ts";
import type { BoxRef } from "@pap/contracts";
import { InlineError, LoadingLine } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useEffect, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

type Log =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly lines: readonly string[] }
  | { readonly kind: "failed"; readonly code: string };

/** The last lines of the image build, redacted by the daemon: read once when the dialog opens. */
export default function LaunchLogDialog({ box, onClose }: { readonly box: BoxRef; onClose(): void }) {
  const t = useT();
  const [log, setLog] = useState<Log>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("launches.log", { box })
      .then(
        (answer) => live && setLog({ kind: "ready", lines: answer.lines }),
        (failure: unknown) =>
          live && setLog({ kind: "failed", code: failure instanceof RpcError ? failure.code : "internal" }),
      );
    return () => {
      live = false;
    };
  }, [box]);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("launch.title.build")}
      closeLabel={t("ui.close")}
    >
      <div data-launch-log="" className="max-h-96 overflow-auto p-s3">
        {log.kind === "loading" ? (
          <LoadingLine label={t("launch.log.loading")} deferred={false} />
        ) : log.kind === "failed" ? (
          <InlineError announce="background">{t(errorKey(log.code))}</InlineError>
        ) : log.lines.length === 0 ? (
          <p className="text-ui text-muted">{t("launch.log.empty")}</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-label text-fg">
            {log.lines.join("\n")}
          </pre>
        )}
      </div>
    </Dialog>
  );
}
