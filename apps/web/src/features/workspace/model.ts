import type { Role } from "@pap/contracts";

export const SETTINGS_SECTIONS = [
  "appearance",
  "shortcuts",
  "language",
  "approvals",
  "models",
  "mcp",
  "skills",
  "automation",
  "health",
  "github",
  "agents",
  "notifications",
  "account",
  "users",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Pi's configuration and user management: a member's pap has none of it. Health stays (a member sees their own failures). */
export const OWNER_SECTIONS: readonly SettingsSection[] = ["models", "mcp", "skills", "users"];

/** The sections a role is shown (UX only: the daemon refuses what a member may not do). */
export const sectionsFor = (role: Role): readonly SettingsSection[] =>
  role === "owner"
    ? SETTINGS_SECTIONS
    : SETTINGS_SECTIONS.filter((section) => !OWNER_SECTIONS.includes(section));

export type SettingsGroupId = "you" | "work" | "install";

/** The three groups of the Settings nav (D4): what is yours, how the work runs, what this pap installs. */
export const SETTINGS_GROUPS: readonly {
  readonly id: SettingsGroupId;
  readonly sections: readonly SettingsSection[];
}[] = [
  { id: "you", sections: ["appearance", "shortcuts", "language", "notifications", "account"] },
  { id: "work", sections: ["agents", "approvals", "automation", "github"] },
  { id: "install", sections: ["models", "mcp", "skills", "users", "health"] },
];

/** `split` sections draw a list beside a detail (their forms cap themselves); every other body is one column. */
export const SETTINGS_LAYOUT: Record<SettingsSection, "column" | "split"> = {
  appearance: "split",
  shortcuts: "column",
  language: "column",
  approvals: "column",
  models: "split",
  mcp: "split",
  skills: "column",
  automation: "column",
  health: "column",
  github: "column",
  agents: "column",
  notifications: "column",
  account: "column",
  users: "column",
};

/** A deep link to a section the role is not shown opens Appearance. */
export const sectionFor = (role: Role, section: SettingsSection): SettingsSection =>
  sectionsFor(role).includes(section) ? section : "appearance";

export type ItemRef =
  | { readonly kind: "home" }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "settings"; readonly section: SettingsSection }
  | { readonly kind: "dev-ui" }
  | { readonly kind: "files"; readonly root: string }
  | { readonly kind: "changes"; readonly root: string }
  | { readonly kind: "terminal"; readonly id: string }
  | { readonly kind: "lane"; readonly id: string }
  | { readonly kind: "compare"; readonly id: string }
  | { readonly kind: "tasks" }
  | { readonly kind: "trigger"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string }
  /** A box's preview service (UX-2): `box` is the box key (`project:<uuid>`, `agent:<id>`). Not addressable. */
  | { readonly kind: "preview"; readonly box: string; readonly name: string };

export interface Split {
  readonly item: ItemRef;
  readonly ratio: number;
}
export interface Tab {
  readonly key: string;
  readonly item: ItemRef;
  readonly split: Split | null;
}
export interface Workspace {
  readonly tabs: readonly Tab[];
  readonly active: string | null;
}

export const EMPTY_WORKSPACE: Workspace = { tabs: [], active: null };
export const MAX_TABS = 24;
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;
export const DEFAULT_RATIO = 0.5;

export function itemKey(item: ItemRef): string {
  switch (item.kind) {
    case "session":
      return `session:${item.id}`;
    case "files":
    case "changes":
      return `${item.kind}:${item.root}`;
    case "terminal":
      return `terminal:${item.id}`;
    case "lane":
      return `lane:${item.id}`;
    case "compare":
      return `compare:${item.id}`;
    case "trigger":
      return `trigger:${item.id}`;
    case "agent":
      return `agent:${item.id}`;
    case "preview":
      return `preview:${item.box}/${item.name}`;
    case "home":
    case "settings":
    case "dev-ui":
    case "tasks":
      return item.kind;
  }
}

export const activeTab = (ws: Workspace): Tab | null => ws.tabs.find((tab) => tab.key === ws.active) ?? null;

