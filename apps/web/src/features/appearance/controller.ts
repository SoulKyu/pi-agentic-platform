import type { AccountAppearance } from "@pap/contracts";
import { createAccountDocument, type AccountDocument } from "../../lib/account-setting.ts";
import { reportClientIssue } from "../../lib/report.ts";
import type { Runtime } from "../../runtime/index.ts";
import { applyAppearance, inlineAppearanceVars, syncThemeColor, writeBootCache } from "./apply.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { changedAccountFields, mergeAccount, parseAccount, resolveAppearance, toBootCache } from "./model.ts";

const LIGHT = "(prefers-color-scheme: light)";
/** Blocked storage can throw on the property read itself: the appearance still applies, only the boot cache is lost. */
function bootStorage(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

let active: { stop(): void } | null = null;
let accountDocument: AccountDocument<AccountAppearance> | null = null;

/** Applies the appearance now and on every change of the store or of the system theme. Once, before the first render. */
export function startAppearance(win: Window = window): { stop(): void } {
  active?.stop();
  const root = win.document.documentElement;
  // Start from what the boot script set, so the first apply removes what the app no longer resolves (M3-RT-11).
  let vars = inlineAppearanceVars(root);
  const media = typeof win.matchMedia === "function" ? win.matchMedia(LIGHT) : null;
  const apply = () => {
    const { account, device } = useAppearanceStore.getState();
    vars = applyAppearance(root, resolveAppearance(account, device, media?.matches ?? false), vars);
    const storage = bootStorage(win);
    if (storage) writeBootCache(storage, toBootCache(account, device));
    else reportClientIssue("boot_cache_refused");
    syncThemeColor(root, win.document);
  };
  let adopting = false;
  const doc = createAccountDocument<AccountAppearance>({
    key: "appearance",
    write: (value, baseRevision) => ({ key: "appearance", value, baseRevision }),
    parse: parseAccount,
    changed: changedAccountFields,
    merge: mergeAccount,
    local: () => useAppearanceStore.getState().account,
    adopt: (account) => {
      adopting = true;
      try {
        useAppearanceStore.getState().replaceFromServer(account);
      } finally {
        adopting = false;
      }
    },
    onStatus: (status) => useAppearanceStore.getState().setAccountStatus(status),
  });
  accountDocument = doc;
  apply();
  media?.addEventListener("change", apply);
  const unsubscribe = useAppearanceStore.subscribe((state, previous) => {
    if (state.account === previous.account && state.device === previous.device) return;
    apply();
    if (state.account !== previous.account && !adopting) doc.change(previous.account, state.account);
  });
  active = {
    stop() {
      media?.removeEventListener("change", apply);
      unsubscribe();
      doc.dispose();
      if (accountDocument === doc) accountDocument = null;
      active = null;
    },
  };
  return active;
}

/** Each time the socket opens (Task 19b): read the server copy, merge this device's changes, send them. */
export function syncAccountAppearance(rpc: Runtime["rpc"]): Promise<void> {
  return accountDocument?.sync(rpc) ?? Promise.resolve();
}

// A hot update replaces this module: the old controller must not keep its listeners (R125).
if (import.meta.hot) import.meta.hot.dispose(() => active?.stop());
