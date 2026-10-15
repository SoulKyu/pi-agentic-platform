import { AutomationSettings } from "@pap/contracts";
import { RpcError, type Runtime } from "../../runtime/index.ts";

/**
 * Writes the `automation` setting's `paused` flag (M10R113) with the revision it just read. A `conflict` (another tab
 * wrote first) reads again and tries once more, the M3 settings rule. A stored value this build cannot read is never
 * overwritten.
 */
export async function writePaused(rpc: Runtime["rpc"], paused: boolean): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const read = await rpc.call("settings.get", { key: "automation" });
    const current = AutomationSettings.safeParse(read.value ?? {});
    if (!current.success) throw new RpcError("bad_request");
    try {
      await rpc.call(
        "settings.set",
        { key: "automation", value: { ...current.data, paused }, baseRevision: read.revision },
        { commandId: rpc.newCommandId() },
      );
      return;
    } catch (failure) {
      if (attempt > 0 || !(failure instanceof RpcError) || failure.code !== "conflict") throw failure;
    }
  }
}
