import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageEntries, imageEntriesOf } from "./pick-map.ts";

/*
 * Mutants (RT-43), run for real: `imageEntriesOf` keeps an unmatched pick as it is -> "reports a pick the image did not write" fails;
 * `toImage` maps null to a list -> "null stays null"; an unmatched pick is not logged -> "logs ..." fails.
 */
const WRITTEN = [
  { source: "npm:a", written: "npm:a@1.0.0" },
  { source: "../b", written: "local/b" },
];

describe("imageEntriesOf", () => {
  it("maps each pick to the entry the image wrote, in the order picked", () => {
    expect(imageEntriesOf(["../b", "npm:a"], WRITTEN)).toEqual({
      entries: ["local/b", "npm:a@1.0.0"],
      missing: [],
    });
  });
  it("reports a pick the image did not write", () => {
    expect(imageEntriesOf(["npm:a", "npm:zzz"], WRITTEN)).toEqual({
      entries: ["npm:a@1.0.0"],
      missing: ["npm:zzz"],
    });
  });
});

describe("createImageEntries", () => {
  it("maps through the agent's recorded build, and keeps null as null", () => {
    const warn = vi.fn();
    const entries = createImageEntries({ warn });
    entries.record("scout-0001", WRITTEN);
    expect(entries.toImage("scout-0001", ["npm:a"])).toEqual(["npm:a@1.0.0"]);
    expect(entries.toImage("scout-0001", null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
  it("logs a pick the build did not write, and a launch with no recorded build", () => {
    const warn = vi.fn();
    const entries = createImageEntries({ warn });
    entries.record("scout-0001", WRITTEN);
    expect(entries.toImage("scout-0001", ["npm:zzz"])).toEqual([]);
    expect(warn).toHaveBeenCalledWith("agent_pick_not_in_image", { agentId: "scout-0001", count: 1 });
    expect(entries.toImage("other-0002", ["npm:a"])).toEqual(["npm:a"]);
    expect(warn).toHaveBeenCalledWith("agent_pick_image_unknown", { agentId: "other-0002", picks: 1 });
    entries.forget("scout-0001");
    expect(entries.toImage("scout-0001", ["npm:a"])).toEqual(["npm:a"]);
  });
});

/*
 * AVM-E44 (T15a), run for real: "persist dropped" (the reload case), "strict dropped" (the refusal case), "forget keeps the
 * tag of an agent that still uses it dropped" (the shared case), "old tag kept when replaced" (the replaced case), "load
 * ignores damage" (the damaged case), "file mode 0644" (the mode case).
 */
const TAG_A = `pap-agent-profile-${"a".repeat(64)}`;
const TAG_B = `pap-agent-profile-${"b".repeat(64)}`;
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-t15-picks-"));
  file = join(dir, "vm", "image-entries.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const persisted = (warn = vi.fn()) => createImageEntries({ warn }, { file, strict: true });

describe("createImageEntries on disk (AVM-E44)", () => {
  it("keeps the pairs by the profile image tag and loads them at the next boot", () => {
    persisted().record("scout-0001", WRITTEN, TAG_A);
    const reloaded = persisted();
    expect(reloaded.toImage("scout-0001", ["../b"])).toEqual(["local/b"]);
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      profiles: Record<string, unknown>;
      agents: unknown;
    };
    expect(Object.keys(saved.profiles)).toEqual([TAG_A]);
    expect(saved.agents).toEqual({ "scout-0001": TAG_A });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a launch whose picks have no record, and says so", () => {
    const warn = vi.fn();
    const entries = persisted(warn);
    expect(() => entries.toImage("scout-0001", ["npm:a"])).toThrowError(
      expect.objectContaining({ code: "worker_failed" }) as Error,
    );
    expect(warn).toHaveBeenCalledWith("agent_pick_image_unknown", { agentId: "scout-0001", picks: 1 });
    expect(entries.toImage("scout-0001", null)).toBeNull();
  });

  it("forget drops the agent, and the tag only when no other agent uses it", () => {
    const entries = persisted();
    entries.record("scout-0001", WRITTEN, TAG_A);
    entries.record("other-0002", WRITTEN, TAG_A);
    entries.forget("scout-0001");
    let saved = JSON.parse(readFileSync(file, "utf8")) as {
      profiles: Record<string, unknown>;
      agents: object;
    };
    expect(Object.keys(saved.profiles)).toEqual([TAG_A]);
    expect(Object.keys(saved.agents)).toEqual(["other-0002"]);
    entries.forget("other-0002");
    saved = JSON.parse(readFileSync(file, "utf8")) as typeof saved;
    expect(saved.profiles).toEqual({});
    expect(() => persisted().toImage("other-0002", ["npm:a"])).toThrow();
  });

  it("an agent that moves to a new image takes its old tag's pairs away when nobody else uses them", () => {
    const entries = persisted();
    entries.record("scout-0001", WRITTEN, TAG_A);
    entries.record("scout-0001", [{ source: "npm:a", written: "npm:a@2.0.0" }], TAG_B);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { profiles: Record<string, unknown> };
    expect(Object.keys(saved.profiles)).toEqual([TAG_B]);
    expect(persisted().toImage("scout-0001", ["npm:a"])).toEqual(["npm:a@2.0.0"]);
  });

  it("starts empty, and says so, when the file is damaged", () => {
    persisted().record("scout-0001", WRITTEN, TAG_A);
    writeFileSync(file, JSON.stringify({ version: 1, profiles: { "not-a-tag": [] }, agents: {} }));
    const warn = vi.fn();
    const entries = persisted(warn);
    expect(warn).toHaveBeenCalledWith("agent_image_entries_damaged", {});
    expect(() => entries.toImage("scout-0001", ["npm:a"])).toThrow();
  });

  it("reads no more than 8 MiB of it: a larger file is damaged, not loaded", () => {
    persisted().record("scout-0001", WRITTEN, TAG_A);
    writeFileSync(file, `{"version":1,"profiles":{},"agents":{}}${" ".repeat(8 * 1024 * 1024)}`);
    const warn = vi.fn();
    persisted(warn);
    expect(warn).toHaveBeenCalledWith("agent_image_entries_damaged", {});
  });
});
