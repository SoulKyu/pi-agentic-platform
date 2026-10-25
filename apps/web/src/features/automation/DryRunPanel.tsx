import type { DryRunResult } from "@pap/contracts";
import { AUTOMATION_WRITE_TOOLS } from "@pap/contracts";
import { Button, Chip, cn, Heading, InlineError, TextField, usePendingAction } from "@pap/ui";
import { useState, type ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { escapeHiddenKeepLines } from "../../lib/escape-hidden.ts";
import { getRuntime } from "../../runtime/index.ts";
import { shown } from "./board.vm.ts";
import { budgetLine, precheckLine, profileLine, splitPrompt, trustKey, verdictText } from "./dry-run.vm.ts";
import { modeNoteKey, type InputResult, type SourceType } from "./editor.vm.ts";
import { IsolatedProfile } from "./IsolatedProfile.tsx";
import { UntrustedFence } from "./UntrustedFence.tsx";
import { useTrustStatus } from "./use-trust-status.ts";

interface DryRunPanelProps {
  readonly input: InputResult;
  readonly sourceType: SourceType;
  /** The saved trigger's id: the daemon runs its precheck only when the draft keeps the saved command, folder and names. */
  readonly savedId: string | null;
  /** The person asked for a dry-run of a draft the contract refuses: the form shows its errors. */
  onInvalid(): void;
}

function TrustedFolder({ cwd }: { readonly cwd: string }) {
  const t = useT();
  const status = useTrustStatus(cwd);
  const path = shown(cwd, "detail");
  return (
    <span className="break-all font-mono text-code">
      {status === null ? path : t(trustKey(status), { cwd: path })}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-s3">
      <dt className="label-hud w-24 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-ui text-fg">{children}</dd>
    </div>
  );
}

function Result({
  result,
  dedupMinutes,
  isolated,
}: {
  readonly result: DryRunResult;
  readonly dedupMinutes: number | null;
  readonly isolated: boolean;
}) {
  const t = useT();
  const precheck = precheckLine(result.precheck);
  const writes = result.tools.some((tool) => (AUTOMATION_WRITE_TOOLS as readonly string[]).includes(tool));
  return (
    <>
      <div
        data-slot="dry-run-verdict"
        className={cn(
          "flex flex-col gap-s1 rounded-md border p-s2",
          result.verdict === "fire" ? "border-ok" : "border-attn",
        )}
      >
        <p className="text-ui text-fg">{verdictText(result)}</p>
        <ul className="flex flex-col gap-s1 text-ui text-muted">
          {dedupMinutes === null ? null : <li>{t("automation.dry.dedup", { minutes: dedupMinutes })}</li>}
          {precheck === null ? null : <li>{precheck.line}</li>}
          <li>{budgetLine(result.budget)}</li>
        </ul>
        {precheck?.output ? (
          <UntrustedFence source="precheck" text={precheck.output.split("\n")[0] ?? ""} />
        ) : null}
      </div>
      <dl className="flex flex-col gap-s1">
        <Row label={t("automation.dry.tools")}>{result.tools.join(", ")}</Row>
        <Row label={t("automation.dry.profile")}>
          <span>{profileLine(result.profile)}</span>
          {isolated ? <IsolatedProfile /> : null}
          {writes ? <p className="text-muted">{t(modeNoteKey(result.profile.mode))}</p> : null}
          {result.profile.editsUnasked ? (
            <p className="text-attn">{t("automation.dry.editsUnasked")}</p>
          ) : null}
        </Row>
        <Row label={t("automation.dry.cwd")}>
          <TrustedFolder cwd={result.cwd} />
        </Row>
        <Row label={t("automation.dry.tokens")}>{t("automation.dry.tokensNone")}</Row>
      </dl>
      {result.feed === null ? null : <p className="text-ui text-muted">{t("automation.dry.feedNote")}</p>}
      <div className="flex flex-col gap-s2">
        <span className="label-hud text-muted">{t("automation.dry.prompt")}</span>
        {splitPrompt(result.prompt).map((part, index) =>
          part.kind === "text" ? (
            <p key={index} className="whitespace-pre-wrap break-words font-mono text-code text-fg">
              {escapeHiddenKeepLines(part.text)}
            </p>
          ) : (
            <UntrustedFence key={index} source={part.source} text={part.text} />
          ),
        )}
      </div>
      <p className="text-ui text-muted">{t("automation.dry.fenceNote")}</p>
    </>
  );
}

/** The right half of board 11 §1: the sample payload, "Dry-run" on the unsaved draft, and what a fire would do, nothing written. */
export function DryRunPanel({ input, sourceType, savedId, onInvalid }: DryRunPanelProps) {
  const t = useT();
  const [payload, setPayload] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "invalid" }
    | { kind: "failed" }
    | { kind: "done"; stamp: string; result: DryRunResult }
  >({ kind: "idle" });
  const pending = usePendingAction();
  const stamp = JSON.stringify([input.ok ? input.input : null, payload, savedId]);

  // An answer is about the draft that was sent: one edit later it is no longer shown as the verdict.
  const result = state.kind === "done" && state.stamp === stamp ? state.result : null;
  const agent = input.ok ? input.input.execution.agent : null;
  const payloadHidden = sourceType === "schedule" || agent?.target === "thread";
  const dedup = input.ok && input.input.source.type === "webhook" ? input.input.source.dedupMinutes : null;

  const run = () => {
    if (!input.ok) {
      setState({ kind: "invalid" });
      onInvalid();
      return;
    }
    const sent = stamp;
    const params = {
      ...(savedId === null ? {} : { triggerId: savedId }),
      draft: input.input,
      ...(payload === "" || payloadHidden ? {} : { payload }),
    };
    void pending.run(async () => {
      try {
        setState({
          kind: "done",
          stamp: sent,
          result: await getRuntime().rpc.call("automation.dryRun", params),
        });
      } catch {
        setState({ kind: "failed" });
      }
    });
  };

  return (
    <section
      data-slot="dry-run"
      className="flex flex-col gap-s3 rounded-md border border-border-strong bg-bg-side p-s3"
    >
      <div className="flex items-center gap-s2">
        <Heading level={3} variant="card" tone="agent">
          {t("automation.dry.title")}
        </Heading>
        <Chip tone="mut" label={t("automation.dry.nothingWritten")} />
      </div>
      {payloadHidden ? null : (
        <TextField
          multiline
          mono
          rows={5}
          label={t("automation.dry.payload")}
          value={payload}
          onChange={setPayload}
        />
      )}
      <div>
        <Button variant="primary" pendingSince={pending.since} onClick={run}>
          {t("automation.dry.run")}
        </Button>
      </div>
      {state.kind === "invalid" && !input.ok ? (
        <InlineError announce="action">{t("automation.dry.invalid")}</InlineError>
      ) : null}
      {state.kind === "failed" ? (
        <InlineError announce="action">{t("automation.dry.failed")}</InlineError>
      ) : null}
      {result === null ? null : (
        <Result result={result} dedupMinutes={dedup} isolated={agent?.target === "isolated"} />
      )}
    </section>
  );
}
