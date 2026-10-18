import { join } from "node:path";
import type { Hono } from "hono";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createGoogleFetcher, type Fetcher } from "./google-fetch.ts";
import { mountFonts } from "./routes.ts";
import { fontsRpc, type FontsRpc } from "./rpc.ts";
import { createFontsService } from "./service.ts";
import { createFontsStore } from "./store.ts";

export type { Fetcher, FetchResult } from "./google-fetch.ts";
export type { FontsRpc } from "./rpc.ts";

export interface FontsModule {
  readonly rpc: FontsRpc;
  mount(app: Hono): void;
}

/** Google Fonts downloaded by pap (the family is typed by the owner) and served from `$PAP_HOME/fonts` on pap's own origin. */
export function createFontsModule(deps: {
  readonly home: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Tests only: replaces the Google fetcher. */
  readonly fetcher?: Fetcher | undefined;
}): FontsModule {
  const store = createFontsStore(join(deps.home, "fonts"), deps.logger.child({ module: "fonts" }));
  const service = createFontsService({
    store,
    fetch: deps.fetcher ?? createGoogleFetcher({ clock: deps.clock }),
    clock: deps.clock,
    logger: deps.logger.child({ module: "fonts" }),
  });
  return { rpc: fontsRpc(service), mount: (app) => mountFonts(app, store) };
}
