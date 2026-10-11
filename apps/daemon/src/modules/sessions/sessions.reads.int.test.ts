import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

// 49 characters and a newline: 600 lines are 30 000 characters.
const LINE = `${"0123456789".repeat(4)}012345678`;

it("cuts a tool result on the wire and gives it whole through sessions.toolOutput", async () => {
  const bed = await createIntBed({
    steps: [{ toolCalls: [{ name: "read", args: { path: "big.txt" }, id: "c1" }] }, { text: "read it" }],
  });
  try {
    writeFileSync(join(bed.work, "big.txt"), `${Array.from({ length: 600 }, () => LINE).join("\n")}\n`);
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const live = await bed.subscribe(sessionId);
    await promptAndSettle(bed, live, sessionId, "read big.txt");
    const end = live.events().find((event) => {
      const piEvent =
        event.kind === "pi" ? (event.event as { type: string; message?: { role?: string } }) : null;
      return piEvent?.type === "message_end" && piEvent.message?.role === "toolResult";
    });
    expect(JSON.stringify(end)).toContain("papTruncated");
    const late = (await bed.subscribe(sessionId)).events()[0];
    if (late?.kind !== "snapshot") throw new Error("no snapshot");
    expect(JSON.stringify(late.rows)).toContain("papTruncated");
    const output = await bed.rpc["sessions.toolOutput"]({ sessionId, toolCallId: "c1" }, bed.ctx);
    expect(output.truncated).toBe(false);
    expect(output.text).toHaveLength(30_000);
    expect(output.text.startsWith(LINE)).toBe(true);
    expect(JSON.parse(output.args ?? "null")).toEqual({ path: "big.txt" });
    expect(await bed.rpc["sessions.branches"]({ sessionId }, bed.ctx)).toMatchObject({ points: [] });
    const page = await bed.rpc["sessions.history"](
      { sessionId, before: late.history.oldestEntryId ?? "x" },
      bed.ctx,
    );
    expect(page.hasMore).toBe(false);
  } finally {
    await bed.dispose();
  }
});
