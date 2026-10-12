import { Button } from "@pap/ui";
import { useRef, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { codeText, failureCode } from "./failure.ts";
import type { ToolItem } from "./transcript.vm.ts";

const BYTES_PER_KB = 1024;

type Output =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly text: string; readonly args: string | null }
  | { readonly state: "failed"; readonly code: string };

const PRE = "mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-ui text-fg";

export function ToolRow({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const [output, setOutput] = useState<Output>({ state: "idle" });
  const inFlight = useRef(false);

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOutput({ state: "loading" });
    const params = {
      sessionId,
      toolCallId: item.toolCallId,
      ...(item.resultEntryId ? { resultEntryId: item.resultEntryId } : {}),
    };
    try {
      const result = await getRuntime().rpc.call("sessions.toolOutput", params);
      setOutput({ state: "loaded", text: result.text, args: result.args });
    } catch (failure) {
      setOutput({ state: "failed", code: failureCode(failure) });
    }
    inFlight.current = false;
  };

  const whole = item.truncatedChars ?? item.omittedBytes;
  const size = Math.max(1, Math.round((whole ?? 0) / BYTES_PER_KB));
  const loaded = output.state === "loaded" ? output : null;
  return (
    <article data-tool data-status={item.status} className="rounded-sm border border-line bg-bg px-3 py-2">
      <header className="flex items-baseline gap-2">
        <span className="font-mono text-label font-semibold uppercase tracking-label text-agent">
          {item.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-ui text-muted">{item.summary}</span>
        <span className="text-label text-muted">{t(`sessions.tool.${item.status}`)}</span>
      </header>
      {loaded?.args && item.argsTruncated ? <pre className={PRE}>{loaded.args}</pre> : null}
      {loaded ? (
        <pre className={PRE}>{loaded.text}</pre>
      ) : item.preview ? (
        <pre className={PRE}>{item.preview}</pre>
      ) : null}
      {whole !== null && !loaded ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {item.omittedBytes !== null ? (
            <p className="text-ui text-muted">{t("sessions.tool.tooLarge")}</p>
          ) : null}
          {output.state === "failed" ? (
            output.code === "not_found" ? (
              <p role="status" className="text-ui text-muted">
                {t("sessions.tool.notYet")}
              </p>
            ) : (
              <p role="alert" className="text-ui text-attention">
                {codeText(output.code)}
              </p>
            )
          ) : null}
          <Button disabled={output.state === "loading"} onClick={() => void load()}>
            {output.state === "failed" ? t("sessions.tool.retry") : t("sessions.tool.showAll", { size })}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
