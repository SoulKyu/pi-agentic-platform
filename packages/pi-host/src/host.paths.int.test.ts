import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostBed, isApproval, toolScript } from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

const unescape = (text: string) =>
  text.replace(/\\u\{([0-9A-F]+)\}/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));

// R91 / M5R31: the card must name the file Pi writes. Pi rewrites a path before it opens it (a leading `@`,
// some unicode blanks); this probe runs the real worker and compares the card with what lands on disk.
describe("pi-host worker: the card names the file Pi writes (R91)", () => {
  it.each([
    "../ out.txt",
    "../ out.txt",
    "../ out.txt",
    "../ out.txt",
    "../ out.txt",
    "../　out.txt",
    "../⠀out.txt",
    "@../plain out.txt",
  ])("for the path %j", async (path) => {
    await bed.start(toolScript("write", { path, content: "x" }));
    const host = bed.host();
    const known = new Set(readdirSync(bed.root));
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isApproval);
    const arrow = String(ask.message)
      .split("\n")
      .find((line) => line.startsWith("→ "));
    expect(arrow?.endsWith(" (outside the session directory)")).toBe(true);
    const target = unescape((arrow ?? "").slice("→ ".length, -" (outside the session directory)".length));
    host.send({ type: "approval_response", id: ask.id, answer: "once" });
    await host.waitFor((r) => r.type === "tool_execution_end");
    const created = readdirSync(bed.root).filter((name) => !known.has(name));
    expect(created.map((name) => join(bed.root, name))).toEqual([target]);
    expect(existsSync(target)).toBe(true);
  });
});
