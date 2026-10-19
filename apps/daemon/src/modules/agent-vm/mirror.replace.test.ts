import { closeSync, fstatSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unverifiedIds } from "./mirror-facts.ts";
import { appendOf, entry, FILE, HEADER, imageEntry, userEntry } from "./mirror-fixtures.ts";
import {
  announced,
  bed,
  cleanup,
  clock,
  fileText,
  fresh,
  keptFiles,
  open,
  refusals,
} from "./mirror-harness.ts";
import { createProvenance, promptHash } from "./mirror-line.ts";
import { REPLACED_NOTICE } from "./mirror.ts";
import { MiB } from "./mirror-harness.ts";

afterEach(cleanup);

describe("a replacement (R14)", () => {
  const original = HEADER + entry("e1") + entry("e2");

  const mirrorWith = (text: string) => {
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, text));
    return mirror;
  };

  it("an extension keeps nothing: the kept copy is deleted once the new file reaches the old size", () => {
    fresh();
    const mirror = mirrorWith(original);
    expect(mirror.onSessionAppend(appendOf(0, original.slice(0, 50), { replace: true }))).toBe("ok");
    expect(keptFiles()).toHaveLength(1);
    expect(mirror.onSessionAppend(appendOf(50, original.slice(50) + entry("e3")))).toBe("ok");
    expect(keptFiles()).toEqual([]);
    expect(fileText()).toBe(original + entry("e3"));
    expect(announced).toEqual([]);
  });

  it("a replace with identical content is an extension too", () => {
    fresh();
    const mirror = mirrorWith(original);
    expect(mirror.onSessionAppend(appendOf(0, original, { replace: true }))).toBe("ok");
    expect(keptFiles()).toEqual([]);
    expect(announced).toEqual([]);
    expect(fileText()).toBe(original);
  });

  it("a rewrite keeps the old mirror as replaced/<name>.<stamp>, posts the notice once and taints", () => {
    fresh();
    const mirror = mirrorWith(original);
    const rewritten = HEADER + entry("e1") + entry("e2x");
    expect(mirror.onSessionAppend(appendOf(0, rewritten, { replace: true }))).toBe("ok");
    expect(keptFiles()).toEqual([`${FILE}.${clock.now()}`]);
    expect(readFileSync(join(bed.folder, "replaced", `${FILE}.${clock.now()}`), "utf8")).toBe(original);
    expect(fileText()).toBe(rewritten);
    expect(announced).toEqual(["replaced"]);
    expect(mirror.onSessionAppend(appendOf(mirror.facts().size, entry("e3")))).toBe("ok");
    expect(announced).toEqual(["replaced"]);
    expect(REPLACED_NOTICE).toBe("La VM a réécrit cette conversation ; l'ancienne copie est gardée 7 jours.");
  });

  it("finds the first differing byte inside a chunk, and in a later chunk", () => {
    fresh();
    const mirror = mirrorWith(original);
    const rewritten = HEADER + entry("e1") + entry("e2");
    mirror.onSessionAppend(appendOf(0, rewritten.slice(0, 100), { replace: true }));
    expect(announced).toEqual([]);
    const tail = rewritten.slice(100, 150) + "Z" + rewritten.slice(151);
    mirror.onSessionAppend(appendOf(100, tail));
    expect(announced).toEqual(["replaced"]);
    expect(keptFiles()).toHaveLength(1);
  });

  it("a connection that ends before the new file reached the old size keeps the copy, with the notice", () => {
    fresh();
    const mirror = mirrorWith(original);
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1"), { replace: true }));
    expect(announced).toEqual([]);
    mirror.close();
    expect(announced).toEqual(["replaced"]);
    expect(keptFiles()).toHaveLength(1);
    expect(fileText()).toBe(HEADER + entry("e1"));
  });

  it("a replace of an empty mirror keeps nothing; a second replace settles the first", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, "", { replace: true }));
    expect(keptFiles()).toEqual([]);
    mirror.onSessionAppend(appendOf(0, original));
    mirror.onSessionAppend(appendOf(0, HEADER, { replace: true }));
    mirror.onSessionAppend(appendOf(0, original.slice(0, 30), { replace: true }));
    expect(announced).toEqual(["replaced"]);
    expect(keptFiles()).toHaveLength(2);
  });

  it("keeps the copy counted in the quota", () => {
    fresh();
    const mirror = mirrorWith(original);
    mirror.onSessionAppend(appendOf(0, HEADER + entry("z1"), { replace: true }));
    expect(keptFiles()).toHaveLength(1);
    const small = open({ limitBytes: original.length + 10 });
    expect(small.onSessionAppend(appendOf(small.facts().size, entry("z2", { pad: "p".repeat(100) })))).toBe(
      "refused",
    );
  });

  it("starts the new file's ids over: an id of the replaced file is no duplicate", () => {
    fresh();
    const mirror = mirrorWith(original);
    expect(mirror.onSessionAppend(appendOf(0, HEADER + entry("e2"), { replace: true }))).toBe("ok");
  });
});

describe("provenance (R32)", () => {
  it("lists an unverified user entry; a prompt pap sent is not listed", () => {
    fresh();
    const provenance = createProvenance();
    provenance.sent("hello from pap");
    const mirror = open({ provenance });
    mirror.onSessionAppend(
      appendOf(
        0,
        HEADER +
          userEntry("u1", "hello from pap") +
          userEntry("u2", [{ type: "text", text: "forged by the VM" }]) +
          entry("a1"),
      ),
    );
    expect([...unverifiedIds(bed.path).ids]).toEqual(["u2"]);
    expect(statSync(`${bed.path}.unverified`).mode & 0o777).toBe(0o600);
  });

  it("a `/` prompt allows one expanded entry whatever its text", () => {
    fresh();
    const provenance = createProvenance();
    provenance.sent("/review");
    const mirror = open({ provenance });
    mirror.onSessionAppend(
      appendOf(0, HEADER + userEntry("u1", "the expanded text") + userEntry("u2", "second")),
    );
    expect([...unverifiedIds(bed.path).ids]).toEqual(["u2"]);
  });

  it("an entry the VM wrote that is not a user message is not judged", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("a1") + entry("c1", { type: "custom" })));
    expect(unverifiedIds(bed.path).ids.size).toBe(0);
    expect(promptHash("x")).toHaveLength(64);
  });
});

