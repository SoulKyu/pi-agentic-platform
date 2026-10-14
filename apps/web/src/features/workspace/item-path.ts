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

export const MAX_ROOT = 4096;
const TERMINAL_ID = /^[A-Za-z0-9_-]{22}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** A terminal id as the daemon makes it: 22 base64url characters. */
export const isTerminalId = (id: string): boolean => TERMINAL_ID.test(id);

/** The web mirror of the daemon's `canonical`: absolute, no empty or dot segment, no trailing slash, no NUL. */
export function isValidRoot(root: string): boolean {
  if (root.length === 0 || root.length > MAX_ROOT || !root.startsWith("/")) return false;
  if (root.includes("\0") || LONE_SURROGATE.test(root)) return false;
  if (root === "/") return true;
  return root
    .slice(1)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/** The root as one URL segment: base64url of its UTF-8, no padding (never a `/` or a `%2F`, M8R71). */
export function encodeRoot(root: string): string {
  const bytes = new TextEncoder().encode(root);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The root a segment names, or null when it is not the canonical encoding of a valid root. */
export function decodeRoot(segment: string): string | null {
  if (!SEGMENT.test(segment) || segment.length % 4 === 1 || segment.length > MAX_ROOT * 2) return null;
  try {
    const padded = segment
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const root = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return isValidRoot(root) && encodeRoot(root) === segment ? root : null;
  } catch {
    return null; // not base64, not UTF-8
  }
}

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
  const surface = /^\/(explore|changes)\/([^/]+)$/.exec(path);
  if (surface) {
    const root = decodeRoot(surface[2] ?? "");
    return root === null ? null : { kind: surface[1] === "explore" ? "files" : "changes", root };
  }
  const terminal = /^\/term\/([^/]+)$/.exec(path);
  if (terminal) return isTerminalId(terminal[1] ?? "") ? { kind: "terminal", id: terminal[1] ?? "" } : null;
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
    case "files":
      return isValidRoot(item.root) ? `/explore/${encodeRoot(item.root)}` : "/";
    case "changes":
      return isValidRoot(item.root) ? `/changes/${encodeRoot(item.root)}` : "/";
    case "terminal":
      return isTerminalId(item.id) ? `/term/${item.id}` : "/";
    case "dev-ui":
      return "/dev/ui";
  }
}
