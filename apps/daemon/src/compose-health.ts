import type { M10Core } from "./compose-automation.ts";
import type { Outbox } from "./kernel/outbox/index.ts";
import { createHealthModule, type HealthModule } from "./modules/health/index.ts";

/** The health module over the kernel's handles, beside the outbox it listens to (M10 composition, Task 4). */
export function composeHealth(core: M10Core, outbox: Outbox): HealthModule {
  return createHealthModule({
    clock: core.clock,
    logger: core.logger,
    hub: core.hub,
    outbox,
  });
}
