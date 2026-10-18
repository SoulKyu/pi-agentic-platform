import type { AccountAppearance } from "@pap/contracts";
import { createAccountDocument, type AccountDocument } from "../../lib/account-setting.ts";
import { reportClientIssue } from "../../lib/report.ts";
import type { Runtime } from "../../runtime/index.ts";
import { toast } from "@pap/ui";
import { t } from "../../i18n/index.ts";
import { applyAppearance, inlineAppearanceVars, syncThemeColor, writeBootCache } from "./apply.ts";
import { customSlug } from "./fonts.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import {
  changedAccountFields,
  mergeAccount,
  mergeCutsThemes,
  parseAccount,
  resolveAppearance,
  toBootCache,
} from "./model.ts";

const LIGHT = "(prefers-color-scheme: light)";
/** Blocked storage can throw on the property read itself: the appearance still applies, only the boot cache is lost. */
function bootStorage(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

// One import site: the chunk with the installed-font list and the stylesheet links, loaded when a custom font is first chosen.
const loadFontSupport = () => import("./font-support.ts");
type FontSupport = Awaited<ReturnType<typeof loadFontSupport>>;
const usesCustomFont = ({ uiFont, monoFont }: AccountAppearance): boolean =>
  customSlug(uiFont) !== null || customSlug(monoFont) !== null;

let active: { stop(): void } | null = null;
let accountDocument: AccountDocument<AccountAppearance> | null = null;

/** Applies the appearance now and on every change of the store or of the system theme. Once, before the first render. */
export function startAppearance(win: Window = window): { stop(): void } {
  active?.stop();
  const root = win.document.documentElement;
  // Start from what the boot script set, so the first apply removes what the app no longer resolves (M3-RT-11).
  let vars = inlineAppearanceVars(root);
  const media = typeof win.matchMedia === "function" ? win.matchMedia(LIGHT) : null;
  let fonts: FontSupport | null = null;
  let fontsRequested = false;
  let stopFonts: (() => void) | null = null;
  let stopped = false;
  const apply = () => {
    const { account, device } = useAppearanceStore.getState();
    if (!fontsRequested && usesCustomFont(account)) {
      fontsRequested = true;
      loadFontSupport()
        .then((support) => {
          if (stopped) return;
          fonts = support;
          stopFonts = support.useFontsStore.subscribe(apply);
          apply();
        })
        .catch(() => reportClientIssue("lazy_chunk_failed")); // the default font stays
    }
    const families = fonts?.useFontsStore.getState().families ?? null;
    const resolved = resolveAppearance(account, device, media?.matches ?? false, families);
    vars = applyAppearance(root, resolved, vars);
    fonts?.syncFontLinks(win.document, resolved.fontSlugs ?? []);
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
    merge: (server, local, dirty, base) => {
      const merged = mergeAccount(server, local, dirty, base);
      if (mergeCutsThemes(server, local, dirty, base))
        toast({ message: t("appearance.themeNotKept"), tone: "error" });
      return merged;
    },
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
      stopped = true;
      stopFonts?.();
      doc.dispose();
      if (accountDocument === doc) accountDocument = null;
      active = null;
    },
  };
  return active;
}

/** Each time the socket opens (Task 19b): read the server copy, merge this device's changes, send them. */
export async function syncAccountAppearance(rpc: Runtime["rpc"]): Promise<void> {
  await accountDocument?.sync(rpc);
  // The list of downloaded fonts is only needed to draw a custom choice: nobody else pays the call.
  if (!usesCustomFont(useAppearanceStore.getState().account)) return;
  try {
    await (await loadFontSupport()).loadFonts(rpc);
  } catch {
    reportClientIssue("lazy_chunk_failed"); // the default font stays
  }
}

// A hot update replaces this module: the old controller must not keep its listeners (R125).
if (import.meta.hot) import.meta.hot.dispose(() => active?.stop());
