import { AutomationSettings } from "@pap/contracts";
import { RpcError, type Runtime } from "../../runtime/index.ts";

/**
 * Writes the `automation` setting the way every setting is written: read it, change it, send it with the revision read
 * (compare-and-set). On `conflict` it reads again and tries once more with the same change, so a field changed
 * elsewhere (the pause switch of the Tasks board) is kept. A stored document this build cannot read is never overwritten.
 */
export async function saveAutomation(
  rpc: Runtime["rpc"],
  change: (current: AutomationSettings) => AutomationSettings,
): Promise<AutomationSettings> {
  for (let attempt = 0; ; attempt++) {
    const read = await rpc.call("settings.get", { key: "automation" });
    const current = AutomationSettings.safeParse(read.value ?? {});
    if (!current.success) throw new RpcError("bad_request");
    const next = change(current.data);
    try {
      await rpc.call(
        "settings.set",
        { key: "automation", value: next, baseRevision: read.revision },
        { commandId: rpc.newCommandId() },
      );
      return next;
    } catch (failure) {
      if (attempt > 0 || !(failure instanceof RpcError) || failure.code !== "conflict") throw failure;
    }
  }
}
