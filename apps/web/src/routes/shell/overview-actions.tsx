import "../../i18n/register-boxes.ts";
import "../../i18n/register-overview.ts";
import type { BoxRef, OverviewBox, OverviewSnapshot } from "@pap/contracts";
import { Button, InlineError, usePendingAction } from "@pap/ui";
import { useId, useState, type ReactNode } from "react";
import { BoxStart } from "../../features/boxes/BoxStart.tsx";
import { useBoxAction } from "../../features/boxes/use-box-action.ts";
import { StopBoxDialog } from "../../features/overview/StopBoxDialog.tsx";
import { sizeText } from "../../features/overview/overview.vm.ts";
import { errorKey, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useLaunchOf } from "../../stores/launch-store.ts";

type Capacity = OverviewSnapshot["capacity"];

/** The daemon decided `fits` (R1); this only words the refusal: the owner sees both figures, a member never the shared GB. */
function NoMemory({ box, capacity, id }: { box: OverviewBox; capacity: Capacity; id: string }) {
  const t = useT();
  const locale = useLocale();
  const need = sizeText(box.needMb, locale, t);
  const text =
    capacity.role === "owner" && capacity.memory !== null
      ? t("overview.noMemory.owner", {
          need,
          free: sizeText(capacity.memory.maxMb - capacity.memory.usedMb, locale, t),
        })
      : t("overview.noMemory.member", { need });
  return (
    <p id={id} className="max-w-prose text-ui text-muted">
      {text}
    </p>
  );
}

function Start({ box, ref, capacity }: { box: OverviewBox; ref: BoxRef; capacity: Capacity }) {
  const t = useT();
  const reasonId = useId();
  if (box.fits) return <BoxStart box={ref} phase="stopped" size="sm" variant="secondary" />;
  return (
    <span className="flex flex-col items-start gap-s1">
      <Button variant="secondary" size="sm" disabled aria-describedby={reasonId}>
        {t("boxes.start")}
      </Button>
      <NoMemory box={box} capacity={capacity} id={reasonId} />
    </span>
  );
}

/** STOP of a starting box: its launch (`launches.stop`), only while the daemon marks it stoppable (R6). */
function StopLaunch({ ref }: { ref: BoxRef }) {
  const t = useT();
  const launch = useLaunchOf(ref);
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const stop = () =>
    void pending.run(async () => {
      if (launch === undefined) return;
      setProblem(null);
      try {
        const { rpc } = getRuntime();
        await rpc.call("launches.stop", { id: launch.id }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  return (
    <span className="flex flex-col items-end gap-s1">
      <Button
        variant="secondary"
        size="sm"
        disabled={launch?.stoppable !== true}
        pendingSince={pending.since}
        onClick={stop}
      >
        {t("overview.stop")}
      </Button>
      {problem === null ? null : <InlineError announce="action">{problem}</InlineError>}
    </span>
  );
}

/** STOP of a running box: a busy one asks first (what is interrupted), an idle one stops at once. */
function StopRunning({ box, ref }: { box: OverviewBox; ref: BoxRef }) {
  const t = useT();
  const action = useBoxAction("projects.stopBox", ref);
  const [asking, setAsking] = useState(false);
  const confirm = async () => {
    const problem = await action.attempt();
    if (problem !== null) throw new Error(problem);
  };
  return (
    <span className="flex flex-col items-end gap-s1">
      <Button
        variant="secondary"
        size="sm"
        pendingSince={action.since}
        onClick={() => (box.busy ? setAsking(true) : action.run())}
      >
        {t("overview.stop")}
      </Button>
      {action.problem === null ? null : <InlineError announce="action">{action.problem}</InlineError>}
      {asking ? (
        <StopBoxDialog
          name={box.name}
          activities={box.activities}
          alwaysOn={box.alwaysOn}
          onConfirm={confirm}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </span>
  );
}

/** A paused project box: its restart resumes it (a STOP would be a no-op, nothing runs to stop). */
function RestartPaused({ id }: { id: string }) {
  const t = useT();
  const action = useBoxAction("projects.restartBox", { kind: "project", id });
  return (
    <span className="flex flex-col items-end gap-s1">
      <Button variant="secondary" size="sm" pendingSince={action.since} onClick={action.run}>
        {t("boxes.restart")}
      </Button>
      {action.problem === null ? null : <InlineError announce="action">{action.problem}</InlineError>}
    </span>
  );
}

/** With the VM stack unusable the host has no figure to refuse by: E3 explains, so a box row offers nothing. */
const stackUnusable = (capacity: Capacity): boolean =>
  capacity.role === "owner" ? capacity.memory === null : capacity.sharedPercent === null;

/** The buttons follow the box's phase, not the state word: a FAILED or WAITING card whose box is down still offers START. */
function BoxActions({ box, capacity }: { box: OverviewBox; capacity: Capacity }) {
  if (box.ref.kind === "host") return null;
  const ref: BoxRef = { kind: box.ref.kind, id: box.ref.id };
  if (box.phase === "stopped")
    return stackUnusable(capacity) ? null : <Start box={box} ref={ref} capacity={capacity} />;
  if (box.phase === "starting") return <StopLaunch ref={ref} />;
  if (box.phase === "running") return <StopRunning box={box} ref={ref} />;
  if (box.phase === "paused" && box.ref.kind === "project") return <RestartPaused id={box.ref.id} />;
  return null;
}

/** START on a stopped box, STOP on a live one: the buttons of `OverviewCallbacks.actions`, composed here because features never import each other. */
export const overviewActions = (box: OverviewBox, capacity: Capacity): ReactNode => (
  <BoxActions box={box} capacity={capacity} />
);
