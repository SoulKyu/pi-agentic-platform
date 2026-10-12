import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandsEn, commandsFr } from "./catalog/commands.ts";
import { devEn, devFr } from "./catalog/dev.ts";
import { galleryEn, galleryFr } from "./catalog/gallery.ts";
import { serverEn, serverFr } from "./catalog/server.ts";
import { sessionScreenEn, sessionScreenFr } from "./catalog/session-screen.ts";
import { settingsScreenEn, settingsScreenFr } from "./catalog/settings-screen.ts";
import { settingsAccessEn, settingsAccessFr } from "./catalog/settings-access.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "./catalog/settings-appearance.ts";
import { settingsApprovalsEn, settingsApprovalsFr } from "./catalog/settings-approvals.ts";
import { settingsShortcutsEn, settingsShortcutsFr } from "./catalog/settings-shortcuts.ts";
import { shellEn, shellFr } from "./catalog/shell.ts";
import { sidebarEn, sidebarFr } from "./catalog/sidebar.ts";

/** Keys written directly in en.ts / fr.ts: one `"key": value` per line at the object's top level. */
function literalKeys(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return [...source.matchAll(/^ {2}"([^"]+)":/gm)].map((match) => match[1] ?? "");
}

/** Keys that appear in more than one place. A spread silently lets the later source win, so none may repeat. */
function duplicates(groups: Readonly<Record<string, readonly string[]>>): string[] {
  const owners = new Map<string, string[]>();
  for (const [group, keys] of Object.entries(groups))
    for (const key of keys) owners.set(key, [...(owners.get(key) ?? []), group]);
  return [...owners]
    .filter(([, where]) => where.length > 1)
    .map(([key, where]) => `${key}: ${where.join(" + ")}`);
}

describe("catalog keys never collide", () => {
  it("duplicates() names a key present twice, inside one group or across two", () => {
    expect(duplicates({ a: ["x", "y"], b: ["y"] })).toEqual(["y: a + b"]);
    expect(duplicates({ a: ["x", "x"] })).toEqual(["x: a + a"]);
    expect(duplicates({ a: ["x"], b: ["y"] })).toEqual([]);
  });

  it("the English catalogs are disjoint from each other and from the literal keys of en.ts", () => {
    expect(
      duplicates({
        shell: Object.keys(shellEn),
        commands: Object.keys(commandsEn),
        dev: Object.keys(devEn),
        sessionScreen: Object.keys(sessionScreenEn),
        settingsScreen: Object.keys(settingsScreenEn),
        settingsAppearance: Object.keys(settingsAppearanceEn),
        settingsShortcuts: Object.keys(settingsShortcutsEn),
        settingsApprovals: Object.keys(settingsApprovalsEn),
        settingsAccess: Object.keys(settingsAccessEn),
        gallery: Object.keys(galleryEn),
        server: Object.keys(serverEn),
        sidebar: Object.keys(sidebarEn),
        "en.ts": literalKeys("./en.ts"),
      }),
    ).toEqual([]);
  });

  it("the French catalogs are disjoint from each other and from the literal keys of fr.ts", () => {
    expect(
      duplicates({
        shell: Object.keys(shellFr),
        commands: Object.keys(commandsFr),
        dev: Object.keys(devFr),
        sessionScreen: Object.keys(sessionScreenFr),
        settingsScreen: Object.keys(settingsScreenFr),
        settingsAppearance: Object.keys(settingsAppearanceFr),
        settingsShortcuts: Object.keys(settingsShortcutsFr),
        settingsApprovals: Object.keys(settingsApprovalsFr),
        settingsAccess: Object.keys(settingsAccessFr),
        gallery: Object.keys(galleryFr),
        server: Object.keys(serverFr),
        sidebar: Object.keys(sidebarFr),
        "fr.ts": literalKeys("./fr.ts"),
      }),
    ).toEqual([]);
  });

  it("finds the literal keys it is meant to guard", () => {
    expect(literalKeys("./en.ts")).toContain("app.name");
    expect(literalKeys("./fr.ts")).toContain("app.name");
    expect(literalKeys("./en.ts").length).toBeGreaterThan(50);
  });
});
