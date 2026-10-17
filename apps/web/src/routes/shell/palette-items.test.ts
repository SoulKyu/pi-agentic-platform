import type { SessionSummary } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, keyNames } from "../../features/commands/index.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "../../features/commands/defaults.ts";
import { mergeWithDefaults } from "../../features/commands/resolve.ts";
import type { Tab } from "../../features/workspace/index.ts";
import { t } from "../../i18n/index.ts";
import { rankItems } from "../../features/commands/palette/rank.ts";
import { buildPaletteItems } from "./palette-items.ts";

const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
const session = (id: string, cwd: string, updatedAt: number): SessionSummary => ({
  id,
  cwd,
  name: null,
  status: "idle",
  createdAt: 1,
  updatedAt,
});
const build = (extra: Partial<Parameters<typeof buildPaletteItems>[0]> = {}) => {
  const navigate = vi.fn();
  const run = vi.fn();
  const items = buildPaletteItems({
    commands: COMMANDS,
    has: (id) => ["tab.close", "pane.split", "palette.toggle"].includes(id),
    rules,
    platform: "other",
    names: keyNames(t),
    tabs: [],
    sessions: [],
    views: {},
    t,
    navigate,
    run,
    ...extra,
  });
  return { items, navigate, run };
};

describe("buildPaletteItems", () => {
  it("lists only commands with a handler, and never the palette itself", () => {
    const { items } = build();
    expect(items.filter((i) => i.group === "actions").map((i) => i.id)).toEqual([
      "action:tab.close",
      "action:pane.split",
    ]);
  });

  it("carries the chord tokens of the last effective rule, and runs the command", () => {
    const { items, run } = build();
    const split = items.find((i) => i.id === "action:pane.split");
    expect([split?.title, split?.chord, split?.chordJoiner]).toEqual(["Split the pane", ["Ctrl", "\\"], "+"]);
    split?.run();
    expect(run).toHaveBeenCalledWith("pane.split");
  });

  it("titles sessions by folder, details the path, keeps the 50 newest and navigates", () => {
    const many = Array.from({ length: 60 }, (_, i) => session(`s${i}`, `/home/ana/p${i}`, i));
    const { items, navigate } = build({ sessions: many });
    const sessions = items.filter((i) => i.group === "sessions");
    expect(sessions).toHaveLength(50);
    expect([sessions[0]?.title, sessions[0]?.detail, sessions[0]?.id]).toEqual([
      "p59",
      "/home/ana/p59",
      "session:s59",
    ]);
    expect(sessions.at(-1)?.title).toBe("p10");
    sessions[0]?.run();
    expect(navigate).toHaveBeenCalledWith({ kind: "session", id: "s59" });
  });

  it("titles an unnamed session by the start of its first message and still finds it by folder", () => {
    const unnamed = { ...session("a", "/home/ana/api", 1), preview: "fix the tests" };
    const { items } = build({ sessions: [unnamed] });
    const item = items.find((one) => one.id === "session:a");
    expect(item?.title).toBe("fix the tests");
    expect(item?.searchTerms).toContain("api");
  });

  it("titles a named session by its name and still finds it by folder", () => {
    const named = { ...session("a", "/home/ana/api", 1), name: "Fix login" };
    const { items } = build({ sessions: [named] });
    const [entry] = items.filter((i) => i.group === "sessions");
    expect(entry?.title).toBe("Fix login");
    expect(entry?.searchTerms).toContain("api");
  });

  it("lists open tabs in group open and settings sections in group settings", () => {
    const tabs: Tab[] = [
      { key: "home", item: { kind: "home" }, split: null },
      { key: "session:a", item: { kind: "session", id: "a" }, split: null },
    ];
    const { items, navigate } = build({ tabs, sessions: [session("a", "/x/proj", 1)] });
    const open = items.filter((i) => i.group === "open");
    expect(open.map((i) => i.title)).toEqual(["New session", "proj"]);
    open[1]?.run();
    expect(navigate).toHaveBeenCalledWith({ kind: "session", id: "a" });
    const settings = items.filter((i) => i.group === "settings");
    expect(settings.map((i) => i.title)).toEqual([
      "Appearance",
      "Shortcuts",
      "Language",
      "Approvals",
      "Models",
      "MCP servers",
      "Skills",
      "Automation",
      "Agents",
      "Memory",
      "Notifications",
      "Account",
    ]);
    settings[1]?.run();
    expect(navigate).toHaveBeenLastCalledWith({ kind: "settings", section: "shortcuts" });
  });
});

