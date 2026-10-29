// The fixtures every journey imports (frozen for A2 to A5). `pap` is worker-scoped: one built daemon per spec file and
// project (M13R3, M13R41), with the script and the extra environment of the file's `test.use({ papScript, papEnv })`;
// Playwright starts a new worker, hence a new daemon, when they differ between files. `signedIn` is test-scoped: it
// gives the test a page that already holds the owner's session.
import { test as base, type Page } from "@playwright/test";
import { login, SESSION_COOKIE, setupOwner, setupToken, stepUp as confirmPassword } from "./auth.ts";
import { type PapProcess, type ScriptStep, startPap } from "./daemon.ts";
import { type NameProxy, startNameProxy } from "./name-proxy.ts";
import { rpcCall } from "./rpc.ts";

export { expect } from "@playwright/test";
export { plural, t } from "./catalog.ts";
export type { ScriptStep } from "./daemon.ts";

export interface PapInstance extends PapProcess {
  /** Needs an owner: it signs in with `owner` on first use and keeps the session cookie inside. */
  rpc<T = unknown>(method: string, params?: object): Promise<T>;
  /** The loopback forward proxy of `papProxy` (J19, J20); null without it. */
  readonly proxy: NameProxy | null;
}

interface OwnerState {
  cookie: string | undefined;
  projectAdded: boolean;
}
const owners = new WeakMap<PapInstance, OwnerState>();
const ownerOf = (pap: PapInstance): OwnerState => {
  const state = owners.get(pap);
  if (!state) throw new Error("this PapInstance was not made by the pap fixture");
  return state;
};

export const test = base.extend<
  { signedIn: Page },
  {
    pap: PapInstance;
    papScript: ScriptStep[];
    papEnv: Record<string, string>;
    papArgs: string[];
    papProxy: string[];
  }
>({
  papScript: [[], { scope: "worker", option: true }],
  papEnv: [{}, { scope: "worker", option: true }],
  /** Extra flags of `pap serve` (J20: `["--insecure-http"]`). */
  papArgs: [[], { scope: "worker", option: true }],
  /**
   * Host names the browser context reaches through a forward proxy on loopback (name-proxy.ts): `["pap.test"]` is J20's LAN
   * mode, `["localhost"]` lets J19 read the status of an answer the browser hides from the page (a CORP-blocked one).
   */
  papProxy: [[], { scope: "worker", option: true }],
  pap: [
    async ({ papScript, papEnv, papArgs, papProxy }, use) => {
      const proxy =
        papProxy.length > 0
          ? await startNameProxy(Object.fromEntries(papProxy.map((name) => [name, "127.0.0.1"])))
          : null;
      let started: Awaited<ReturnType<typeof startPap>>;
      try {
        started = await startPap(papScript, papEnv, papArgs);
      } catch (error) {
        await proxy?.close();
        throw error;
      }
      const { pap: proc, cleanup } = started;
      const state: OwnerState = { cookie: undefined, projectAdded: false };
      const pap: PapInstance = {
        ...proc,
        proxy,
        async rpc<T>(method: string, params: object = {}): Promise<T> {
          state.cookie ??= await login(pap.origin, pap.owner);
          try {
            return await rpcCall<T>(pap.origin, state.cookie, method, params);
          } catch (error) {
            if (!String(error).includes("/ws answered 401")) throw error;
            state.cookie = await login(pap.origin, pap.owner);
            return rpcCall<T>(pap.origin, state.cookie, method, params);
          }
        },
      };
      owners.set(pap, state);
      try {
        await use(pap);
      } finally {
        await cleanup();
        await proxy?.close();
      }
    },
    { scope: "worker" },
  ],
  // The built-in `proxy` option of the browser context: set from the pap fixture, since the proxy's port is known only then.
  // Chromium sends loopback names straight to the network unless `<-loopback>` lifts its implicit bypass.
  proxy: async ({ pap, browserName }, use) => {
    await use(
      pap.proxy === null
        ? undefined
        : { server: pap.proxy.url, ...(browserName === "chromium" ? { bypass: "<-loopback>" } : {}) },
    );
  },
  signedIn: async ({ page, context, pap }, use) => {
    const state = ownerOf(pap);
    // Setup through the API, once per worker; J01 is the one journey that does it through the page.
    state.cookie ??= await setupOwner(pap.origin, setupToken(pap.setupUrl), pap.owner);
    await context.addCookies([{ name: SESSION_COOKIE, value: state.cookie, url: pap.origin }]);
    if (!state.projectAdded) {
      await pap.rpc("projects.add", { root: pap.work });
      state.projectAdded = true;
    }
    await use(page);
  },
});

/**
 * `test.use({ papScript: scripted([...]) })`. Playwright reads a bare array in `use` as a `[value, options]` fixture pair, so a
 * script (an array) is wrapped in one.
 */
export const scripted = (steps: ScriptStep[]): [ScriptStep[], { scope: "worker" }] => [
  steps,
  { scope: "worker" },
];

const isWebKit = (page: Page): boolean => page.context().browser()?.browserType().name() === "webkit";

/** Meta+K on WebKit, Control+K elsewhere. */
export const palette = (page: Page): Promise<void> => chord(page, "k");

/** Meta+<key> on WebKit, Control+<key> elsewhere. A single-character key is lowercased (`S` presses `s`); named keys (`Enter`) are kept. */
export const chord = (page: Page, key: string): Promise<void> =>
  page.keyboard.press(`${isWebKit(page) ? "Meta" : "Control"}+${key.length === 1 ? key.toLowerCase() : key}`);

/** Confirms the owner password: the next step-up-gated action passes (five minutes). */
export const stepUp = (page: Page, pap: PapInstance): Promise<void> => confirmPassword(page, pap);
