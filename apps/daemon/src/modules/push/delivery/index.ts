/** Chain B's barrel; `push/index.ts` re-exports it whole, so chain B never edits the module's own index. */
export { deliveryRpc, type DeliveryRpc } from "./rpc.ts";
export { createNotifier } from "./notifier.ts";
export { createPresence } from "./presence.ts";
export { createCooldown } from "./cooldown.ts";
export type { SendDeps } from "./send.ts";
export { createDigestScheduler, type DigestVerdict } from "./digest.ts";
export type { EventRow } from "./events.ts";
export { createPushHousekeeping } from "./housekeeping.ts";
export { createTestPush } from "./test-push.ts";
export { wireInboxSource } from "./source-inbox.ts";
export { wireSessionSource } from "./source-sessions.ts";
export { createOpenPush } from "./open.ts";
export { wireBudgetSource } from "./source-budget.ts";

import type { Outbox } from "../../../kernel/outbox/index.ts";
import type { PushNotifier } from "../service.ts";
import { createDigestSend, type DigestVerdict } from "./digest.ts";
import type { EventRow } from "./events.ts";
import { createPushSend, type SendDeps } from "./send.ts";

/** The delivery side's effects on the outbox (M12R13, M12R17): `push.send`, and `digest.send` over the same notifier. */
export function registerPushEffects(
  outbox: Pick<Outbox, "register">,
  deps: SendDeps,
  digest: { notifier: Pick<PushNotifier, "notify">; judge: (event: EventRow) => DigestVerdict },
): void {
  outbox.register("push.send", createPushSend(deps));
  outbox.register(
    "digest.send",
    createDigestSend({ ...digest, db: deps.db, clock: deps.clock, logger: deps.logger }),
  );
}
