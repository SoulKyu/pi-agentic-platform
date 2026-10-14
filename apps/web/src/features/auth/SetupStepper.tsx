import "./register-first-run.ts";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { PasskeyStep } from "./PasskeyStep.tsx";
import { PiStep, type ModelsPanel } from "./PiStep.tsx";
import { SetupScreen } from "./SetupScreen.tsx";
import { nextStep, STEPS, type Step } from "./setup-stepper.vm.ts";

function StepList({ current }: { readonly current: Step }) {
  const t = useT();
  const labels: Record<Step, string> = {
    account: t("firstRun.step.account"),
    passkey: t("firstRun.step.passkey"),
    pi: t("firstRun.step.pi"),
  };
  return (
    <ol aria-label={t("firstRun.steps.label")} className="label-hud flex gap-s3 text-muted">
      {STEPS.map((step, index) => (
        <li
          key={step}

          aria-current={step === current ? "step" : undefined}
          className={step === current ? "text-agent" : ""}
        >
          {index + 1} · {labels[step]}
        </li>
      ))}
    </ol>
  );
}

/**
 * The first run as three steps: account, passkey, Pi (M7R126). Every step after the account can be skipped. The state
 * lives in this page only (M7R128): the account step does not call `onDone`, because the page would then leave the
 * setup; the last step does, and so does a session that disappeared.
 */
export function SetupStepper({
  onDone,
  onAccountCreated,
  models,
}: {
  onDone(): void;
  /** The account exists and the owner is signed in: the host starts the socket that steps 2 and 3 need. */
  onAccountCreated(): void;
  models: ModelsPanel;
}) {
  const [step, setStep] = useState<Step>("account");
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step !== "account") frame.current?.querySelector("h1")?.focus();
  }, [step]);
  const steps = <StepList current={step} />;
  const advance = () => {
    if (step === "account") onAccountCreated();
    const next = nextStep(step);
    if (next === null) onDone();
    else setStep(next);
  };
  return (
    <div ref={frame}>
      {step === "account" ? (
        <SetupScreen onDone={advance} steps={steps} />
      ) : step === "passkey" ? (
        <PasskeyStep steps={steps} onNext={advance} onSignedOut={onDone} />
      ) : (
        <PiStep steps={steps} models={models} onFinish={advance} onSignedOut={onDone} />
      )}
    </div>
  );
}
