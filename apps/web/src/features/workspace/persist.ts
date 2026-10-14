import { isTerminalId, isValidId, isValidRoot } from "./item-path.ts";
import {
  clampRatio,
  EMPTY_WORKSPACE,
  itemKey,
  MAX_TABS,
  SETTINGS_SECTIONS,
  type ItemRef,
  type SettingsSection,
  type Split,
  type Tab,
  type Workspace,
} from "./model.ts";

export const WORKSPACE_KEY = "pap.workspace.v1";
/** 24 tabs with splits are a few KB; anything larger is not ours. */
const MAX_RAW = 64_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseItem(value: unknown, devUi: boolean): ItemRef | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "home":
      return { kind: "home" };
    case "dev-ui":
      return devUi ? { kind: "dev-ui" } : null;
    case "session":
      return typeof value.id === "string" && isValidId(value.id) ? { kind: "session", id: value.id } : null;
    case "settings":
      return SETTINGS_SECTIONS.includes(value.section as SettingsSection)
        ? { kind: "settings", section: value.section as SettingsSection }
        : null;
    case "files":
    case "changes":
      return typeof value.root === "string" && isValidRoot(value.root)
        ? { kind: value.kind, root: value.root }
        : null;
    case "terminal":
      return typeof value.id === "string" && isTerminalId(value.id)
        ? { kind: "terminal", id: value.id }
        : null;
    default:
      return null;
  }
}

function parseSplit(value: unknown, owner: ItemRef, devUi: boolean): Split | null {
  if (!isRecord(value) || typeof value.ratio !== "number" || !Number.isFinite(value.ratio)) return null;
  const item = parseItem(value.item, devUi);
  return item && itemKey(item) !== itemKey(owner) ? { item, ratio: clampRatio(value.ratio) } : null;
}

function parseTab(value: unknown, devUi: boolean): Tab | null {
  if (!isRecord(value)) return null;
  const item = parseItem(value.item, devUi);
  if (!item || value.key !== itemKey(item)) return null;
  return { key: itemKey(item), item, split: parseSplit(value.split, item, devUi) };
}

/** Storage is untrusted: anything unknown, oversized or malformed gives the empty workspace (and `onRejected`), never a throw. */
export function parseWorkspace(raw: string | null, devUi: boolean, onRejected?: () => void): Workspace {
  if (raw === null) return EMPTY_WORKSPACE;
  const reject = (): Workspace => {
    onRejected?.();
    return EMPTY_WORKSPACE;
  };
  if (raw.length > MAX_RAW) return reject();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return reject();
  }
  if (!isRecord(data) || data.v !== 1 || !Array.isArray(data.tabs)) return reject();
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  let dropped = false;
  for (const candidate of data.tabs as unknown[]) {
    if (tabs.length >= MAX_TABS) break;
    const tab = parseTab(candidate, devUi);
    if (!tab || seen.has(tab.key)) {
      dropped = true;
      continue;
    }
    seen.add(tab.key);
    tabs.push(tab);
  }
  if (dropped) onRejected?.();
  const active =
    typeof data.active === "string" && seen.has(data.active) ? data.active : (tabs[0]?.key ?? null);
  return { tabs, active };
}

export const serializeWorkspace = (ws: Workspace): string =>
  JSON.stringify({ v: 1, tabs: ws.tabs, active: ws.active });