describe("running terminals in the palette (M8R81)", () => {
  const terminal = (id: string, cwd: string, status: "running" | "exited") => ({
    id,
    cwd,
    sessionId: null,
    cols: 80,
    rows: 24,
    status,
    exitCode: status === "exited" ? 0 : null,
    signal: null,
    createdAt: 1,
  });

  it("lists a running terminal with its folder name and opens it", () => {
    const { items, navigate } = build({
      terminals: [terminal("AAAAAAAAAAAAAAAAAAAAAA", "/home/ana/api", "running")],
    });
    const item = items.find((one) => one.id === "terminal:AAAAAAAAAAAAAAAAAAAAAA");
    expect([item?.title, item?.group, item?.detail]).toEqual(["Terminal · api", "open", "/home/ana/api"]);
    expect(item?.searchTerms).toContain("api");
    item?.run();
    expect(navigate).toHaveBeenCalledWith({ kind: "terminal", id: "AAAAAAAAAAAAAAAAAAAAAA" });
  });

  it("does not list an exited terminal", () => {
    const { items } = build({ terminals: [terminal("AAAAAAAAAAAAAAAAAAAAAA", "/home/ana/api", "exited")] });
    expect(items.filter((one) => one.id.startsWith("terminal:"))).toEqual([]);
  });
});

describe("tasks and triggers in the palette (M10R112)", () => {
  const trigger = (id: string, name: string) => ({
    id,
    name,
    enabled: true,
    sourceType: "manual" as const,
    projectId: null,
    state: "ok" as const,
    nextFireAt: null,
  });

  it("lists Tasks, New trigger and one entry per trigger, in the Tasks and triggers group", () => {
    const { items, navigate } = build({
      triggers: [trigger("g1", "prod-alerts"), trigger("g2", "nightly")],
      newTriggerProject: "p1",
    });
    const group = items.filter((one) => one.group === "tasks");
    expect(group.map((one) => one.title)).toEqual([
      "Tasks",
      "New trigger…",
      "Trigger · prod-alerts",
      "Trigger · nightly",
    ]);
    group.forEach((one) => one.run());
    expect(navigate.mock.calls.map(([item]) => item)).toEqual([
      { kind: "tasks" },
      { kind: "trigger", id: "new:p1" },
      { kind: "trigger", id: "g1" },
      { kind: "trigger", id: "g2" },
    ]);
  });

  it("offers no empty editor while no project is known", () => {
    const { items } = build({ triggers: [], newTriggerProject: null });
    expect(items.filter((one) => one.group === "tasks").map((one) => one.title)).toEqual(["Tasks"]);
  });

  it("finds a trigger by its name", () => {
    const { items } = build({ triggers: [trigger("g1", "prod-alerts")] });
    expect(items.find((one) => one.id === "trigger:g1")?.searchTerms).toContain("prod-alerts");
  });

  it("ranks the group after Sessions and before Settings", () => {
    const { items } = build({ triggers: [trigger("g1", "x")], sessions: [session("a", "/w/api", 1)] });
    const groups = rankItems(items, "").groups.map((entry) => entry.group);
    expect(groups.indexOf("sessions")).toBeLessThan(groups.indexOf("tasks"));
    expect(groups.indexOf("tasks")).toBeLessThan(groups.indexOf("settings"));
  });
});
