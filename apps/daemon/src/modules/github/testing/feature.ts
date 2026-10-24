import type { Caller } from "@pap/contracts";
import type { Hono } from "hono";
import { createHttpApp } from "../../../kernel/http/app.ts";
import { httpCaller } from "../../../kernel/http/caller.ts";
import { testCaller } from "../../../testing/caller.ts";
import { createGithubFeature, type GithubFeature } from "../index.ts";
import { type GithubBed, OWNER, startGithubBed } from "./bed.ts";

export const PAP_ORIGIN = "http://pap.test";
/** Another address pap answers to (a LAN name beside the one the App was created on). */
export const SECOND_ORIGIN = "http://pap-lan.test";
export const COOKIE = "pap_session=good";

export interface FeatureBed extends GithubBed {
  readonly feature: GithubFeature;
  readonly app_: Hono;
  readonly audit: Array<{ ownerId: string; reason: string }>;
  readonly caller: Caller;
}

/** The bed with the App file removed (nothing created yet), the feature composed and an HTTP app that knows one cookie. */
export async function startFeatureBed(options: { withApp?: boolean } = {}): Promise<FeatureBed> {
  const bed = await startGithubBed();
  if (options.withApp !== true) bed.core.appSecrets.forget();
  const caller = testCaller({ userId: OWNER });
  const audit: FeatureBed["audit"] = [];
  const feature = createGithubFeature(bed.core, {
    audit: { append: (line) => audit.push({ ownerId: line.ownerId ?? "", reason: line.reason }) },
    clock: bed.clock,
    logger: bed.logger,
    httpCaller: httpCaller((header) => (header === COOKIE ? caller : null)),
    allowedOrigins: new Set([PAP_ORIGIN, SECOND_ORIGIN]),
    hostLabel: "my.host",
  });
  const app_ = createHttpApp({
    allowedOrigins: new Set([PAP_ORIGIN]),
    staticRoot: null,
    logger: bed.logger,
    mount: (hono) => feature.mount(hono),
    wsProbe: (c) => c.json({ protocol: 1 }),
  });
  return Object.assign(Object.create(bed) as GithubBed, bed, { feature, app_, audit, caller }) as FeatureBed;
}
