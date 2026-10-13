import { APPROVAL_MODES, type ApprovalMode, type SessionPolicyView } from "@pap/contracts";
import { Button, Chip, cn, FOCUS_RING, Select } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import "./register-policy-catalog.ts";
import { useAction } from "./use-action.ts";

type Choice = ApprovalMode | "default";
type Asking = "full-access" | "clear" | null;

/** An inline question: Escape closes it and nothing else, so it can never reach the page's Escape-to-Stop. */
function Ask(props: {
  readonly question: string;
  readonly confirm: string;
  readonly busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={props.question}
      data-inline-edit
      className="flex flex-col items-start gap-s2"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        props.onCancel();
      }}
    >
      <p className="text-ui text-fg">{props.question}</p>
      <div className="flex gap-s2">
        <Button variant="primary" disabled={props.busy} onClick={props.onConfirm}>
          {props.confirm}
        </Button>
        <Button onClick={props.onCancel}>{t("sessionPolicy.cancel")}</Button>
      </div>
    </div>
  );
}

/**
 * The session's approval mode and its external-content taint, read from the view (snapshot and `policy` events), never
 * from a fetch of its own. Full access and Clear ask first; every outcome, good or bad, is said here.
 */
export function SessionPolicy({
  sessionId,
  policy,
}: {
  readonly sessionId: string;
  readonly policy: SessionPolicyView;
}) {
  const t = useT();
  const runtime = getRuntime();
  const root = useRef<HTMLElement | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const setMode = useAction();
  const clearTaint = useAction();

  // A cleared (or never set) taint leaves no question behind: a later taint must not bring the old one back.
  if (!policy.tainted && asking === "clear") setAsking(null);
  const focus = (selector: string) =>
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(selector)?.focus());
  const forget = () => {
    setOutcome(null);
    setMode.clear();
    clearTaint.clear();
  };
  const cancel = () => {
    const was = asking;
    setAsking(null);
    focus(was === "clear" ? "[data-policy-clear]" : '[role="combobox"]');
  };

  const send = async (mode: ApprovalMode | null) => {
    forget();
    const saved = await setMode.run(() =>
      runtime.rpc.call(
        "policy.setSessionMode",
        { sessionId, mode },
        { commandId: runtime.rpc.newCommandId() },
      ),
    );
    setAsking(null);
    if (saved) setOutcome(t("sessionPolicy.modeSaved"));
    focus('[role="combobox"]');
  };
  const clear = async () => {
    forget();
    const cleared = await clearTaint.run(() =>
      runtime.rpc.call("policy.clearTaint", { sessionId }, { commandId: runtime.rpc.newCommandId() }),
    );
    setAsking(null);
    if (cleared) setOutcome(t("sessionPolicy.cleared"));
    focus('[role="combobox"]');
  };
  const choose = (choice: Choice) => {
    forget();
    if (choice === "full-access") setAsking("full-access");
    else void send(choice === "default" ? null : choice);
  };

  const named = (mode: ApprovalMode) => t(`sessionPolicy.mode.${mode}`);
  const options = [
    {
      value: "default" as Choice,
      label: policy.explicit
        ? t("sessionPolicy.mode.default")
        : t("sessionPolicy.mode.defaultNamed", { mode: named(policy.mode) }),
    },
    ...APPROVAL_MODES.map((mode) => ({ value: mode as Choice, label: named(mode) })),
  ];
  const failures = [
    { key: "mode", message: setMode.error },
    { key: "clear", message: clearTaint.error },
  ];

  return (
    <section
      ref={root}
      aria-label={t("sessionPolicy.bar")}
      data-session-policy
      // While a question is open, focus anywhere in the bar is an edit in progress: Escape never stops the run.
      data-inline-edit={asking === null ? undefined : ""}
      className="flex flex-col gap-s2"
    >
      <div className="flex flex-wrap items-end gap-s3">
        <div className="min-w-56">
          <Select<Choice>
            label={t("sessionPolicy.mode")}
            value={policy.explicit ? policy.mode : "default"}
            options={options}
            onChange={choose}
            disabled={setMode.busy}
          />
        </div>
        {policy.tainted ? (
          <div className="flex items-center gap-s2">
            <Chip tone="ext" label={t("sessionPolicy.external")} />
            {asking === "clear" ? null : (
              <Button data-policy-clear disabled={clearTaint.busy} onClick={() => setAsking("clear")}>
                {t("sessionPolicy.clear")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {policy.tainted ? <p className="text-ui text-muted">{t("sessionPolicy.externalWhy")}</p> : null}
      {asking === "full-access" ? (
        <Ask
          question={t("sessionPolicy.confirmFull")}
          confirm={t("sessionPolicy.switch")}
          busy={setMode.busy}
          onConfirm={() => void send("full-access")}
          onCancel={cancel}
        />
      ) : null}
      {asking === "clear" && policy.tainted ? (
        <Ask
          question={t("sessionPolicy.confirmClear")}
          confirm={t("sessionPolicy.clear")}
          busy={clearTaint.busy}
          onConfirm={() => void clear()}
          onCancel={cancel}
        />
      ) : null}
      {outcome ? (
        <p role="status" className="text-ui text-muted">
          {outcome}
        </p>
      ) : null}
      {failures.map(({ key, message }) =>
        message === null ? null : (
          <p key={key} role="alert" className="text-ui text-attn">
            {message}
          </p>
        ),
      )}
      <p>
        <Link
          to="/settings/$section"
          params={{ section: "approvals" }}
          className={cn("text-ui text-agent underline", FOCUS_RING)}
        >
          {t("sessionPolicy.manage")}
        </Link>
      </p>
    </section>
  );
}
