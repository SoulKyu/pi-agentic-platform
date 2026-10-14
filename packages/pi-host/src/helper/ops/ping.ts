import { z } from "zod";
import type { HelperOp } from "../ops.ts";

/**
 * The smallest operation: proves the helper starts, loads the Pi SDK and answers. The SDK is loaded here, when the
 * operation runs, so that a helper whose operation does not need it (the test operations) starts without its cost.
 */
export const ping: HelperOp<Record<string, never>, { piVersion: string }> = {
  params: z.object({}).strict(),
  run: async () => {
    const { VERSION } = await import("@earendil-works/pi-coding-agent");
    return { piVersion: VERSION };
  },
};
