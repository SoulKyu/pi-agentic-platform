import { composeDeliverySide } from "./compose-push-delivery.ts";
import { composeTransportSide } from "./compose-push-transport.ts";
import { pushRpc, type PushDeps, type PushRpc, type PushSeams } from "./modules/push/index.ts";

export { PUSH_MIGRATIONS, type PushSeams } from "./modules/push/index.ts";

/**
 * The push composition (M12): chain A's transport side, then chain B's delivery side over the transport's ports.
 * Written by Task 1 and the join (task 20) only: each chain edits its own file. A boot step goes in a side's own
 * function, which runs before the server listens; what must stop with the daemon goes to `deps.closers`.
 */
export function composePush(deps: PushDeps, seams?: PushSeams): { readonly rpc: PushRpc } {
  if (deps.config.testPushLoopback)
    deps.logger.warn("push_test_loopback", {
      hint: "PAP_TEST_PUSH_LOOPBACK is set: push endpoints on loopback are accepted. For tests only.",
    });
  const transportSide = composeTransportSide(deps, seams);
  const deliverySide = composeDeliverySide(deps, transportSide);
  return { rpc: pushRpc(transportSide.rpc, deliverySide.rpc) };
}
