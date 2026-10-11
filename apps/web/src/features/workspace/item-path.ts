import { SETTINGS_SECTIONS, type ItemRef, type SettingsSection } from "./model.ts";

export const MAX_ID = 128;
const LONE_SURROGATE = /\p{Surrogate}/u; // with the u flag, only unpaired surrogates match

/** The one id rule for URLs and stored tabs: bounded, no "/", not a dot segment, well-formed UTF-16. */
export const isValidId = (id: string): boolean =>
  id.length > 0 &&
  id.length <= MAX_ID &&
  !id.includes("/") &&
  id !== "." &&
  id !== ".." &&
  !LONE_SURROGATE.test(id);

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
  return isValidId(id) ? { kind: "session", id } : null;
}

export function pathOfItem(item: ItemRef): string {
  switch (item.kind) {
    case "home":
      return "/";
    case "session":
      return isValidId(item.id) ? `/s/${encodeURIComponent(item.id)}` : "/"; // total: never throws on a bad id
    case "settings":
      return `/settings/${item.section}`;
    case "dev-ui":
      return "/dev/ui";
  }
}
