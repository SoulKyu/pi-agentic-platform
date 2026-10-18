import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import { createFontsModule, type Fetcher, type FontsModule } from "./modules/fonts/index.ts";

export type { Fetcher } from "./modules/fonts/index.ts";

/** Google Fonts: the RPC methods and the `/fonts` mount. `fetcher` is for tests; the default is the guarded Google fetcher. */
export function composeFonts(
  core: { readonly config: Pick<Config, "home">; readonly clock: Clock; readonly logger: Logger },
  fetcher?: Fetcher,
): FontsModule {
  return createFontsModule({ home: core.config.home, clock: core.clock, logger: core.logger, fetcher });
}
