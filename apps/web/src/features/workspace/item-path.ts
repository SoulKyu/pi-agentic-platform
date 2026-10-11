import { SETTINGS_SECTIONS, type ItemRef, type SettingsSection } from "./model.ts";

export const MAX_ID = 128;

export function itemFromPath(pathname: string, devUi: boolean): ItemRef | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (path === "/") return { kind: "home" };
  if (path === "/settings") return { kind: "settings", section: "appearance" };
  if (path === "/dev/ui") return devUi ? { kind: "dev-ui" } : null;
  const settings = /^\/settings\/([a-z]+)$/.exec(path);
  if (settings) {
    const section = settings[1] as SettingsSection;
    return SETTINGS_SECTIONS.includes(section) ? { kind: "settings", section } : null;
  }
  const session = /^\/s\/([^/]+)$/.exec(path);
  if (!session) return null;
  let id: string;
  try {
    id = decodeURIComponent(session[1] ?? "");
  } catch {
    return null; // malformed escape: not a session path
  }
  return id.length > 0 && id.length <= MAX_ID && !id.includes("/") ? { kind: "session", id } : null;
}

export function pathOfItem(item: ItemRef): string {
  switch (item.kind) {
    case "home":
      return "/";
    case "session":
      return `/s/${encodeURIComponent(item.id)}`;
    case "settings":
      return `/settings/${item.section}`;
    case "dev-ui":
      return "/dev/ui";
  }
}
