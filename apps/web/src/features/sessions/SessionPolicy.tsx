import { APPROVAL_MODES, type ApprovalMode, type SessionPolicyView } from "@pap/contracts";
import { Button, Chip, Heading, InlineError } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { getRuntime } from "../../runtime/index.ts";
import "./register-policy-catalog.ts";
import { AlwaysRules } from "./AlwaysRules.tsx";
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
 * from a fetch of its own. It is a chip in the session header; its menu holds the mode choice, the external-content
 * Clear, the project's always-rules and the link to Settings. Full access and Clear ask first; every outcome, good or
 * bad, is said below the header row.
 */
export function SessionPolicy({
  sessionId,
  policy,
  cwd,
}: {
  readonly sessionId: string;
  readonly policy: SessionPolicyView;
  /** The folder of the snapshot: the project whose always-rules the menu lists. */
  readonly cwd: string;
}) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const navigate = useNavigate();
  const runtime = getRuntime();
  const why = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const setMode = useAction();
  const clearTaint = useAction();

  // A cleared (or never set) taint leaves no question behind: a later taint must not bring the old one back.
  if (!policy.tainted && asking === "clear") setAsking(null);
  // The chip gets the focus back once the screen has drawn it again (an effect, so no ref is read during render).
  const [refocus, setRefocus] = useState(0);
  const focus = () => setRefocus((n) => n + 1);
  useEffect(() => {
    if (refocus === 0) return;
    const frame = requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>("[data-policy-mode]")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [refocus]);
  const forget = () => {
    setOutcome(null);
    setMode.clear();
    clearTaint.clear();
  };
  const cancel = () => {
    setAsking(null);
    focus();
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
    focus();
  };
  const clear = async () => {
    forget();
    const cleared = await clearTaint.run(() =>
      runtime.rpc.call("policy.clearTaint", { sessionId }, { commandId: runtime.rpc.newCommandId() }),
    );
    setAsking(null);
    if (cleared) setOutcome(t("sessionPolicy.cleared"));
    focus();
  };
  const selected: Choice = policy.explicit ? policy.mode : "default";
  const choose = (choice: Choice) => {
    if (choice === selected) return;
    forget();
    if (choice === "full-access") setAsking("full-access");
    else void send(choice === "default" ? null : choice);
  };

  const named = (mode: ApprovalMode) => t(`sessionPolicy.mode.${mode}`);
  const choices = [
    {
      value: "default" as Choice,
      label: t("sessionPolicy.mode.defaultNamed", { mode: named(policy.defaultMode) }),
    },
    ...APPROVAL_MODES.map((mode) => ({ value: mode as Choice, label: named(mode) })),
  ];
  const modeItems: MenuItem[] = [];
  for (const { value, label } of choices) {
    modeItems.push({
      id: `mode:${value}`,
      label: value === selected ? t("sessionPolicy.current", { label }) : label,
      // Full access is the one choice that widens what runs unasked: it stays apart (and asks first).
      ...(value === "full-access" ? { tone: "danger" as const } : {}),
      onSelect: () => choose(value),
    });
  }
  const items: MenuItem[] = [
    ...modeItems,
    ...(policy.tainted
      ? [
          {
            id: "clear",
            label: t("sessionPolicy.clearExternal"),
            disabled: clearTaint.busy,
            onSelect: () => {
              forget();
              setAsking("clear");
            },
          },
        ]
      : []),
    { id: "rules", label: t("rules.title"), onSelect: () => setRulesOpen(true) },
    {
      id: "manage",
      label: t("sessionPolicy.manage"),
      onSelect: () => void navigate({ to: "/settings/$section", params: { section: "approvals" } }),
    },
  ];
  const failures = [
    { key: "mode", message: setMode.error },
    { key: "clear", message: clearTaint.error },
  ];
  const modeName = named(policy.mode);

  // The chip sits in the session header's row; every panel below takes a row of its own at the end of it.
  return (
    <div
      ref={root}
      data-session-policy
      // While a question is open, focus anywhere here is an edit in progress: Escape never stops the run.
      data-inline-edit={asking === null ? undefined : ""}
      className="contents"
    >
      <LazyMenu
        label={t("sessionPolicy.bar")}
        closeLabel={t("ui.close")}
        text={lazyText}
        items={items}
        trigger={(ask) => (
          <Button
            variant="secondary"
            size="sm"
            data-policy-mode
            disabled={setMode.busy}
            aria-label={t(policy.explicit ? "sessionPolicy.chip" : "sessionPolicy.chipDefault", {
              mode: modeName,
            })}
            aria-describedby={policy.tainted ? why : undefined}
            onClick={ask}
          >
            {modeName}
          </Button>
        )}
      />
      {policy.tainted ? (
        <>
          <Chip tone="ext" label={t("sessionPolicy.external")} />
          <span id={why} className="sr-only">
            {t("sessionPolicy.externalWhy")}
          </span>
        </>
      ) : null}
      {asking === "full-access" ? (
        <div className="order-last w-full">
          <Ask
            question={t("sessionPolicy.confirmFull")}
            confirm={t("sessionPolicy.switch")}
            busy={setMode.busy}
            onConfirm={() => void send("full-access")}
            onCancel={cancel}
          />
        </div>
      ) : null}
      {asking === "clear" && policy.tainted ? (
        <div className="order-last flex w-full flex-col gap-s2">
          <p className="text-ui text-muted">{t("sessionPolicy.externalWhy")}</p>
          <Ask
            question={t("sessionPolicy.confirmClear")}
            confirm={t("sessionPolicy.clear")}
            busy={clearTaint.busy}
            onConfirm={() => void clear()}
            onCancel={cancel}
          />
        </div>
      ) : null}
      {rulesOpen ? (
        <section
          aria-label={t("rules.title")}
          data-always-rules
          className="order-last flex w-full flex-col gap-s2"
        >
          <div className="flex items-center justify-between gap-s2">
            <Heading level={2} variant="card">
              {t("rules.title")}
            </Heading>
            <Button
              size="sm"
              onClick={() => {
                setRulesOpen(false);
                focus();
              }}
            >
              {t("ui.close")}
            </Button>
          </div>
          {cwd === "" ? (
            <p className="text-ui text-muted">{t("rules.loading")}</p>
          ) : (
            <AlwaysRules cwd={cwd} />
          )}
        </section>
      ) : null}
      {outcome ? (
        <p role="status" className="order-last w-full text-ui text-muted">
          {outcome}
        </p>
      ) : null}
      {failures.map(({ key, message }) =>
        message === null ? null : (
          <div key={key} className="order-last w-full">
            <InlineError announce="action">{message}</InlineError>
          </div>
        ),
      )}
    </div>
  );
}
