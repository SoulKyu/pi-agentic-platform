import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addProjectEn, addProjectFr } from "./catalog/add-project.ts";
import { changesEn, changesFr } from "./catalog/changes.ts";
import { commandsEn, commandsFr } from "./catalog/commands.ts";
import { modelPickerEn, modelPickerFr } from "./catalog/model-picker.ts";
import { launchEn, launchFr } from "./catalog/launch.ts";
import { devEn, devFr } from "./catalog/dev.ts";
import { filesEn, filesFr } from "./catalog/files.ts";
import { galleryEn, galleryFr } from "./catalog/gallery.ts";
import { homeEn, homeFr } from "./catalog/home.ts";
import { laneCommitEn, laneCommitFr } from "./catalog/lane-commit.ts";
import { laneNewEn, laneNewFr } from "./catalog/lane-new.ts";
import { laneReviewEn, laneReviewFr } from "./catalog/lane-review.ts";
import { lanesEn, lanesFr } from "./catalog/lanes.ts";
import { serverEn, serverFr } from "./catalog/server.ts";
import { sessionPolicyEn, sessionPolicyFr } from "./catalog/session-policy.ts";
import { sessionFilesEn, sessionFilesFr } from "./catalog/session-files.ts";
import { sessionScreenEn, sessionScreenFr } from "./catalog/session-screen.ts";
import { settingsScreenEn, settingsScreenFr } from "./catalog/settings-screen.ts";
import { settingsAccessEn, settingsAccessFr } from "./catalog/settings-access.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "./catalog/settings-appearance.ts";
import { settingsApprovalsEn, settingsApprovalsFr } from "./catalog/settings-approvals.ts";
import { settingsShortcutsEn, settingsShortcutsFr } from "./catalog/settings-shortcuts.ts";
import { shellEn, shellFr } from "./catalog/shell.ts";
import { sidebarEn, sidebarFr } from "./catalog/sidebar.ts";
import { terminalEn, terminalFr } from "./catalog/terminal.ts";

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
        launch: Object.keys(launchEn),
        dev: Object.keys(devEn),
        sessionScreen: Object.keys(sessionScreenEn),
        sessionFiles: Object.keys(sessionFilesEn),
        settingsScreen: Object.keys(settingsScreenEn),
        settingsAppearance: Object.keys(settingsAppearanceEn),
        settingsShortcuts: Object.keys(settingsShortcutsEn),
        settingsApprovals: Object.keys(settingsApprovalsEn),
        settingsAccess: Object.keys(settingsAccessEn),
        gallery: Object.keys(galleryEn),
        server: Object.keys(serverEn),
        sidebar: Object.keys(sidebarEn),
        sessionPolicy: Object.keys(sessionPolicyEn),
        files: Object.keys(filesEn),
        changes: Object.keys(changesEn),
        terminal: Object.keys(terminalEn),
        lanes: Object.keys(lanesEn),
        addProject: Object.keys(addProjectEn),
        laneNew: Object.keys(laneNewEn),
        laneCommit: Object.keys(laneCommitEn),
        laneReview: Object.keys(laneReviewEn),
        home: Object.keys(homeEn),
        modelPicker: Object.keys(modelPickerEn),
        "en.ts": literalKeys("./en.ts"),
      }),
    ).toEqual([]);
  });

  it("the French catalogs are disjoint from each other and from the literal keys of fr.ts", () => {
    expect(
      duplicates({
        shell: Object.keys(shellFr),
        commands: Object.keys(commandsFr),
        launch: Object.keys(launchFr),
        dev: Object.keys(devFr),
        sessionScreen: Object.keys(sessionScreenFr),
        sessionFiles: Object.keys(sessionFilesFr),
        settingsScreen: Object.keys(settingsScreenFr),
        settingsAppearance: Object.keys(settingsAppearanceFr),
        settingsShortcuts: Object.keys(settingsShortcutsFr),
        settingsApprovals: Object.keys(settingsApprovalsFr),
        settingsAccess: Object.keys(settingsAccessFr),
        gallery: Object.keys(galleryFr),
        server: Object.keys(serverFr),
        sidebar: Object.keys(sidebarFr),
        sessionPolicy: Object.keys(sessionPolicyFr),
        files: Object.keys(filesFr),
        changes: Object.keys(changesFr),
        terminal: Object.keys(terminalFr),
        lanes: Object.keys(lanesFr),
        addProject: Object.keys(addProjectFr),
        laneNew: Object.keys(laneNewFr),
        laneCommit: Object.keys(laneCommitFr),
        laneReview: Object.keys(laneReviewFr),
        home: Object.keys(homeFr),
        modelPicker: Object.keys(modelPickerFr),
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
