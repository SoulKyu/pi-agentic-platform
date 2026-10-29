/// <reference lib="dom" />
// What J19 and J20 share (UX2-R86, UX2-R87): the stand-in framed in pap's real signed-in page with the real preview sandbox,
// the observers (Playwright's network events, the page's own CSP violations) and the reads from outside (files on disk).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { SESSION_COOKIE } from "./auth.ts";
import { type PapInstance, t } from "./fixtures.ts";
import { startStandIn, type StandIn } from "./stand-in.ts";

/** `PREVIEW_SANDBOX` of packages/ui (SandboxedFrame.tsx): E2E code imports no `@pap/*`; the stand-in's CSP carries the same set. */
export const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-downloads";
/** The off-limits address of the CSP page (TEST-NET-1, RFC 5737: never routable). */
export const OFF_LIMITS = "http://192.0.2.1/";

export interface Answer {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The URL of the frame that started the request. */
  readonly from: string;
}
export interface Observed {
  /** Every response any page of the context received, headers included (Playwright's network events). */
  answers(): Promise<Answer[]>;
  /** Every request the context started, with the URL of the frame that started it. */
  readonly requests: { url: string; from: string }[];
  /** Every request that failed in the network, with the browser's reason. */
  readonly failures: string[];
  /** Every WebSocket a page opened, with the frames it received. */
  readonly sockets: { url: string; received: number }[];
  /** The `securitypolicyviolation` events of pap's own document. */
  violations(): Promise<string[]>;
}

/** A service worker's request has no frame (Playwright throws): it belongs to no page. */
function frameUrl(frame: () => { url(): string }): string {
  try {
    return frame().url();
  } catch {
    return "";
  }
}

export function observe(page: Page): Observed {
  const context: BrowserContext = page.context();
  const pending: Promise<Answer>[] = [];
  const requests: { url: string; from: string }[] = [];
  const sockets: { url: string; received: number }[] = [];
  const failures: string[] = [];
  context.on("request", (request) => {
    requests.push({ url: request.url(), from: frameUrl(() => request.frame()) });
  });
  context.on("requestfailed", (request) =>
    failures.push(`${request.url()} ${request.failure()?.errorText ?? ""}`),
  );
  context.on("response", (response) => {
    pending.push(
      response
        .allHeaders()
        .catch(() => response.headers())
        .then((headers) => ({
          status: response.status(),
          url: response.url(),
          headers,
          from: frameUrl(() => response.frame()),
        })),
    );
  });
  page.on("websocket", (socket) => {
    const entry = { url: socket.url(), received: 0 };
    sockets.push(entry);
    socket.on("framereceived", () => entry.received++);
  });
  return {
    answers: () => Promise.all(pending),
    requests,
    failures,
    sockets,
    violations: () =>
      page.evaluate(() => (Reflect.get(window, "__violations") as string[] | undefined) ?? []),
  };
}

/** Records pap's own `securitypolicyviolation` events from the first byte (J18 does the same). */
export const recordViolations = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    const seen: string[] = [];
    Reflect.set(window, "__violations", seen);
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
};

/** The owner's cookie as the daemon sets it: `SameSite=Strict`, `HttpOnly` (the fixture adds it without either). */
export async function strictCookie(context: BrowserContext, pap: PapInstance): Promise<string> {
  const cookie = (await context.cookies(pap.origin)).find((c) => c.name === SESSION_COOKIE);
  if (cookie === undefined) throw new Error("the signed-in context holds no session cookie");
  await context.addCookies([
    { name: SESSION_COOKIE, value: cookie.value, url: pap.origin, httpOnly: true, sameSite: "Strict" },
  ]);
  return cookie.value;
}

export interface Planted {
  readonly standIn: StandIn;
  readonly canary: string;
  readonly canaryText: string;
  readonly marker: string;
  readonly projectBefore: string[];
}

/** Plants the canary (an image name, so `/files/raw` serves it inline to the owner) and starts the stand-in on `origin`. */
export async function plant(pap: PapInstance, standInOrigin: string, tag: string): Promise<Planted> {
  const canaryText = `CANARY-${tag}-${Math.random().toString(16).slice(2)}`;
  const canary = join(pap.work, `canary-${tag}.png`);
  writeFileSync(canary, canaryText);
  const marker = `UPLOAD-MARKER-${tag}-${Math.random().toString(16).slice(2)}`;
  const standIn = await startStandIn(pap.standInPort, standInOrigin, {
    listener: `http://127.0.0.1:${pap.previewPort}`,
    app: pap.origin,
    canary,
    marker,
    offLimits: OFF_LIMITS,
  });
  return { standIn, canary, canaryText, marker, projectBefore: readdirSync(pap.work) };
}

/** Files under the daemon's home (and the project) that hold `needle`: an upload that went through would leave one. */
export function filesHolding(pap: PapInstance, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && statSync(path).size < 4_000_000 && readFileSync(path).includes(needle))
        hits.push(path);
    }
  };
  walk(pap.home);
  walk(pap.work);
  return hits;
}

/** The stand-in's dataset once its probes settled. */
export type Outcome = Record<string, string | undefined>;

/**
 * Inserts `<iframe sandbox=PREVIEW_SANDBOX referrerpolicy=no-referrer src=...>` into the signed-in page (the one context where
 * WebKit sends pap's cookie), waits for the probes and returns what the frame wrote about them.
 */
