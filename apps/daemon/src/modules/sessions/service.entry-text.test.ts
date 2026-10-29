import { readFileSync, writeFileSync } from "node:fs";
import { type Caller, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { testCaller } from "../../testing/caller.ts";

const OTHER: Caller = testCaller({ userId: "u2" });
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

async function session(exchanges: ReadonlyArray<readonly [string, string]>) {
  bed = build();
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const file = bed.writePiFile(0, exchanges);
  bed.emit(0, { type: "agent_settled", aborted: false });
  return { sessionId, file };
}

describe("entryText (the artifact's source: the daemon's own transcript)", () => {
  it("is the text of an assistant entry of the caller's session, by entry id", async () => {
    const { sessionId } = await session([
      ["draw", "```html\n<p>zero</p>\n```"],
      ["again", "```html\n<p>one</p>\n```"],
    ]);
    expect(await bed.service.entryText(sessionId, "a0", OWNER)).toBe("```html\n<p>zero</p>\n```");
    expect(await bed.service.entryText(sessionId, "a1", OWNER)).toBe("```html\n<p>one</p>\n```");
  });

  it("joins the text blocks of the entry with nothing between them, thinking and calls left out", async () => {
    const { sessionId, file } = await session([["draw", "x"]]);
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const entry = lines.find((line) => line.id === "a0");
    entry.message.content = [
      { type: "text", text: "```html\n<p>a" },
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "b</p>\n```" },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    bed.emit(0, { type: "agent_settled", aborted: false });
    expect(await bed.service.entryText(sessionId, "a0", OWNER)).toBe("```html\n<p>ab</p>\n```");
  });

  it("is not clipped for the wire: a long reply comes whole", async () => {
    const big = `\`\`\`html\n${"y".repeat(200_000)}\n\`\`\``;
    const { sessionId } = await session([["draw", big]]);
    expect(await bed.service.entryText(sessionId, "a0", OWNER)).toBe(big);
  });

  it("is null for a user entry, the system entry, an unknown id and an id that is another entry's text", async () => {
    const { sessionId } = await session([["draw", "reply"]]);
    expect(await bed.service.entryText(sessionId, "u0", OWNER)).toBeNull();
    expect(await bed.service.entryText(sessionId, "s0", OWNER)).toBeNull();
    expect(await bed.service.entryText(sessionId, "nope", OWNER)).toBeNull();
  });

  it("is not_found for another owner's session and for an unknown one, and null for a session with no file yet", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.entryText(sessionId, "a0", OWNER)).toBeNull();
    await expect(bed.service.entryText(sessionId, "a0", OTHER)).rejects.toEqual(new PapError("not_found"));
    await expect(bed.service.entryText("missing", "a0", OWNER)).rejects.toEqual(new PapError("not_found"));
  });
});
