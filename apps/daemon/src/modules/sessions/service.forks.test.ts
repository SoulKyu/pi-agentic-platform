import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Logger, silentLogger } from "../../kernel/logger.ts";
import { ForkRefusal, type PiWriter } from "./pi-writer.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const OTHER = { ...OWNER, userId: "u2" };
const TWO: ReadonlyArray<readonly [string, string]> = [
  ["q0", "r0"],
  ["q1", "r1"],
];
const idsOf = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id?: string; type: string; name?: string })
    .filter((line) => line.type === "message")
    .map((line) => line.id);

/** A session whose worker has written its file and whose row remembers it; the worker stays up. */
async function boundSession(exchanges = TWO, open: BedOptions = {}) {
  bed = build(open);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const file = bed.writePiFile(0, exchanges);
  bed.store.bindPiFile(sessionId, file, "pi-0");
  return { sessionId, file };
}

describe("sessions.fork", () => {
  it("makes a cold session on a new file holding the branch above the message", async () => {
    const { sessionId, file } = await boundSession();
    const before = readFileSync(file, "utf8");
    const forked = await bed.service.fork({ sessionId, entryId: "u1" }, OWNER);
    expect(forked.text).toBe("q1");
    const row = bed.store.get(forked.sessionId);
    expect(row).toMatchObject({ cwd: bed.work, ownerId: "u1", name: null });
    expect(row?.piPath).not.toBe(file);
    expect(idsOf(row?.piPath ?? "")).toEqual(["s0", "u0", "a0"]);
    expect(bed.service.list(OWNER).find((s) => s.id === forked.sessionId)?.status).toBe("cold");
    expect(bed.spawned).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("makes a draft, with no file, at the first message", async () => {
    const { sessionId } = await boundSession();
    const forked = await bed.service.fork({ sessionId, entryId: "u0" }, OWNER);
    expect(forked.text).toBe("q0");
    expect(bed.store.get(forked.sessionId)).toMatchObject({ piPath: null, piSessionId: null, cwd: bed.work });
    expect(bed.service.list(OWNER).find((s) => s.id === forked.sessionId)?.status).toBe("cold");
  });

  it("refuses an entry that is not a user message with bad_request", async () => {
    const { sessionId } = await boundSession();
    await expect(bed.service.fork({ sessionId, entryId: "a0" }, OWNER)).rejects.toThrow(
      new PapError("bad_request"),
    );
    expect(bed.service.list(OWNER)).toHaveLength(1);
  });

  it("answers not_found for an unknown session and for another owner's, without reading its file", async () => {
    const { sessionId } = await boundSession();
    await expect(bed.service.fork({ sessionId: "nope", entryId: "u1" }, OWNER)).rejects.toThrow(
      new PapError("not_found"),
    );
    await expect(bed.service.fork({ sessionId, entryId: "u1" }, OTHER)).rejects.toThrow(
      new PapError("not_found"),
    );
    expect(bed.service.list(OTHER)).toEqual([]);
  });

  it("is session_empty for a draft source", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(bed.service.fork({ sessionId, entryId: "u1" }, OWNER)).rejects.toThrow(
      new PapError("session_empty"),
    );
  });

  it("clips the text handed to the composer by its JSON size", async () => {
    const { sessionId } = await boundSession([["\u0001".repeat(190_000), "r0"]]);
    const forked = await bed.service.fork({ sessionId, entryId: "u0" }, OWNER);
    expect(forked.text).toBe("\u0001".repeat(133_333));
    expect(Buffer.byteLength(JSON.stringify(forked.text))).toBeLessThanOrEqual(800_000);
  });
});

describe("sessions.clone", () => {
  it("names the copy after the source and lists it cold, on a file of its own", async () => {
    const { sessionId, file } = await boundSession();
    bed.store.setName(sessionId, "Fix login");
    const cloned = await bed.service.clone({ sessionId }, OWNER);
    const row = bed.store.get(cloned.sessionId);
    expect(row?.name).toMatch(/^Fix login · [0-9a-f]{4}$/);
    expect(row?.piPath).not.toBe(file);
    expect(idsOf(row?.piPath ?? "")).toEqual(["s0", "u0", "a0", "u1", "a1"]);
    expect(
      readFileSync(row?.piPath ?? "", "utf8")
        .trim()
        .split("\n")
        .at(-1),
    ).toContain(row?.name);
    const listed = bed.service.list(OWNER).find((s) => s.id === cloned.sessionId);
    expect(listed).toMatchObject({ status: "cold", name: row?.name, cwd: bed.work });
    expect(bed.spawned).toHaveLength(1);
  });

  it("copies the branch up to the worker's leaf while the session runs", async () => {
    const { sessionId } = await boundSession(TWO, { start: () => ({ kind: "ready", leafId: "a0" }) });
    const cloned = await bed.service.clone({ sessionId }, OWNER);
    expect(idsOf(bed.store.get(cloned.sessionId)?.piPath ?? "")).toEqual(["s0", "u0", "a0"]);
  });

  it("is session_empty for a draft, and not_found for another owner's session", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(bed.service.clone({ sessionId }, OWNER)).rejects.toThrow(new PapError("session_empty"));
    await expect(bed.service.clone({ sessionId }, OTHER)).rejects.toThrow(new PapError("not_found"));
  });

  it("is session_empty for a file with nothing to copy", async () => {
    const { sessionId } = await boundSession([]);
    await expect(bed.service.clone({ sessionId }, OWNER)).rejects.toThrow(new PapError("session_empty"));
  });
});

