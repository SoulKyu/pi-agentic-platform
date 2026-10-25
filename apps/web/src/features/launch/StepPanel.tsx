import "../../i18n/register-launch.ts";
import type { LaunchStepState, LaunchView } from "@pap/contracts";
import {
  Button,
  cn,
  Icon,
  IconCheck,
  IconDot,
  IconWarning,
  InlineError,
  Spinner,
  usePendingAction,
} from "@pap/ui";
import { useState } from "react";
import { errorKey, useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { formatLaunchTime } from "../../stores/launch-store.ts";
import { askOf, isRunning, isSlow, stepKey, stepTime } from "./launch-view.ts";
import { LAUNCH_STEP_LIMITS_MS } from "@pap/contracts";
import { useNow } from "./use-elapsed.ts";
import { WaitingLine } from "./WaitingLine.tsx";

const loadLog = () => import("./LaunchLogDialog.tsx");

function Glyph({ state, label }: { readonly state: LaunchStepState; readonly label: string }) {
  if (state === "running") return <Spinner label={label} />;
  if (state === "done")
    return (
      <span className="text-ok">
        <Icon icon={IconCheck} size={14} />
      </span>
    );
  if (state === "failed")
    return (
      <span className="text-err">
        <Icon icon={IconWarning} size={14} />
      </span>
    );
  return (
    <span className="text-muted">
      <Icon icon={IconDot} size={14} />
    </span>
  );
}

/** "Stop" on the ask: `launches.stop`, pending while it runs. The launch's end removes the panel; a failure stays under the ask. */
function useStopLaunch(id: string) {
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const run = () =>
    void pending.run(async () => {
      setProblem(null);
      try {
        const { rpc } = getRuntime();
        await rpc.call("launches.stop", { id }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        setProblem(failure instanceof RpcError ? failure.code : "internal");
      }
    });
  return { since: pending.since, problem, run };
}

export interface StepPanelProps {
  readonly launch: LaunchView;
  /** Opens the screen that frees a wait ("See the sessions"). */
  onWaitingAction?: (() => void) | undefined;
}

/**
 * The steps of one live launch (DESIGN §7: colour is role): done steps with their time, the running one counting once a
 * second, a neutral "slower than usual", a failed step in red, and the ask in pink when pap has had no news for long.
 * The ask is a polite status block, not an alert: it waits for the person, it is not the result of their last action.
 */
export default function StepPanel({ launch, onWaitingAction }: StepPanelProps) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const [logOpen, setLogOpen] = useState(false);
  const stop = useStopLaunch(launch.id);
  const live = launch.steps.find(isRunning);
  const now = useNow(live !== undefined);
  const ask = askOf(launch, now);
  const slow = live !== undefined && isSlow(live, now) ? live : undefined;
  const building = live?.step === "image";
  const kind = launch.box.kind;
  const title = t(building ? "launch.title.build" : `launch.title.${kind}`);
  return (
    <section data-launch-panel="" aria-label={title} className="flex flex-col gap-s2">
      <h2 className="text-ui font-semibold text-fg">{title}</h2>
      <ol className="flex flex-col gap-s1">
        {launch.steps.map((step) => {
          const label = t(stepKey(step.step, kind));
          const time = stepTime(step, now, t);
          return (
            <li
              key={step.step}
              data-step={step.step}
              data-state={step.state}
              className={cn(
                "flex items-center gap-s2 text-ui",
                step.state === "failed" ? "text-err" : step.state === "pending" ? "text-muted" : "text-fg",
              )}
            >
              <Glyph state={step.state} label={label} />
              <span className="min-w-0 flex-1">{label}</span>
              {time === null ? null : <span className="font-mono tabular-nums text-muted">{time}</span>}
            </li>
          );
        })}
      </ol>
      {launch.steps.map((step) =>
        step.state === "failed" && step.code !== undefined ? (
          <p key={step.step} className="text-ui text-err">
            {t(errorKey(step.code))}
          </p>
        ) : null,
      )}
      {live?.detail ? (
        <p className="break-words font-mono text-label text-muted">
          {t("launch.sign", {
            line: live.detail.line,
            ago: formatLaunchTime(Math.max(0, now - live.detail.at)),
          })}
        </p>
      ) : null}
      {slow ? (
        <p className="text-ui text-muted">
          {t("launch.slow", { limit: formatLaunchTime(LAUNCH_STEP_LIMITS_MS[slow.step]) })}
        </p>
      ) : null}
      {launch.waiting ? <WaitingLine waiting={launch.waiting} now={now} onAction={onWaitingAction} /> : null}
      {ask ? (
        <div
          role="status"
          data-launch-ask=""
          className="flex flex-wrap items-center justify-between gap-s2 rounded-md border border-attn-line bg-attn-tint px-s3 py-s2"
        >
          <p className="min-w-0 text-ui text-fg">
            {ask.kind === "long"
              ? t("launch.ask.long", {
                  step: t(stepKey(ask.step, kind)),
                  elapsed: formatLaunchTime(ask.ms),
                  limit: formatLaunchTime(ask.limitMs),
                })
              : t("launch.ask", {
                  step: t(stepKey(ask.step, kind)),
                  ago: formatLaunchTime(ask.ms),
                  limit: formatLaunchTime(ask.limitMs),
                })}
          </p>
          <div className="flex shrink-0 items-center gap-s2">
            {ask.log ? (
              <Button size="sm" variant="secondary" onClick={() => setLogOpen(true)}>
                {t("launch.ask.log")}
              </Button>
            ) : null}
            {ask.stop ? (
              <Button size="sm" variant="secondary" pendingSince={stop.since} onClick={stop.run}>
                {t("launch.ask.stop")}
              </Button>
            ) : null}
          </div>
          {stop.problem === null ? null : (
            <div className="basis-full">
              <InlineError announce="action">{t(errorKey(stop.problem))}</InlineError>
            </div>
          )}
        </div>
      ) : null}
      <LazyPanel
        text={lazyText}
        load={loadLog}
        open={logOpen}
        props={{ box: launch.box, onClose: () => setLogOpen(false) }}
        onFailed={() => setLogOpen(false)}
      />
    </section>
  );
}
