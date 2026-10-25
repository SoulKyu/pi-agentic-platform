import { AutomationSettings } from "@pap/contracts";
import { Button, InlineError, Switch, TextField, usePendingAction } from "@pap/ui";
import { useEffect, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { useRole } from "../../lib/role-context.ts";
import { usePauseReread } from "../../lib/use-pause-reread.ts";
import { RpcError, getRuntime } from "../../runtime/index.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { browserZone as ownBrowserZone, check, type Draft, draftOf } from "./automation-form.vm.ts";
import { saveAutomation } from "./automation-save.ts";

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly stored: AutomationSettings; readonly draft: Draft };
type Notice = { readonly tone: "ok" | "error"; readonly text: string } | null;

/**
 * This account's automation settings (M10R121): one compare-and-set document. The pause switch writes the same
 * `paused` flag as the Tasks board and follows its stream; Save writes the other fields over a fresh read, so a pause
 * set elsewhere meanwhile is kept.
 */
export function AutomationForm({
  serverZone,
  browserZone,
}: {
  /** The time zone the server counts in while the setting has none. */
  readonly serverZone: string | null;
  readonly browserZone?: () => string | null;
}) {
  const t = useT();
  const zoneOf = browserZone ?? ownBrowserZone;
  const member = useRole() === "member";
  // The owner capped this member's budget (M14): `settings.get` answers the effective value, so a refusal re-reads the cap.
  const [refused, setRefused] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const saving = usePendingAction();
  const streamPaused = useTasksStore((state) => state.view.counts?.paused);
  // What the last successful pause write set, good only while the stream still says what it said before the write.
  const [written, setWritten] = useState<{
    readonly was: boolean | undefined;
    readonly paused: boolean;
  } | null>(null);

  // The stream moved on from what the write saw (another tab changed it): the overlay is over.
  if (written !== null && written.was !== streamPaused) setWritten(null);
  usePauseReread((paused) => {
    setWritten({ was: streamPaused, paused });
    setLoaded((now) => (now.kind === "ready" ? { ...now, stored: { ...now.stored, paused } } : now));
  });

  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("settings.get", { key: "automation" })
      .then(
        (answer) => {
          const parsed = AutomationSettings.safeParse(answer.value ?? {});
          if (live)
            setLoaded(
              parsed.success
                ? { kind: "ready", stored: parsed.data, draft: draftOf(parsed.data) }
                : { kind: "failed" },
            );
        },
        () => live && setLoaded({ kind: "failed" }),
      );
    return () => {
      live = false;
    };
  }, []);

  if (loaded.kind === "loading") return null;
  if (loaded.kind === "failed")
    return <InlineError announce="background">{t("settingsAutomation.loadFailed")}</InlineError>;
  const { stored, draft } = loaded;
  const checked = check(draft);
  const edit = (patch: Partial<Draft>) => {
    setNotice(null);
    setLoaded({ kind: "ready", stored, draft: { ...draft, ...patch } });
  };
  const failure = (error: unknown): Notice => {
    const code = error instanceof RpcError ? error.code : "internal";
    if (code === "forbidden") return { tone: "error", text: t("settingsAutomation.forbidden") };
    if (code === "budget_cap") return { tone: "error", text: t(errorKey(code)) };
    if (code === "conflict") return { tone: "error", text: t("settingsAutomation.conflict") };
    return {
      tone: "error",
      text: t(code === "bad_request" ? "settingsAutomation.loadFailed" : "error.internal"),
    };
  };
  const rpc = getRuntime().rpc;
  const paused =
    written !== null && written.was === streamPaused ? written.paused : (streamPaused ?? stored.paused);

  const setPaused = (next: boolean) =>
    void saving.run(async () => {
      setNotice(null);
      try {
        const saved = await saveAutomation(rpc, (current) => ({ ...current, paused: next }));
        setWritten({ was: streamPaused, paused: next });
        setLoaded((now) =>
          now.kind === "ready" ? { ...now, stored: { ...now.stored, paused: saved.paused } } : now,
        );
      } catch (error) {
        setNotice(failure(error));
      }
    });

  const rereadCap = () =>
    void rpc.call("settings.get", { key: "automation" }).then(
      (answer) => {
        const parsed = AutomationSettings.safeParse(answer.value ?? {});
        if (parsed.success)
          setLoaded((now) => (now.kind === "ready" ? { ...now, stored: parsed.data } : now));
      },
      () => {},
    );
  const cap = stored.dailyBudgetUsd;
  const typed = checked.value?.dailyBudgetUsd;
  const capped =
    member &&
    typeof cap === "number" &&
    ((refused && !(typeof typed === "number" && typed <= cap)) || (typeof typed === "number" && typed > cap));

  const save = () =>
    void saving.run(async () => {
      if (checked.value === null) return;
      const { value } = checked;
      setNotice(null);
      try {
        const saved = await saveAutomation(rpc, (current) => ({
          ...current,
          ...value,
          // The first save stores the browser's zone; a stored one is the owner's and stays.
          timezone: current.timezone ?? zoneOf(),
        }));
        setLoaded({ kind: "ready", stored: saved, draft: draftOf(saved) });
        setRefused(false);
        setNotice({ tone: "ok", text: t("settingsAutomation.saved") });
      } catch (error) {
        setNotice(failure(error));
        if (member && error instanceof RpcError && error.code === "budget_cap") {
          setRefused(true);
          rereadCap();
        }
      }
    });

  return (
    <div data-automation-form className="flex flex-col gap-s3">
      <Switch
        label={t("settingsAutomation.pause.label")}
        hint={t("settingsAutomation.pause.hint")}
        checked={paused}
        disabled={saving.since !== null}
        onChange={setPaused}
      />
      <TextField
        label={t("settingsAutomation.slots.label")}
        hint={t("settingsAutomation.slots.hint")}
        error={checked.slots ? t("settingsAutomation.slots.error") : null}
        value={draft.slots}
        onChange={(slots) => edit({ slots })}
      />
      <div className="flex flex-col gap-s1">
        <span className="label-hud text-muted">{t("settingsAutomation.zone.label")}</span>
        <span className="font-mono text-ui text-fg">
          {stored.timezone ?? t("settingsAutomation.zone.server", { zone: serverZone ?? "…" })}
        </span>
        <span className="text-ui text-muted">{t("settingsAutomation.zone.hint")}</span>
      </div>
      <div className="flex flex-wrap gap-s3">
        <TextField
          label={t("settingsAutomation.quiet.from")}
          placeholder="22:00"
          value={draft.from}
          onChange={(from) => edit({ from })}
        />
        <TextField
          label={t("settingsAutomation.quiet.to")}
          placeholder="07:00"
          value={draft.to}
          onChange={(to) => edit({ to })}
        />
      </div>
      <p className="text-ui text-muted">{t("settingsAutomation.quiet.hint")}</p>
      {checked.quiet ? (
        <InlineError announce="action">{t("settingsAutomation.quiet.error")}</InlineError>
      ) : null}
      {checked.noWindow ? <p className="text-ui text-muted">{t("settingsAutomation.quiet.none")}</p> : null}
      <TextField
        label={t("settingsAutomation.budget.label")}
        placeholder={t("settingsAutomation.budget.none")}
        hint={t("settingsAutomation.budget.hint")}
        error={checked.budget ? t("settingsAutomation.budget.error") : null}
        value={draft.budget}
        onChange={(budget) => edit({ budget })}
      />
      {capped ? (
        <p role="status" className="text-ui text-muted">
          {t("settingsAutomation.cap", { cap })}
        </p>
      ) : null}
      <Switch
        label={t("settingsAutomation.autoResume.label")}
        hint={t("settingsAutomation.autoResume.hint")}
        checked={draft.autoResume}
        onChange={(autoResume) => edit({ autoResume })}
      />
      <div className="flex items-center gap-s3">
        <Button
          variant="primary"
          pendingSince={saving.since}
          disabled={checked.value === null}
          onClick={save}
        >
          {t("settingsAutomation.save")}
        </Button>
        {notice ? (
          notice.tone === "error" ? (
            <InlineError announce="action">{notice.text}</InlineError>
          ) : (
            <p role="status" className="text-ui text-muted">
              {notice.text}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}