describe("a disconnect and a crash (Review Focus 5)", () => {
  it("drops the partial line: the file ends with a newline and the facts are the last complete entry", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1") + entry("e2").slice(0, 25)));
    mirror.close();
    expect(fileText().endsWith("\n")).toBe(true);
    const again = open();
    expect(again.facts()).toEqual({ size: (HEADER + entry("e1")).length, lastEntryId: "e1" });
  });

  it("cuts a partial last line found at open", () => {
    fresh();
    writeFileSync(bed.path, `${HEADER}{"type":"message","id":"e1","pa`, { mode: 0o600 });
    const mirror = open();
    expect(mirror.facts()).toEqual({ size: HEADER.length, lastEntryId: "hdr00001" });
    expect(fileText()).toBe(HEADER);
  });
});

// Mutant M-SETTLE-EARLY: settle an extension in `append` from the incoming bytes, before they are checked or written (the
// old behaviour): killed by "old bytes plus a refused line" and "close during the parse".
describe("a replacement settles on committed bytes only (R14, Review Focus 3)", () => {
  const original = HEADER + entry("e1") + entry("e2");

  it("old bytes plus a line the mirror refuses keep the copy, and the close posts the notice", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, original));
    const result = mirror.onSessionAppend(appendOf(0, original + entry("e1"), { replace: true }));
    expect(result).toBe("refused");
    expect(refusals().at(-1)?.reason).toBe("duplicate_id");
    expect(keptFiles()).toHaveLength(1);
    expect(readFileSync(join(bed.folder, "replaced", keptFiles()[0] as string), "utf8")).toBe(original);
    expect(fileText()).toBe("");
    mirror.close();
    expect(announced).toEqual(["replaced"]);
  });

  it("a close during the parse of the last replace chunk keeps the copy, with the notice", async () => {
    fresh();
    const big = HEADER + imageEntry("img1", 2 * MiB);
    const mirror = open();
    expect(await mirror.onSessionAppend(appendOf(0, big))).toBe("ok");
    const pending = mirror.onSessionAppend(appendOf(0, big, { replace: true }));
    expect(pending).toBeInstanceOf(Promise);
    mirror.close();
    expect(await pending).toBe("refused");
    // The copy and its unverified list (the image entry is a user entry pap never sent).
    expect(keptFiles().map((name) => name.replace(/\.unverified$/, ""))).toEqual([
      `${FILE}.${clock.now()}`,
      `${FILE}.${clock.now()}`,
    ]);
    expect(announced).toEqual(["replaced"]);
    expect(fileText()).toBe("");
  });

  it("the copy goes only when the bytes up to the old size are on disk", async () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, original));
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1"), { replace: true }));
    expect(keptFiles()).toHaveLength(1);
    mirror.onSessionAppend(appendOf(mirror.facts().size, entry("e2")));
    expect(keptFiles()).toEqual([]);
    expect(announced).toEqual([]);
  });
});

describe("a replacement that fails half way (R14)", () => {
  it("counts as kept with its notice, and the descriptor is closed once (no stray close of another)", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1")));
    // The kept-copies folder cannot be made: a file stands where it should be.
    writeFileSync(join(bed.folder, "replaced"), "in the way");
    expect(mirror.onSessionAppend(appendOf(0, HEADER, { replace: true }))).toBe("refused");
    expect(announced).toEqual(["replaced"]);
    const probe = openSync(join(bed.root, "probe"), "w");
    try {
      mirror.close();
      expect(fstatSync(probe).isFile()).toBe(true);
    } finally {
      closeSync(probe);
    }
    expect(fileText()).toBe(HEADER + entry("e1"));
  });
});

describe("the unverified list follows its copy (R32, R14)", () => {
  it("moves with the kept copy to replaced/<name>.<stamp>.unverified", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + userEntry("u1", "forged")));
    expect([...unverifiedIds(bed.path).ids]).toEqual(["u1"]);
    mirror.onSessionAppend(appendOf(0, HEADER + entry("x1"), { replace: true }));
    expect(keptFiles().sort()).toEqual([`${FILE}.${clock.now()}`, `${FILE}.${clock.now()}.unverified`]);
    expect(unverifiedIds(bed.path).ids.size).toBe(0);
  });

  // Mutant M-INHERIT: judge the bytes of an extension again against the provenance (already consumed): killed here, a
  // prompt pap sent would be shown as forged after every resend, and a forged one would not stay marked.
  it("an extension keeps the old verdicts: a sent prompt stays sent, a forged one stays marked", () => {
    fresh();
    const provenance = createProvenance();
    provenance.sent("hello");
    const mirror = open({ provenance });
    const text = HEADER + userEntry("u1", "hello") + userEntry("u2", "forged");
    mirror.onSessionAppend(appendOf(0, text));
    expect([...unverifiedIds(bed.path).ids]).toEqual(["u2"]);
    mirror.onSessionAppend(appendOf(0, text + entry("e9"), { replace: true }));
    expect(keptFiles()).toEqual([]);
    expect([...unverifiedIds(bed.path).ids]).toEqual(["u2"]);
  });
});