describe("what the service does with the writer's answer", () => {
  const fake = (over: Partial<PiWriter>): PiWriter => ({
    fork: () => {
      throw new Error("unused");
    },
    clone: () => {
      throw new Error("unused");
    },
    ...over,
  });

  it("maps refusals: too_large and empty to session_empty, unreadable to internal", async () => {
    const refuse = (refusal: ForkRefusal["refusal"]) =>
      fake({
        clone: () => {
          throw new ForkRefusal(refusal);
        },
      });
    for (const [refusal, code] of [
      ["too_large", "capacity"],
      ["lineage_mismatch", "internal"],
      ["empty", "session_empty"],
      ["unreadable", "internal"],
    ] as const) {
      const { sessionId } = await boundSession(TWO, { writer: refuse(refusal) });
      await expect(bed.service.clone({ sessionId }, OWNER)).rejects.toThrow(new PapError(code));
      bed.dispose();
    }
    bed = build();
  });

  it("deletes a file outside Pi's sessions directory, logs it and throws internal", async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (msg) => void warnings.push(msg),
      child: () => logger,
    };
    let stray = "";
    const { sessionId } = await boundSession(TWO, {
      logger,
      writer: fake({
        clone: () => {
          stray = join(bed.dir, "stray.jsonl");
          writeFileSync(stray, "x\n");
          return { file: stray, piSessionId: "pi-x" };
        },
      }),
    });
    await expect(bed.service.clone({ sessionId }, OWNER)).rejects.toThrow(new PapError("internal"));
    expect(existsSync(stray)).toBe(false);
    expect(bed.service.list(OWNER)).toHaveLength(1);
    expect(warnings).toContain("fork_file_refused");
  });

  it("deletes the new file when the text cannot be clipped, before any row exists", async () => {
    let made = "";
    const { sessionId } = await boundSession(TWO, {
      writer: fake({
        fork: () => {
          made = join(bed.sessionsDir, "made.jsonl");
          writeFileSync(made, "x\n");
          return { file: made, piSessionId: "pi-x", text: 5 as unknown as string };
        },
      }),
    });
    await expect(bed.service.fork({ sessionId, entryId: "u1" }, OWNER)).rejects.toThrow(
      new PapError("internal"),
    );
    expect(existsSync(made)).toBe(false);
    expect(bed.service.list(OWNER)).toHaveLength(1);
  });

  it("deletes the new file when its row cannot be stored", async () => {
    const { sessionId } = await boundSession();
    vi.spyOn(bed.store, "insert").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(bed.service.clone({ sessionId }, OWNER)).rejects.toThrow(new PapError("internal"));
    expect(bed.service.list(OWNER)).toHaveLength(1);
    expect(readdirSync(bed.sessionsDir)).toEqual(["pi-0.jsonl"]);
  });
});
