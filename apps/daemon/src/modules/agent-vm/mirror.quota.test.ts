import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT, appendOf, entry, FILE, HEADER, userEntry } from "./mirror-fixtures.ts";
import { announced, bed, cleanup, clock, fresh, MiB, open, refusals } from "./mirror-harness.ts";

afterEach(cleanup);

// Mutant M-QUOTA: let `allow` always say yes: killed by the first three cases.
describe("the quota (R32, RT-27)", () => {
  const notice = "Les conversations de cet agent ont atteint la taille de son disque.";

  it("refuses an append past the agent's disk and posts the notice", async () => {
    fresh();
    const mirror = open({ limitBytes: 1 * MiB });
    mirror.onSessionAppend(appendOf(0, HEADER));
    const big = userEntry("u1", "x".repeat(600 * 1024));
    expect(mirror.onSessionAppend(appendOf(HEADER.length, big))).toBe("ok");
    expect(
      mirror.onSessionAppend(appendOf(mirror.facts().size, entry("e2", { pad: "y".repeat(600 * 1024) }))),
    ).toBe("refused");
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason: "quota" });
    expect(announced).toEqual(["quota"]);
    expect(notice).toContain("taille de son disque");
  });

  it("counts the other mirrors and the kept copies of the agent", () => {
    fresh();
    writeFileSync(join(bed.folder, "other.jsonl"), "x".repeat(700 * 1024));
    mkdirSync(join(bed.folder, "replaced"));
    writeFileSync(join(bed.folder, "replaced", "old.jsonl.1"), "x".repeat(200 * 1024));
    const mirror = open({ limitBytes: 1 * MiB });
    expect(mirror.onSessionAppend(appendOf(0, HEADER + entry("e1", { pad: "y".repeat(200 * 1024) })))).toBe(
      "refused",
    );
    expect(announced).toEqual(["quota"]);
    expect(open({ limitBytes: 1 * MiB }).onSessionAppend(appendOf(0, HEADER + entry("e1")))).toBe("ok");
  });

  it("refuses while the free space is under the floor, asking statfs at most every 5 s", async () => {
    fresh();
    let free = 5000;
    let asked = 0;
    const mirror = open({
      minFreeMb: 1024,
      free: () => {
        asked++;
        return free;
      },
    });
    expect(mirror.onSessionAppend(appendOf(0, HEADER))).toBe("ok");
    free = 100;
    expect(mirror.onSessionAppend(appendOf(HEADER.length, entry("e1")))).toBe("ok");
    expect(asked).toBe(1);
    await clock.advance(5_000);
    expect(mirror.onSessionAppend(appendOf(mirror.facts().size, entry("e2")))).toBe("refused");
    expect(asked).toBe(2);
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason: "quota" });
    expect(announced).toEqual(["quota"]);
  });

  it("with the floor at 0 it never asks the disk", () => {
    fresh();
    let asked = 0;
    const mirror = open({ minFreeMb: 0, free: () => (asked++, 0) });
    expect(mirror.onSessionAppend(appendOf(0, HEADER))).toBe("ok");
    expect(asked).toBe(0);
  });
});

// Mutant M-NOFOLLOW: open without O_NOFOLLOW (and drop the folder check): killed by the link cases.
describe("the files (R23)", () => {
  it("creates the file 0600 and writes into a 0700 folder", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER));
    expect(statSync(bed.path).mode & 0o777).toBe(0o600);
    expect(statSync(bed.folder).mode & 0o777).toBe(0o700);
  });

  it("refuses a link at the file and writes nothing through it", () => {
    fresh();
    const target = join(bed.root, "target.jsonl");
    writeFileSync(target, "");
    symlinkSync(target, bed.path);
    expect(() => open()).toThrow();
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("refuses a link at the folder, a folder that is a file, and a file with other links", () => {
    fresh();
    const real = join(bed.root, "elsewhere");
    mkdirSync(real);
    rmSync(bed.folder, { recursive: true });
    symlinkSync(real, bed.folder);
    expect(() => open()).toThrow();
    expect(existsSync(join(real, FILE))).toBe(false);
    fresh();
    rmSync(bed.folder, { recursive: true });
    writeFileSync(bed.folder, "not a folder");
    expect(() => open()).toThrow();
    fresh();
    writeFileSync(bed.path, HEADER, { mode: 0o600 });
    linkSync(bed.path, join(bed.root, "hard.jsonl"));
    expect(() => open()).toThrow();
  });

  it("creates its folder 0700 when the gate did not", () => {
    fresh();
    rmSync(bed.folder, { recursive: true });
    open();
    expect(statSync(bed.folder).mode & 0o777).toBe(0o700);
  });

  it("a new session's file must not exist yet (it could be another session's mirror)", () => {
    fresh();
    writeFileSync(bed.path, HEADER, { mode: 0o600 });
    expect(() => open({ createOnly: true })).toThrow();
    chmodSync(bed.path, 0o600);
    expect(() => open()).not.toThrow();
  });
});
