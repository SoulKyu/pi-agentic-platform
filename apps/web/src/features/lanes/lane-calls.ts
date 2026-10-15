import type { ResultOf } from "@pap/contracts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { shipOf, useLaneShipStore } from "../../stores/lane-ship-store.ts";

/** True while a push of this lane runs, from the bar or from "Push and create": one guard for every path that pushes. */
export const pushRunning = (laneId: string): boolean => shipOf(laneId).pushing;

/** One push, under a command id of its own. The commit bar and "Push and create" both go through here. */
export function pushLane(laneId: string): Promise<ResultOf<"lanes.push">> {
  const { rpc } = getRuntime();
  const done = () => useLaneShipStore.getState().patch(laneId, { pushing: false });
  useLaneShipStore.getState().patch(laneId, { pushing: true });
  return rpc.call("lanes.push", { laneId }, { commandId: rpc.newCommandId() }).then(
    (answer) => {
      done();
      return answer;
    },
    (failure: unknown) => {
      done();
      throw failure;
    },
  );
}

/** The outcome of a mutation is unknown (R105): it may have happened, so it is never sent again by itself. */
export const outcomeUnknown = (failure: unknown): boolean =>
  failure instanceof RpcError && (failure.code === "timeout" || failure.code === "connection_lost");
