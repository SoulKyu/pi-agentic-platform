import type { ModelsOverview } from "@pap/contracts";
import { Button, Chip, InlineError } from "@pap/ui";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { piSummary } from "./setup-stepper.vm.ts";
import { useFirstRunStepUp, type PiStepUp } from "./use-first-run-step-up.ts";

/** The providers panel the host supplies (it owns the lazy chunk: this feature does not import `features/models`). */
export type ModelsPanel = ComponentType<{ readonly stepUp: PiStepUp }>;

/**
 * Step 3: Pi (M7R126). A provider already signed in reads "Ready" with the default model and a Change link; otherwise
 * the providers panel of Settings opens here. Always skippable. Sign-in asks for the password once (M7R127).
 */
export function PiStep({
  steps,
  models: Models,
  onFinish,
  onSignedOut,
}: {
  readonly steps: ReactNode;
  readonly models: ModelsPanel;
  onFinish(): void;
  onSignedOut(): void;
}) {
  const t = useT();
  const { stepUp, prompt } = useFirstRunStepUp(onSignedOut);
  const [overview, setOverview] = useState<ModelsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [reads, setReads] = useState(0);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("models.overview", {})
      .then(
        (answer) => current && setOverview(answer),
        () => current && setFailed(true),
      );
    return () => {
      current = false;
    };
  }, [reads]);

  const summary = overview ? piSummary(overview) : null;
  const ready = summary?.kind === "ready";
  return (
    <AuthFrame title={t("firstRun.pi.title")} above={steps} wide>
      <p className="text-ui text-muted">{t("firstRun.pi.intro")}</p>
      {failed ? (
        <div className="flex flex-col items-start gap-s2">
          <InlineError announce="background">{t("firstRun.pi.unreadable")}</InlineError>
          <Button
            onClick={() => {
              setFailed(false);
              setReads((count) => count + 1);
            }}
          >
            {t("firstRun.pi.retry")}
          </Button>
        </div>
      ) : summary === null ? (
        <p role="status" className="text-ui text-muted">
          {t("firstRun.pi.loading")}
        </p>
      ) : ready && !changing ? (
        <div className="flex flex-col items-start gap-s2">
          <Chip tone="ok" label={t("firstRun.pi.ready")} />
          <p className="text-ui text-fg">
            {summary.model !== null && summary.provider !== null
              ? t("firstRun.pi.readyModel", { model: summary.model, provider: summary.provider })
              : t("firstRun.pi.readyNoDefault")}
          </p>
          <Button variant="ghost" onClick={() => setChanging(true)}>
            {t("firstRun.pi.change")}
          </Button>
        </div>
      ) : (
        <Models stepUp={stepUp} />
      )}
      <div>
        <Button variant={ready ? "primary" : "secondary"} onClick={onFinish}>
          {ready ? t("firstRun.finish") : t("firstRun.skip")}
        </Button>
      </div>
      {prompt}
    </AuthFrame>
  );
}
