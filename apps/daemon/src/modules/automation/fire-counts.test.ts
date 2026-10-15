import { afterAll, afterEach, describe, expect, it } from "vitest";
import { countFire, fireSamples } from "./fire-counts.ts";
import { writeJournal } from "./fire-journal.ts";
import { createHookJournal } from "./hook-journal.ts";
import { createAutomationBed, webhookInput } from "./testing/bed.ts";

const bed = createAutomationBed();
afterEach(() => bed.db.run("DELETE FROM trigger_fires"));
afterAll(() => bed.dispose());
const trigger = bed.triggers.create(bed.owner(), webhookInput(bed.folder)).trigger;
const entry = (verdict: "fired" | "paused" | "dedup", source = "webhook") => ({
  triggerId: trigger.id,
  ownerId: "u1",
  source,
  verdict,
  detail: null,
  taskId: null,
  dedupKey: null,
  at: bed.clock.now(),
});
const total = (source: string, verdict: string): number =>
  fireSamples(bed.db).find((s) => s.labels.source === source && s.labels.verdict === verdict)?.value ?? 0;

describe("pap_trigger_fires_total", () => {
  it("counts each journal event once, a collapsed refusal row included", () => {
    const before = total("webhook", "paused");
    writeJournal(bed.db, entry("paused"));
    writeJournal(bed.db, entry("paused"));
    writeJournal(bed.db, entry("paused"));
    expect(bed.db.all("SELECT 1 FROM trigger_fires WHERE verdict = 'paused'")).toHaveLength(1);
    expect(total("webhook", "paused") - before).toBe(3);
  });

  it("counts the hook route's collapsed unauthorized row once per attempt", () => {
    const journal = createHookJournal({ db: bed.db, clock: bed.clock, logger: bed.logger });
    const before = total("webhook", "unauthorized");
    for (let i = 0; i < 4; i += 1) journal.unauthorized({ id: trigger.id, ownerId: "u1" }, "secret");
    expect(total("webhook", "unauthorized") - before).toBe(4);
  });

  it("never makes a label of a source or verdict outside the closed sets", () => {
    countFire(bed.db, "a trigger name", "fired");
    countFire(bed.db, "feed", "free text");
    const labels = fireSamples(bed.db).flatMap((s) => Object.values(s.labels));
    expect(labels).not.toContain("a trigger name");
    expect(labels).not.toContain("free text");
  });
});