export const clampRatio = (ratio: number): number =>
  Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(ratio) ? ratio : DEFAULT_RATIO));

/** Opens (or re-activates) an item. Past MAX_TABS the oldest inactive tab closes; nothing is deleted. */
export function openItem(ws: Workspace, item: ItemRef): Workspace {
  const key = itemKey(item);
  if (ws.tabs.some((tab) => tab.key === key)) {
    return { tabs: ws.tabs.map((tab) => (tab.key === key ? { ...tab, item } : tab)), active: key };
  }
  let tabs = [...ws.tabs, { key, item, split: null }];
  if (tabs.length > MAX_TABS) {
    const oldest = tabs.findIndex((tab) => tab.key !== ws.active && tab.key !== key);
    tabs = tabs.filter((_, index) => index !== oldest);
  }
  return { tabs, active: key };
}

export function closeTab(ws: Workspace, key: string): Workspace {
  const index = ws.tabs.findIndex((tab) => tab.key === key);
  if (index === -1) return ws;
  const tabs = ws.tabs.filter((tab) => tab.key !== key);
  if (ws.active !== key) return { tabs, active: ws.active };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, active: next?.key ?? null };
}

export function cycleTab(ws: Workspace, step: 1 | -1): Workspace {
  if (ws.tabs.length === 0) return ws;
  const index = Math.max(
    0,
    ws.tabs.findIndex((tab) => tab.key === ws.active),
  );
  const next = ws.tabs[(index + step + ws.tabs.length) % ws.tabs.length] as Tab;
  return { ...ws, active: next.key };
}

const updateTab = (ws: Workspace, key: string, change: (tab: Tab) => Tab): Workspace => {
  let changed = false;
  const tabs = ws.tabs.map((tab) => {
    if (tab.key !== key) return tab;
    const next = change(tab);
    changed ||= next !== tab;
    return next;
  });
  return changed ? { ...ws, tabs } : ws;
};

export const splitTab = (ws: Workspace, key: string, item: ItemRef): Workspace =>
  updateTab(ws, key, (tab) =>
    itemKey(item) === itemKey(tab.item)
      ? tab
      : { ...tab, split: { item, ratio: tab.split?.ratio ?? DEFAULT_RATIO } },
  );

export const unsplitTab = (ws: Workspace, key: string): Workspace =>
  updateTab(ws, key, (tab) => (tab.split ? { ...tab, split: null } : tab));

export const setSplitRatio = (ws: Workspace, key: string, ratio: number): Workspace =>
  updateTab(ws, key, (tab) => {
    const next = clampRatio(ratio);
    return tab.split && tab.split.ratio !== next ? { ...tab, split: { ...tab.split, ratio: next } } : tab;
  });

const restrictItem = (item: ItemRef, role: Role): ItemRef =>
  item.kind === "settings" && sectionFor(role, item.section) !== item.section
    ? { kind: "settings", section: sectionFor(role, item.section) }
    : item;

/** A workspace saved by an owner (or a tab opened by URL) holds no section the role is not shown: the tab becomes Appearance. */
export function restrictWorkspace(ws: Workspace, role: Role): Workspace {
  const seen = new Set<string>();
  const remap = new Map<string, string>();
  const tabs: Tab[] = [];
  for (const tab of ws.tabs) {
    const item = restrictItem(tab.item, role);
    const key = itemKey(item);
    remap.set(tab.key, key);
    if (seen.has(key)) continue;
    seen.add(key);
    const split = tab.split === null ? null : { ...tab.split, item: restrictItem(tab.split.item, role) };
    tabs.push(
      item === tab.item && split?.item === tab.split?.item && key === tab.key
        ? tab
        : { key, item, split: split !== null && itemKey(split.item) === key ? null : split },
    );
  }
  if (tabs.every((tab, index) => tab === ws.tabs[index]) && tabs.length === ws.tabs.length) return ws;
  return { tabs, active: ws.active === null ? null : (remap.get(ws.active) ?? tabs[0]?.key ?? null) };
}
