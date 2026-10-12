import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostBed, isApproval, toolScript, toolText } from "./testing/host-bed.ts";

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
    "../\u00A0out.txt",
    "../\u1680out.txt",
    "../\u2000out.txt",
    "../\u202Fout.txt",
    "../\u205Fout.txt",
    "../\u3000out.txt",
    "../\u2800out.txt",
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

// Probe behind `kernel-path.ts`: Pi removes `..` lexically (path.resolve) before it opens a file, even for an absolute
// path, where the kernel would follow a symlink first. The policy judges both readings; this pins what Pi does.
describe("pi-host worker: Pi collapses .. before it follows a symlink", () => {
  it("writes `<cwd>/link/../probe.txt` next to the folder's own files, not beside the link's target", async () => {
    mkdirSync(join(bed.root, "real", "sub"), { recursive: true });
    symlinkSync(join(bed.root, "real", "sub"), join(bed.cwd, "link"), "dir");
    await bed.start(toolScript("write", { path: `${bed.cwd}/link/../probe.txt`, content: "x" }));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isApproval);
    // The kernel's reading leaves the folder, so it asks, and the card names that file.
    expect(String(ask.message)).toContain(
      `\u2192 ${join(bed.root, "real", "probe.txt")} (outside the session directory)`,
    );
    host.send({ type: "approval_response", id: ask.id, answer: "once" });
    await host.waitFor((r) => r.type === "tool_execution_end");
    expect(existsSync(join(bed.cwd, "probe.txt"))).toBe(true);
    expect(existsSync(join(bed.root, "real", "probe.txt"))).toBe(false);
  });

  it("reads `/proc/self/root/..<path>` as `/proc/self<path>`, which does not exist", async () => {
    mkdirSync(join(bed.root, "real"), { recursive: true });
    writeFileSync(join(bed.root, "real", "kernel.txt"), "KERNELORDER");
    await bed.start(toolScript("read", { path: `/proc/self/root/..${bed.root}/real/kernel.txt` }));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(toolText(end)).toContain("ENOENT");
    expect(toolText(end)).not.toContain("KERNELORDER");
  });
});
