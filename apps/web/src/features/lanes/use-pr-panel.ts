import type { LaneView, PrView } from "@pap/contracts";
import { usePendingAction } from "@pap/ui";
import { useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { shipOf, useLaneShip, useLaneShipStore } from "../../stores/lane-ship-store.ts";
import { PUSH_REFUSED } from "./commit-bar.vm.ts";
import { failureKey } from "./failure-text.ts";
import { outcomeUnknown, pushLane, pushRunning } from "./lane-calls.ts";
import { PR_REFUSED, prFormDefaults } from "./pr.vm.ts";

export type PrAction = "create" | "pushCreate" | "refresh";
type PrRefusal = keyof typeof PR_REFUSED;

export interface PrPanelState {
  readonly form: { readonly title: string; readonly body: string; readonly draft: boolean };
  /** The pull request the lane has: the stream's, else what a create or a check just found. */
  readonly pr: PrView | null;
  readonly refusal: PrRefusal | null;
  /** A create timed out: the pull request may exist, so only a check is offered until it answers. */
  readonly unknown: boolean;
  /** A push or a creation runs (started here or from the commit bar): nothing else may start. */
  readonly busyElsewhere: boolean;
  readonly problem: MessageKey | null;
  readonly checkedNone: boolean;
  readonly active: PrAction | null;
  readonly since: number | null;
  edit(patch: Partial<PrPanelState["form"]>): void;
  create(): void;
  pushAndCreate(): void;
  refresh(): void;
}

/**
 * The pull request panel's calls (M9R92). `prCreate` answers `timeout` when the outcome is unknown: that is not a
 * failure, and a second create could open a duplicate, so the panel offers `lanes.prRefresh` (which looks the pull
 * request up) instead of a retry.
 */
export function usePrPanel(lane: Pick<LaneView, "id" | "title" | "branch" | "pr">): PrPanelState {
  const [form, setForm] = useState(() => prFormDefaults(lane));
  const [refusal, setRefusal] = useState<PrRefusal | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [checkedNone, setCheckedNone] = useState(false);
  const [active, setActive] = useState<PrAction | null>(null);
  const { since, run } = usePendingAction();
  const laneId = lane.id;
  // Kept outside the panel: closing it, or leaving the tab, must not forget that a creation may have happened.
  const ship = useLaneShip(laneId);
  const remember = (patch: Parameters<ReturnType<typeof useLaneShipStore.getState>["patch"]>[1]) =>
    useLaneShipStore.getState().patch(laneId, patch);

  const start = (action: PrAction) => {
    setActive(action);
    setProblem(null);
    setRefusal(null);
    setCheckedNone(false);
  };

  /** One `prCreate`; resolves true once the pull request exists. */
  const createCall = (): Promise<void> => {
    if (shipOf(laneId).creating) return Promise.resolve();
    remember({ creating: true });
    const { rpc } = getRuntime();
    const params = { laneId, title: form.title.trim(), body: form.body, draft: form.draft };
    return rpc.call("lanes.prCreate", params, { commandId: rpc.newCommandId() }).then(
      (answer) => {
        remember({ creating: false });
        if (answer.ok) remember({ found: answer.pr });
        else setRefusal(answer.reason);
      },
      (failure: unknown) => {
        remember({ creating: false });
        if (outcomeUnknown(failure)) remember({ unknown: true });
        else setProblem(failureKey(failure, PR_REFUSED.failed));
      },
    );
  };

  const create = () => {
    start("create");
    void run(createCall);
  };

  const pushAndCreate = () => {
    if (pushRunning(laneId) || shipOf(laneId).creating) return;
    start("pushCreate");
    void run(() =>
      pushLane(laneId).then(
        (pushed) => {
          if (pushed.ok) return createCall();
          setRefusal("not_pushed");
          setProblem(PUSH_REFUSED[pushed.reason]);
        },
        (failure: unknown) => {
          setRefusal("not_pushed");
          setProblem(failureKey(failure, PUSH_REFUSED.failed));
        },
      ),
    );
  };

  const refresh = () => {
    start("refresh");
    const { rpc } = getRuntime();
    void run(() =>
      rpc.call("lanes.prRefresh", { laneId }).then(
        (answer) => {
          remember({ unknown: false, found: answer.pr });
          setCheckedNone(answer.pr === null);
        },
        (failure: unknown) => setProblem(failureKey(failure, "laneCommit.pr.checkFailed")),
      ),
    );
  };

  return {
    form,
    pr: lane.pr ?? ship.found,
    refusal,
    unknown: ship.unknown,
    busyElsewhere: ship.pushing || ship.creating,
    problem,
    checkedNone,
    active,
    since,
    edit: (patch) => setForm((current) => ({ ...current, ...patch })),
    create,
    pushAndCreate,
    refresh,
  };
}
