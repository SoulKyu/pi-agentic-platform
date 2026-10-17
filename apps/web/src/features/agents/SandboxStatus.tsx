import "./register-agent-catalog.ts";
import { Button, usePendingAction, usePendingFeedback } from "@pap/ui";
import { useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { EgressLine } from "./SandboxLine.tsx";
import type { RecheckOutcome, SandboxControl } from "./use-sandbox-status.ts";

const SEES = ["thread", "task", "home"] as const;
const GAPS = ["worker", "fileTools", "network", "proc", "threadReach", "tools"] as const;
const NOTICES: Readonly<Record<RecheckOutcome, MessageKey | null>> = {
  ok: null,
  rate_limited: "agentsSandbox.rateLimited",
  failed: "agentsSandbox.recheckFailed",
};

/**
 * Settings › Agents › Sandbox (M11R97): where bubblewrap is, or why it cannot be used in plain words, "Check again", what
 * an agent's shell sees and what the sandbox does not cover. "Checking" shows from the first probe, or once a re-check
 * has taken more than a second (DESIGN §7.3, local timing).
 */
export function SandboxStatus({ sandbox }: { readonly sandbox: SandboxControl }) {
  const t = useT();
  const pending = usePendingAction();
  const phase = usePendingFeedback(pending.since, { remote: false });
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const { status } = sandbox;
  const checking =
    phase === "spinner" ||
    phase === "stage" ||
    (status.checkedAt === 0 && !sandbox.readFailed && !sandbox.slow);
  const reason = status.reason ?? "missing";
  const line = checking ? (
    t("agentsSandbox.checking")
  ) : sandbox.readFailed && status.checkedAt === 0 ? (
    t("agentsSandbox.readFailed")
  ) : sandbox.slow ? (
    t("agentsSandbox.slow")
  ) : status.usable ? (
    t("agentsSandbox.usable", { path: status.path ?? "" })
  ) : (
    <>
      {t("agentsSandbox.unusable")} {t(`agentsSandbox.reason.${reason}`)}
      {reason === "missing" ? (
        <>
          {" "}
          <code className="font-mono text-fg">{t("agentsSandbox.reason.missing.command")}</code>
        </>
      ) : null}
    </>
  );
  const bad = !checking && (sandbox.readFailed || !status.usable) && status.checkedAt !== 0;
  const slow = !checking && sandbox.slow;
  const recheck = () =>
    void pending.run(async () => {
      setNotice(null);
      setNotice(NOTICES[await sandbox.recheck()]);
    });
  return (
    <section
      data-slot="agents-sandbox"
      aria-labelledby="agents-sandbox-title"
      className="flex flex-col gap-s3"
    >
      <h3 id="agents-sandbox-title" className="label-hud text-fg">
        {t("agentsSandbox.title")}
      </h3>
      <p
        role="status"
        data-probe={checking ? "checking" : status.usable ? "usable" : "unusable"}
        className={bad || slow || (sandbox.readFailed && !checking) ? "text-ui text-attn" : "text-ui text-fg"}
      >
        {line}
      </p>
      <EgressLine probe={status} />
      <div className="flex flex-wrap items-center gap-s2">
        <Button
          remote={false}
          pendingSince={pending.since}
          stageLabel={t("agentsSandbox.rechecking")}
          onClick={recheck}
        >
          {t("agentsSandbox.recheck")}
        </Button>
        {notice === null ? null : (
          <span role="status" className="text-ui text-attn">
            {t(notice)}
          </span>
        )}
      </div>
      <div data-slot="sandbox-sees" className="flex flex-col gap-s1">
        <h4 className="label-hud text-muted">{t("agentsSandbox.sees.title")}</h4>
        <ul className="flex list-disc flex-col gap-s1 pl-s4 text-ui text-muted">
          {SEES.map((which) => (
            <li key={which}>{t(`agentsSandbox.sees.${which}`)}</li>
          ))}
        </ul>
      </div>
      <div data-slot="sandbox-gaps" className="flex flex-col gap-s1">
        <h4 className="label-hud text-muted">{t("agentsSandbox.gaps.title")}</h4>
        <ul className="flex list-disc flex-col gap-s1 pl-s4 text-ui text-muted">
          {GAPS.map((gap) => (
            <li key={gap}>{t(`agentsSandbox.gaps.${gap}`)}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