export async function frameStandIn(page: Page, src: string): Promise<Outcome> {
  await page.evaluate(
    ({ src: url, sandbox }) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", sandbox);
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = "stand-in";
      frame.src = url;
      document.body.append(frame);
    },
    { src, sandbox: PREVIEW_SANDBOX },
  );
  const inside = () => page.frames().find((f) => f.url() === src);
  const read = async (): Promise<Outcome | null> => {
    try {
      return (await inside()?.evaluate(() => ({ ...document.body.dataset }))) ?? null;
    } catch {
      return null; // the frame is still navigating
    }
  };
  await expect.poll(async () => (await read())?.["done"], { timeout: 20_000 }).toBe("1");
  const outcome = await read();
  if (outcome === null) throw new Error("the stand-in frame disappeared");
  return outcome;
}

/** The violations a page wrote in the form `<effective directive> <blocked URI>`. */
export const violationsOf = (outcome: Outcome): string[] => JSON.parse(outcome["csp"] ?? "[]") as string[];

export interface Run {
  readonly outcome: Outcome;
  readonly planted: Planted;
  readonly seen: Observed;
  /** Where each log stood when the frame was inserted: pap's own page opens requests and a socket of its own. */
  readonly before: { sockets: number; requests: number; proxied: number };
  readonly standIn: string;
  /** The owner's session cookie value. */
  readonly cookie: string;
}

/**
 * Signs the context's cookie as the daemon sets it, plants the canary, opens pap's page, frames the stand-in's `kind` page in it
 * and hands what happened to `assert`. The stand-in is closed afterwards, whatever `assert` does.
 */
export async function withRun(
  pap: PapInstance,
  page: Page,
  standInOrigin: string,
  kind: "headers" | "bare",
  assert: (run: Run) => Promise<void>,
): Promise<void> {
  await recordViolations(page.context());
  const cookie = await strictCookie(page.context(), pap);
  const planted = await plant(pap, standInOrigin, kind);
  try {
    const seen = observe(page);
    await page.goto(pap.origin);
    await expect(page.getByLabel(t("launch.field"), { exact: true })).toBeVisible();
    const before = {
      sockets: seen.sockets.length,
      requests: seen.requests.length,
      proxied: pap.proxy?.requests.length ?? 0,
    };
    const outcome = await frameStandIn(page, `${standInOrigin}/${kind}`);
    await assert({ outcome, planted, seen, before, standIn: standInOrigin, cookie });
  } finally {
    await planted.standIn.close();
  }
}

/**
 * What the proxy forwarded to pap's `/files/raw`, `/upload` and `/ws` for the frame since it was inserted (pap's own page never
 * calls the first two on its home screen and opens its own socket under its own `Origin`; the frame's requests carry `Origin: null`
 * or, for a no-cors read, none).
 */
export const reachedPap = (pap: PapInstance, run: Run) =>
  (pap.proxy?.requests.slice(run.before.proxied) ?? []).filter(
    (r) =>
      /^\/(?:files\/raw|upload)(?:\?|$)/u.test(r.path) ||
      (/^\/ws(?:\?|$)/u.test(r.path) && r.headers.origin === "null"),
  );

/**
 * The service CSP alone (J19 on localhost, J20 in LAN mode): four probes, four `connect-src` violations each naming its own
 * target, nothing started by the frame, nothing at pap, nothing uploaded.
 */
export async function expectCspStopsEveryProbe(pap: PapInstance, run: Run): Promise<void> {
  const { outcome, planted, seen, before, standIn } = run;
  const blocked = violationsOf(outcome);
  for (const target of [
    `${pap.origin}/files/raw?path=`,
    `${pap.origin}/upload?`,
    `${pap.origin.replace("http", "ws")}/ws?proto=2`,
    OFF_LIMITS,
  ])
    expect(
      blocked.some((v) => v.startsWith("connect-src ") && v.includes(target)),
      `${target} in ${blocked.join(" | ")}`,
    ).toBe(true);
  expect(blocked.filter((v) => v.startsWith("connect-src "))).toHaveLength(blocked.length);
  expect(outcome).toMatchObject({
    read: "blocked",
    readNoCors: "blocked",
    post: "blocked",
    socket: "blocked",
    offLimits: "blocked",
  });
  expect(outcome["readText"]).toBeUndefined();
  // Nothing left the frame: no request started by the frame, none at pap (the proxy saw the wire), none at the off-limits address.
  const started = seen.requests.slice(before.requests);
  expect(
    started.filter(
      ({ url, from }) =>
        (from.startsWith(standIn) && url !== `${standIn}/headers`) || url.includes("192.0.2.1"),
    ),
  ).toEqual([]);
  expect(
    (await seen.answers()).filter((a) => a.from.startsWith(standIn) && a.url !== `${standIn}/headers`),
  ).toEqual([]);
  expect(reachedPap(pap, run)).toEqual([]);
  expect(pap.proxy?.requests.slice(before.proxied).filter((r) => r.host.startsWith("192.0.2.1"))).toEqual([]);
  expect(JSON.stringify(outcome)).not.toContain(planted.canaryText);
  expect(filesHolding(pap, planted.marker)).toEqual([]);
  // pap's own document took no violation: its frame-src admitted the stand-in.
  expect(await seen.violations()).toEqual([]);
}

/** The frame's page holds nothing of the canary, and the project folder is as it was. */
export async function expectNoLeak(pap: PapInstance, page: Page, run: Run): Promise<void> {
  const { outcome, planted, standIn } = run;
  expect(outcome["readText"]).toBeUndefined();
  expect(JSON.stringify(outcome)).not.toContain(planted.canaryText);
  expect(
    await page
      .frames()
      .find((f) => f.url() === `${standIn}/bare`)
      ?.content(),
  ).not.toContain(planted.canaryText);
  expect(filesHolding(pap, planted.marker)).toEqual([]);
  expect(readdirSync(pap.work)).toEqual(planted.projectBefore);
}
