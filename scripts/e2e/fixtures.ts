// The fixtures every journey imports (frozen for A2 to A5). `pap` is worker-scoped: one built daemon per spec file and
// project (M13R3, M13R41), with the script and the extra environment of the file's `test.use({ papScript, papEnv })`;
// Playwright starts a new worker, hence a new daemon, when they differ between files. `signedIn` is test-scoped: it
// gives the test a page that already holds the owner's session.
import { test as base, type Page } from "@playwright/test";
import { login, SESSION_COOKIE, setupOwner, setupToken, stepUp as confirmPassword } from "./auth.ts";
import { type PapProcess, type ScriptStep, startPap } from "./daemon.ts";
import { rpcCall } from "./rpc.ts";

export { expect } from "@playwright/test";
export { plural, t } from "./catalog.ts";
export type { ScriptStep } from "./daemon.ts";

export interface PapInstance extends PapProcess {
  /** Needs an owner: it signs in with `owner` on first use and keeps the session cookie inside. */
  rpc<T = unknown>(method: string, params?: object): Promise<T>;
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
  { pap: PapInstance; papScript: ScriptStep[]; papEnv: Record<string, string> }
>({
  papScript: [[], { scope: "worker", option: true }],
  papEnv: [{}, { scope: "worker", option: true }],
  pap: [
    async ({ papScript, papEnv }, use) => {
      const { pap: proc, cleanup } = await startPap(papScript, papEnv);
      const state: OwnerState = { cookie: undefined, projectAdded: false };
      const pap: PapInstance = {
        ...proc,
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
      }
    },
    { scope: "worker" },
  ],
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

const isWebKit = (page: Page): boolean => page.context().browser()?.browserType().name() === "webkit";

/** Meta+K on WebKit, Control+K elsewhere. */
export const palette = (page: Page): Promise<void> => chord(page, "k");

/** Meta+<key> on WebKit, Control+<key> elsewhere. */
export const chord = (page: Page, key: string): Promise<void> =>
  page.keyboard.press(`${isWebKit(page) ? "Meta" : "Control"}+${key.length === 1 ? key.toLowerCase() : key}`);

/** Confirms the owner password: the next step-up-gated action passes (five minutes). */
export const stepUp = (page: Page, pap: PapInstance): Promise<void> => confirmPassword(page, pap);
