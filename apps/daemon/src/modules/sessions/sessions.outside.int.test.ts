import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

const entry = (id: string, parentId: string, message: object) =>
  `${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-10T00:00:09.000Z", message })}\n`;

it("shows the outside-write notice and the new entries when a session is reopened within the cursor cache window (owner Q13, I2)", async () => {
  const bed = await createIntBed({ steps: [{ text: "first" }] }, { workerIdleMs: 1500 });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold", 10_000);
    const cursor = sub.cursor();
    expect(cursor).toBeDefined();
    sub.close();

    // The CLI resumes the session and writes to its file, after pap's worker is gone.
    const file = readdirSync(bed.agentDir, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(bed.agentDir, name))[0];
    if (file === undefined) throw new Error("no Pi file");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const leaf = (JSON.parse(lines.at(-1) ?? "{}") as { id: string }).id;
    appendFileSync(
      file,
      entry("cli-u", leaf, { role: "user", content: "typed in the terminal", timestamp: 3 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    bed.sessions.scanPort.touched(sessionId, Date.now(), false);

    const reopened = await bed.subscribe(sessionId, cursor);
    const first = reopened.events()[0];
    if (first?.kind !== "snapshot") throw new Error(`expected a snapshot, got ${first?.kind}`);
    expect(first.outsideWrite).toBe(true);
    expect(JSON.stringify(first.rows)).toContain("typed in the terminal");
  } finally {
    await bed.dispose();
  }
}, 60_000);
