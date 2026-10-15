import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskSessionPolicy } from "./automation-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const POLICY: TaskSessionPolicy = { mode: "supervised", tools: ["read"], preset: "read-only", tainted: true };

/** A task session whose Pi file exists and is bound to its row; the worker is released unless `keep`. */
async function bound(keep = false) {
  bed = build();
  const { sessionId } = await bed.service.automation.createTaskSession({
    ownerId: "u1",
    cwd: bed.work,
    policy: POLICY,
  });
  const file = bed.writePiFile(0);
  bed.store.bindPiFile(sessionId, file, "pi-0");
  if (!keep) bed.service.automation.releaseIdle("u1", sessionId);
  return { sessionId, file };
}
// The bed migrates sessions only: the policy module's table is made here, with the cascade its migration declares.
const policyRows = () => bed.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_policy")?.n;
const withPolicyTable = (sessionId: string) => {
  bed.db.run(
    "CREATE TABLE session_policy (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, owner_id TEXT NOT NULL)",
  );
  bed.db.run("INSERT INTO session_policy (session_id, owner_id) VALUES ($sessionId, 'u1')", { sessionId });
};

describe("deleteTaskSession (M10R155)", () => {
  it("refuses a session with a live worker and removes nothing", async () => {
    const { sessionId, file } = await bound(true);
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("busy");
    expect(bed.store.get(sessionId)).toBeDefined();
    expect(existsSync(file)).toBe(true);
  });

  it("removes the row, its policy row and the Pi file of an idle session", async () => {
    const { sessionId, file } = await bound();
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("deleted");
    expect(bed.store.get(sessionId)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("gone");
    expect(bed.service.list(OWNER)).toEqual([]);
  });

  it("removes the row of a session that never had a file", async () => {
    bed = build();
    const { sessionId } = await bed.service.automation.createTaskSession({
      ownerId: "u1",
      cwd: bed.work,
      policy: POLICY,
    });
    bed.service.automation.releaseIdle("u1", sessionId);
    await bed.clock.advance(0);
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("deleted");
    expect(bed.store.get(sessionId)).toBeUndefined();
  });

  it("unlinks a link under sessions/ and leaves its target outside", async () => {
    const { sessionId } = await bound();
    const outside = join(bed.dir, "outside.jsonl");
    writeFileSync(outside, "keep me\n");
    const link = join(bed.sessionsDir, "linked.jsonl");
    symlinkSync(outside, link);
    bed.db.run("UPDATE sessions SET pi_path = $link WHERE id = $id", { link, id: sessionId });
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("deleted");
    expect(bed.store.get(sessionId)).toBeUndefined();
    expect(existsSync(outside)).toBe(true);
  });

  it("unlinks a link that stays under sessions/, never its target", async () => {
    const { sessionId } = await bound();
    const target = join(bed.sessionsDir, "other.jsonl");
    writeFileSync(target, "keep me\n");
    const link = join(bed.sessionsDir, "inner-link.jsonl");
    symlinkSync(target, link);
    bed.db.run("UPDATE sessions SET pi_path = $link WHERE id = $id", { link, id: sessionId });
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("deleted");
    expect(existsSync(link)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it("leaves a file outside sessions/ alone", async () => {
    const { sessionId } = await bound();
    const elsewhere = join(bed.dir, "elsewhere");
    mkdirSync(elsewhere);
    const stray = join(elsewhere, "notes.jsonl");
    writeFileSync(stray, "keep me\n");
    bed.db.run("UPDATE sessions SET pi_path = $stray WHERE id = $id", { stray, id: sessionId });
    expect(bed.service.automation.deleteTaskSession("u1", sessionId)).toBe("deleted");
    expect(bed.store.get(sessionId)).toBeUndefined();
    expect(existsSync(stray)).toBe(true);
  });

  it("takes the policy row with the session row", async () => {
    const { sessionId } = await bound();
    withPolicyTable(sessionId);
    expect(policyRows()).toBe(1);
    bed.service.automation.deleteTaskSession("u1", sessionId);
    expect(policyRows()).toBe(0);
  });
});
