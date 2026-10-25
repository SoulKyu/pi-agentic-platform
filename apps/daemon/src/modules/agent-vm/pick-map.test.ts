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

const TAG_A = `pap-agent-profile-${"a".repeat(64)}`;
const TAG_B = `pap-agent-profile-${"b".repeat(64)}`;
const TAG_C = `pap-agent-profile-${"c".repeat(64)}`;

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
  it("maps through the pairs recorded for the image, and keeps null as null", () => {
    const warn = vi.fn();
    const entries = createImageEntries({ warn });
    entries.record("scout-0001", TAG_A, WRITTEN);
    expect(entries.toImage("scout-0001", TAG_A, ["npm:a"])).toEqual(["npm:a@1.0.0"]);
    expect(entries.toImage("scout-0001", TAG_A, null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
  it("logs a pick the build did not write, and a launch with no recorded build", () => {
    const warn = vi.fn();
    const entries = createImageEntries({ warn });
    entries.record("scout-0001", TAG_A, WRITTEN);
    expect(entries.toImage("scout-0001", TAG_A, ["npm:zzz"])).toEqual([]);
    expect(warn).toHaveBeenCalledWith("agent_pick_not_in_image", { agentId: "scout-0001", count: 1 });
    expect(entries.toImage("other-0002", TAG_A, ["npm:a"])).toEqual(["npm:a"]);
    expect(warn).toHaveBeenCalledWith("agent_pick_image_unknown", { agentId: "other-0002", picks: 1 });
    entries.forget("scout-0001");
    expect(entries.toImage("scout-0001", TAG_A, ["npm:a"])).toEqual(["npm:a"]);
  });
});

/*
 * AVM-E44 (T15a), run for real: "persist dropped" (the reload case), "strict dropped" (the refusal case), "load ignores damage"
 * (the damaged case), "file mode 0644" (the mode case); S1 item 7: the keyed-by-agent mutant, "forget drops another agent's
 * image", "no cap" (the cases named above).
 */
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-t15-picks-"));
  file = join(dir, "vm", "image-entries.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const persisted = (warn = vi.fn()) => createImageEntries({ warn }, { file, strict: true });

describe("createImageEntries on disk (AVM-E44)", () => {
  it("keeps the pairs by the image tag and loads them at the next boot", () => {
    persisted().record("scout-0001", TAG_A, WRITTEN);
    const reloaded = persisted();
    expect(reloaded.toImage("scout-0001", TAG_A, ["../b"])).toEqual(["local/b"]);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { images: Record<string, unknown> };
    expect(Object.keys(saved.images)).toEqual([TAG_A]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a launch whose picks have no record, and says so", () => {
    const warn = vi.fn();
    const entries = persisted(warn);
    expect(() => entries.toImage("scout-0001", TAG_A, ["npm:a"])).toThrowError(
      expect.objectContaining({ code: "worker_failed" }) as Error,
    );
    expect(warn).toHaveBeenCalledWith("agent_pick_image_unknown", { agentId: "scout-0001", picks: 1 });
    expect(entries.toImage("scout-0001", TAG_A, null)).toBeNull();
  });

  // S1 item 7. Mutant: the pairs keyed by the agent again (`record` replaces what the agent had) -> this case fails.
  it("a VM on the old image keeps its own pairs while another image of the agent records new ones", () => {
    const entries = persisted();
    entries.record("scout-0001", TAG_A, WRITTEN);
    entries.record("scout-0001", TAG_B, [{ source: "npm:a", written: "npm:a@2.0.0" }]);
    expect(entries.toImage("scout-0001", TAG_A, ["npm:a"])).toEqual(["npm:a@1.0.0"]);
    expect(entries.toImage("scout-0001", TAG_B, ["npm:a"])).toEqual(["npm:a@2.0.0"]);
    // Both survive a restart.
    expect(persisted().toImage("scout-0001", TAG_A, ["npm:a"])).toEqual(["npm:a@1.0.0"]);
  });

  // I2. Mutant: one owning agent per image (`record` of B replaces A's pairs for T, `forget(B)` drops T) -> this case fails.
  it("two agents sharing an image keep their own pairs: B launching or being deleted leaves A's picks mapping", () => {
    const entries = persisted();
    entries.record("scout-0001", TAG_A, WRITTEN);
    entries.record("other-0002", TAG_A, WRITTEN);
    expect(entries.toImage("scout-0001", TAG_A, ["npm:a"])).toEqual(["npm:a@1.0.0"]);
    expect(entries.toImage("other-0002", TAG_A, ["../b"])).toEqual(["local/b"]);
    entries.forget("other-0002");
    expect(entries.toImage("scout-0001", TAG_A, ["npm:a"])).toEqual(["npm:a@1.0.0"]);
    expect(() => entries.toImage("other-0002", TAG_A, ["npm:a"])).toThrow();
    expect(persisted().toImage("scout-0001", TAG_A, ["npm:a"])).toEqual(["npm:a@1.0.0"]);
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      images: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(saved.images[TAG_A] ?? {})).toEqual(["scout-0001"]);
  });

  it("held lists every (agent, image) pair, across a reload, and none of a forgotten agent", () => {
    const entries = persisted();
    entries.record("scout-0001", TAG_A, WRITTEN);
    entries.record("other-0002", TAG_C, WRITTEN);
    entries.forget("other-0002");
    entries.record("third-0003", TAG_B, WRITTEN);
    const pairs = [
      { agentId: "scout-0001", image: TAG_A },
      { agentId: "third-0003", image: TAG_B },
    ];
    expect(entries.held()).toEqual(pairs);
    expect(persisted().held()).toEqual(pairs);
  });

  it("a project box's pairs and its build key load at the next boot beside an agent's (B1)", () => {
    const project = "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    const entries = persisted();
    entries.record("scout-0001", TAG_A, WRITTEN);
    entries.record(project, TAG_B, WRITTEN);
    entries.record(`${project}:build`, TAG_C, WRITTEN);
    const warn = vi.fn();
    expect(persisted(warn).held()).toEqual(entries.held());
    expect(warn).not.toHaveBeenCalled();
  });

  it("forget drops every image of the agent and none of another's", () => {
    const entries = persisted();
    entries.record("scout-0001", TAG_A, WRITTEN);
    entries.record("scout-0001", TAG_B, WRITTEN);
    entries.record("other-0002", TAG_C, WRITTEN);
    entries.forget("scout-0001");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { images: Record<string, unknown> };
    expect(Object.keys(saved.images)).toEqual([TAG_C]);
    expect(() => persisted().toImage("scout-0001", TAG_A, ["npm:a"])).toThrow();
  });

  // Mutant: no cap -> an agent that edits its profile for ever grows the file.
  it("keeps the 16 newest images of an agent", () => {
    const entries = persisted();
    const tags = Array.from({ length: 17 }, (_, i) => `pap-agent-agent-${i.toString(16).padStart(64, "0")}`);
    for (const tag of tags) entries.record("scout-0001", tag, WRITTEN);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { images: Record<string, unknown> };
    expect(Object.keys(saved.images)).toEqual(tags.slice(1));
  });

  // n3. Mutant: the cap counts every agent's images (`mine` not filtered by agent) -> B's record evicts A's oldest image.
  it("the cap is per agent: another agent's images do not count against it", () => {
    const entries = persisted();
    const tags = Array.from({ length: 16 }, (_, i) => `pap-agent-agent-${i.toString(16).padStart(64, "0")}`);
    for (const tag of tags) entries.record("scout-0001", tag, WRITTEN);
    entries.record("other-0002", TAG_C, WRITTEN);
    for (const tag of tags) expect(entries.toImage("scout-0001", tag, ["npm:a"])).toEqual(["npm:a@1.0.0"]);
  });

  it("starts empty, and says so, when the file is damaged", () => {
    persisted().record("scout-0001", TAG_A, WRITTEN);
    writeFileSync(
      file,
      JSON.stringify({ version: 1, images: { "not-a-tag": { agentId: "x", written: [] } } }),
    );
    const warn = vi.fn();
    const entries = persisted(warn);
    expect(warn).toHaveBeenCalledWith("agent_image_entries_damaged", {});
    expect(() => entries.toImage("scout-0001", TAG_A, ["npm:a"])).toThrow();
  });

  it("reads no more than 8 MiB of it: a larger file is damaged, not loaded", () => {
    persisted().record("scout-0001", TAG_A, WRITTEN);
    writeFileSync(file, `{"version":1,"images":{}}${" ".repeat(8 * 1024 * 1024)}`);
    const warn = vi.fn();
    persisted(warn);
    expect(warn).toHaveBeenCalledWith("agent_image_entries_damaged", {});
  });
});
