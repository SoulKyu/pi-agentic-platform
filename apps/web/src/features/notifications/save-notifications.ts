import { NotificationsSettings } from "@pap/contracts";
import { RpcError, type Runtime } from "../../runtime/index.ts";

/**
 * Writes the `notifications` setting the way `saveAutomation` writes its own: read, change, send the whole document with
 * the revision read (compare-and-set). On `conflict` it reads again and applies the same change once more, so a field
 * another device changed meanwhile is kept. A stored document this build cannot read is never overwritten.
 */
export async function saveNotifications(
  rpc: Runtime["rpc"],
  change: (current: NotificationsSettings) => NotificationsSettings,
): Promise<NotificationsSettings> {
  for (let attempt = 0; ; attempt++) {
    const read = await rpc.call("settings.get", { key: "notifications" });
    const current = NotificationsSettings.safeParse(read.value ?? {});
    if (!current.success) throw new RpcError("bad_request");
    const next = change(current.data);
    try {
      await rpc.call(
        "settings.set",
        { key: "notifications", value: next, baseRevision: read.revision },
        { commandId: rpc.newCommandId() },
      );
      return next;
    } catch (failure) {
      if (attempt > 0 || !(failure instanceof RpcError) || failure.code !== "conflict") throw failure;
    }
  }
}
