import type { ConfigGetResult, ProviderView } from "@pap/contracts";
import { Button, Heading, InlineError, LoadingLine, TextField } from "@pap/ui";
import "../../i18n/register-launch.ts";
import { usePiCauseText } from "../../stores/loading-cause.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { DiscardConfirm } from "./DiscardConfirm.tsx";
import { DiscoverPanel } from "./DiscoverPanel.tsx";
import { failureCode, failureText } from "./failure.ts";
import { STARTER_TEXT } from "./models-json.vm.ts";
import { PricingLookup } from "./PricingLookup.tsx";
import type { StepUpRunner } from "./step-up.ts";

type Phase = "loading" | "failed" | "unparsable" | "ready";

/**
 * The `models.json` editor (M7R72, M7R73): a monospace text field with the masked text the daemon answers. The draft
 * lives in this component's state only: never in a browser store or the address (it can hold a key being replaced).
 * Save sends the text back with the revision it read (behind the password step-up); a refusal comes back as JSON paths,
 * a `conflict` keeps the draft and offers Reload, and after a save the file is read again so the draft shows the masked
 * text, not a key the owner just typed.
 */
function Editor({
  provider,
  stepUp,
  pricingOn,
  onPricingForbidden,
  onChanged,
  onDirty,
}: {
  readonly provider: ProviderView;
  readonly stepUp: StepUpRunner;
  readonly pricingOn: boolean;
  onPricingForbidden(): void;
  onChanged(): void;
  onDirty(dirty: boolean): void;
}) {
  const t = useT();
  const cause = usePiCauseText(t);
  const [phase, setPhase] = useState<Phase>("loading");
  const [loadIssues, setLoadIssues] = useState<readonly string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [noFile, setNoFile] = useState(false);
  const [revision, setRevision] = useState("");
  const [draft, setDraft] = useState("");
  const [baseline, setBaseline] = useState("");
  const [saveIssues, setSaveIssues] = useState<readonly string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "status"; text: string } | null>(null);
  const [loads, setLoads] = useState(0);
  const alive = useRef(true);

  const apply = useCallback((answer: ConfigGetResult) => {
    setPath(answer.path);
    setRevision(answer.revision);
    setConflict(false);
    setSaveIssues([]);
    if (answer.text === null && answer.issues.length > 0) {
      setLoadIssues(answer.issues);
      setPhase("unparsable");
      return;
    }
    setNoFile(answer.text === null);
    setDraft(answer.text ?? STARTER_TEXT);
    setBaseline(answer.text ?? STARTER_TEXT);
    setPhase("ready");
  }, []);

  const load = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    setLoads((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("models.config.get", {})
      .then(
        (answer) => {
          if (current) apply(answer);
        },
        (failure: unknown) => {
          if (!current) return;
          setLoadError(failureText(failure));
          setPhase("failed");
        },
      );
    return () => {
      current = false;
    };
  }, [loads, apply]);

  const dirty = phase === "ready" && draft !== baseline;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const save = () => {
    if (busy) return;
    setBusy(true);
    setSaveIssues([]);
    setConflict(false);
    setNotice(null);
    const rpc = getRuntime().rpc;
    const text = draft;
    stepUp((commandId) => rpc.call("models.config.save", { text, baseRevision: revision }, { commandId }))
      .then(
        (result) => {
          if (result === null) return;
          if ("code" in result) {
            setSaveIssues(result.issues);
            return;
          }
          setRevision(result.revision);
          setNotice({
            tone: result.enabledModelsSynced ? "status" : "error",
            text: result.enabledModelsSynced
              ? t("settingsModels.json.saved")
              : t("settingsModels.json.savedUnsynced"),
          });
          onChanged();
          // The draft is replaced by the masked file; if that read fails the draft stays and the new revision with it.
          return getRuntime()
            .rpc.call("models.config.get", {})
            .then(
              (answer) => {
                if (alive.current && answer.text !== null) apply(answer);
              },
              (failure: unknown) =>
                setNotice({
                  tone: "error",
                  text: `${t("settingsModels.json.saved")} ${failureText(failure)}`,
                }),
            );
        },
        (failure: unknown) => {
          if (failureCode(failure) === "conflict") setConflict(true);
          else setNotice({ tone: "error", text: failureText(failure) });
        },
      )
      .finally(() => setBusy(false));
  };

  if (phase === "loading") return <LoadingLine label={t("settingsModels.json.loading")} cause={cause} />;
  if (phase === "failed")
    return (
      <div className="flex flex-col items-start gap-s2">
        <InlineError announce="background">{loadError}</InlineError>
        <Button onClick={load}>{t("settingsModels.retry")}</Button>
      </div>
    );
  if (phase === "unparsable")
    return (
      <div className="flex flex-col items-start gap-s2">
        <InlineError announce="background">{t("settingsModels.json.unparsable")}</InlineError>
        <ul className="flex flex-col gap-s1">
          {loadIssues.map((issue, index) => (
            <li key={index} className="font-mono text-ui text-fg">
              {issue}
            </li>
          ))}
        </ul>
        <Button
          onClick={() => {
            setDraft(STARTER_TEXT);
            setBaseline(STARTER_TEXT);
            setPhase("ready");
          }}
        >
          {t("settingsModels.json.replace")}
        </Button>
      </div>
    );

  return (
    <div className="flex flex-col gap-s3">
      {path ? (
        <p className="font-mono text-ui text-muted">{t("settingsModels.json.path", { path })}</p>
      ) : null}
      {noFile ? <p className="text-ui text-muted">{t("settingsModels.json.noFile")}</p> : null}
      <TextField
        label={t("settingsModels.json.label")}
        hint={t("settingsModels.json.note")}
        value={draft}
        onChange={setDraft}
        multiline
        mono
        rows={18}
        name="models-json"
        autoComplete="off"
        disabled={busy}
        error={saveIssues.length > 0 ? t("settingsModels.json.invalid") : null}
      />
      {saveIssues.length > 0 ? (
        <ul className="flex flex-col gap-s1">
          {saveIssues.map((issue, index) => (
            <li key={index} className="font-mono text-ui text-fg">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
      {conflict ? (
        <div className="flex flex-col items-start gap-s2">
          <InlineError announce="action">{t("settingsModels.json.conflict")}</InlineError>
          <Button onClick={load}>{t("settingsModels.json.reload")}</Button>
        </div>
      ) : null}
      {notice ? (
        notice.tone === "error" ? (
          <InlineError announce="action">{notice.text}</InlineError>
        ) : (
          <p role="status" className="text-ui text-muted">
            {notice.text}
          </p>
        )
      ) : null}
      <div>
        <Button variant="primary" disabled={busy} onClick={save}>
          {t("settingsModels.json.save")}
        </Button>
      </div>
      <DiscoverPanel provider={provider} stepUp={stepUp} draft={draft} onDraft={setDraft} />
      {pricingOn ? (
        <PricingLookup
          provider={provider}
          draft={draft}
          onDraft={setDraft}
          onForbidden={onPricingForbidden}
        />
      ) : null}
    </div>
  );
}

/** The `models.json` section of a provider: a button that opens the editor, which reads the file when it opens. */
export function ModelsJsonEditor(props: {
  readonly provider: ProviderView;
  readonly stepUp: StepUpRunner;
  readonly pricingOn: boolean;
  readonly dirty: boolean;
  onPricingForbidden(): void;
  onChanged(): void;
  onDirty(dirty: boolean): void;
}) {
  const t = useT();
  const { dirty, ...editorProps } = props;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <section aria-label={t("settingsModels.json.title")} className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsModels.json.title")}
      </Heading>
      <div>
        <Button
          onClick={() => {
            if (open && dirty) setConfirming(true);
            else setOpen(!open);
          }}
        >
          {open ? t("settingsModels.json.close") : t("settingsModels.json.open")}
        </Button>
      </div>
      {confirming ? (
        <DiscardConfirm
          onDiscard={() => {
            setConfirming(false);
            setOpen(false);
          }}
          onKeep={() => setConfirming(false)}
        />
      ) : null}
      {open ? <Editor {...editorProps} /> : null}
    </section>
  );
}
