import { KeybindingRule } from "@pap/contracts";
import { create } from "zustand";
import { createAccountDocument, type AccountStatus } from "../../lib/account-setting.ts";
import { reportClientIssue } from "../../lib/report.ts";
import type { Runtime } from "../../runtime/index.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "./defaults.ts";
import { mergeWithDefaults, type ResolvedRule, type RuleIssue } from "./resolve.ts";

const CACHE_KEY = "pap.keybindings.v1";
const MAX_RULES = 256;

/** Field by field for a list (M3-RT-29): the valid rules among the first 256; one report when any was dropped. */
export function parseRules(value: unknown): KeybindingRule[] {
  if (!Array.isArray(value)) return [];
  const rules: KeybindingRule[] = [];
  for (const entry of value.slice(0, MAX_RULES)) {
    const parsed = KeybindingRule.safeParse(entry);
    if (parsed.success) rules.push(parsed.data);
  }
  if (rules.length !== value.length) reportClientIssue("keybindings_invalid");
  return rules;
}

function readCache(): KeybindingRule[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw === null ? [] : parseRules(JSON.parse(raw));
  } catch {
    reportClientIssue("keybindings_invalid"); // unreadable JSON or a locked-down storage: the defaults apply
    return [];
  }
}
function writeCache(rules: readonly KeybindingRule[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(rules));
  } catch {
    reportClientIssue("storage_refused");
  }
}

interface KeybindingsState {
  readonly user: readonly KeybindingRule[];
  readonly rules: readonly ResolvedRule[];
  readonly issues: readonly RuleIssue[];
  readonly status: AccountStatus;
  setUser(next: readonly KeybindingRule[]): void;
  replaceFromServer(next: readonly KeybindingRule[]): void;
  setStatus(status: AccountStatus): void;
}

const resolve = (user: readonly KeybindingRule[]) =>
  mergeWithDefaults(DEFAULT_KEYBINDINGS, user, KNOWN_COMMANDS);

export const useKeybindingsStore = create<KeybindingsState>()((set) => {
  const user = readCache();
  return {
    user,
    ...resolve(user),
    status: "local",
    setUser: (next) => {
      writeCache(next);
      const resolved = resolve(next);
      if (resolved.issues.length > 0) reportClientIssue("keybindings_invalid");
      set({ user: next, ...resolved });
    },
    replaceFromServer: (next) => {
      writeCache(next);
      set({ user: next, ...resolve(next) });
    },
    setStatus: (status) => set({ status }),
  };
});

let active: { stop(): void } | null = null;
let sync: ((rpc: Runtime["rpc"]) => Promise<void>) | null = null;

/** Creates the account document and follows the store (once, before the first render, like startAppearance). */
export function startKeybindings(): { stop(): void } {
  active?.stop();
  let adopting = false;
  const doc = createAccountDocument<readonly KeybindingRule[]>({
    key: "keybindings",
    write: (value, baseRevision) => ({ key: "keybindings", value: [...value], baseRevision }),
    parse: parseRules,
    changed: (previous, next) => (JSON.stringify(previous) === JSON.stringify(next) ? [] : ["rules"]),
    merge: (server, local, dirty) => (dirty.has("rules") ? local : server),
    local: () => useKeybindingsStore.getState().user,
    adopt: (next) => {
      adopting = true;
      try {
        useKeybindingsStore.getState().replaceFromServer(next);
      } finally {
        adopting = false;
      }
    },
    onStatus: (status) => useKeybindingsStore.getState().setStatus(status),
  });
  const unsubscribe = useKeybindingsStore.subscribe((state, previous) => {
    if (state.user !== previous.user && !adopting) doc.change(previous.user, state.user);
  });
  sync = (rpc) => doc.sync(rpc);
  active = {
    stop() {
      unsubscribe();
      doc.dispose();
      sync = null;
      active = null;
    },
  };
  return active;
}

/** Each time the socket opens (Task 19b). */
export function syncKeybindings(rpc: Runtime["rpc"]): Promise<void> {
  return sync?.(rpc) ?? Promise.resolve();
}

// A hot update replaces this module: the old document must not keep its subscription (R125).
if (import.meta.hot) import.meta.hot.dispose(() => active?.stop());
