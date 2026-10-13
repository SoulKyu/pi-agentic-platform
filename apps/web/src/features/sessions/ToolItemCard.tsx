import { Button, Fence, ToolCard, type ToolDetail, type ToolStatus } from "@pap/ui";
import { useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { codeText, failureCode } from "./failure.ts";
import { splitFences, stripFenceMarkers, type FencePart } from "./fence.vm.ts";
import "./register-policy-catalog.ts";
import type { ToolItem } from "./transcript.vm.ts";

const BYTES_PER_KB = 1024;

type Output =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly text: string; readonly args: string | null }
  | { readonly state: "failed"; readonly code: string };

const PRE = "max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-fg";
const CARD_STATUS = {
  running: "running",
  done: "done",
  failed: "error",
  waiting: "done",
} as const satisfies Record<ToolItem["status"], ToolStatus>;

/** A tool call as a card: the account's detail setting decides whether it opens, and the whole output is one request away. */
export function ToolItemCard({
  item,
  sessionId,
  detail,
}: {
  item: ToolItem;
  sessionId: string;
  /** Settings › Appearance › tool card detail: the account's setting, given by the shell. */
  detail: ToolDetail;
}) {
  const t = useT();
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
  // The whole output may hold pap's fences; the clipped preview may hold only one end of one, so it is stripped instead.
  // Without a cut (`whole === null`) the preview is the complete output, so it is split too.
  const complete = loaded ? loaded.text : whole === null ? item.preview : null;
  const parts: readonly FencePart[] = complete === null ? [] : splitFences(complete);
  const fenced = parts.some((part) => part.kind === "fenced");
  const shown = complete ?? stripFenceMarkers(item.preview);
  const offerAll = whole !== null && !loaded;
  const showArgs = loaded?.args && item.argsTruncated;
  return (
    <ToolCard
      name={item.name}
      summary={item.summary}
      status={CARD_STATUS[item.status]}
      detail={detail}
      statusLabel={t(`sessions.tool.${item.status}`)}
      runningLabel={t("sessions.tool.running")}
      failedLabel={t("sessions.tool.failed")}
      footer={
        showArgs || offerAll || fenced ? (
          <div className="flex flex-col gap-s1">
            {fenced
              ? parts.map((part, index) =>
                  part.kind === "fenced" ? (
                    <Fence key={index} label={t("sessionPolicy.fence", { source: part.source })}>
                      {part.text}
                    </Fence>
                  ) : part.text.trim() === "" ? null : (
                    <pre key={index} className={PRE}>
                      {part.text}
                    </pre>
                  ),
                )
              : null}
            {showArgs ? <pre className={PRE}>{loaded.args}</pre> : null}
            {offerAll ? (
              <div className="flex flex-wrap items-center gap-s2">
                {item.omittedBytes !== null ? (
                  <p className="text-ui text-muted">{t("sessions.tool.tooLarge")}</p>
                ) : null}
                {output.state === "failed" ? (
                  output.code === "not_found" ? (
                    <p role="status" className="text-ui text-muted">
                      {t("sessions.tool.notYet")}
                    </p>
                  ) : (
                    <p role="alert" className="text-ui text-attn">
                      {codeText(output.code)}
                    </p>
                  )
                ) : null}
                <Button disabled={output.state === "loading"} onClick={() => void load()}>
                  {output.state === "failed"
                    ? t("sessions.tool.retry")
                    : t("sessions.tool.showAll", { size })}
                </Button>
              </div>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {fenced ? undefined : shown || undefined}
    </ToolCard>
  );
}
