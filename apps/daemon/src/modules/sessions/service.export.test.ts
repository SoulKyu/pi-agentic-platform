import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { ERROR_MESSAGES, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { EXPORT_TTL_MS, MAX_PENDING_EXPORTS } from "./exports.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const TEMPLATE = readFileSync(join(getPackageDir(), "dist", "core", "export-html", "template.js"), "utf8");
const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options: BedOptions = {}) => {
  bed = build(options);
};
afterEach(() => bed.dispose());

const exported = () => readdirSync(bed.exportsDir);
const outputOf = (index = 0): string => {
  const request = bed.spawned[index]?.requests.find((candidate) => candidate.type === "export_html");
  if (request?.type !== "export_html") throw new Error("no export_html request");
  return request.outputPath;
};

describe("exporting a session (M2R95-M2R98)", () => {
  it("has the worker write the file, patches it and answers the download URL", async () => {
    open({ replies: { export_html: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.store.setName(sessionId, "Fix login");
    const pending = bed.service.exportHtml(sessionId, OWNER);
    await bed.clock.advance(0);
    const path = outputOf();
    expect(path.startsWith(`${bed.exportsDir}/`)).toBe(true);
    writeFileSync(path, `<script>${TEMPLATE}</script>`);
    bed.answerHeld(0, "export_html", { data: { path } });
    const { url } = await pending;
    const token = url.split("/").pop() ?? "";
    expect(url).toBe(`/api/sessions/${sessionId}/export/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(path, "utf8")).not.toContain("node.children.forEach(sortChildren)");
    expect(bed.exports.take(token, sessionId, "someone-else")).toBeNull();
    expect(bed.exports.take(token, sessionId, OWNER.userId)).toEqual({ path, title: "Fix login" });
  });

  it("serves the file as written, and logs the anchor, when the template is not Pi 1.1.0's", async () => {
    const logs = captureLogger();
    open({ replies: { export_html: "held" }, logger: logs.logger });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const pending = bed.service.exportHtml(sessionId, OWNER);
    await bed.clock.advance(0);
    writeFileSync(outputOf(), "<script>nothing to patch</script>");
    bed.answerHeld(0, "export_html", { data: {} });
    await pending;
    expect(readFileSync(outputOf(), "utf8")).toBe("<script>nothing to patch</script>");
    expect(logs.lines.filter((line) => line.msg === "export_patch_skipped")).toHaveLength(1);
  });

  it("is a session the caller owns", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const stranger = { ...OWNER, userId: "u2" };
    await expect(bed.service.exportHtml(sessionId, stranger)).rejects.toThrow(new PapError("not_found"));
    await expect(bed.service.exportHtml("nope", OWNER)).rejects.toThrow(new PapError("not_found"));
    expect(bed.spawned[0]?.requests.map((request) => request.type)).toEqual([]);
    expect(exported()).toEqual([]);
  });

  it("starts the worker of a cold session (M2R98)", async () => {
    open({ replies: { export_html: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    const pending = bed.service.exportHtml(sessionId, OWNER);
    await bed.clock.advance(0);
    expect(bed.spawned).toHaveLength(2);
    writeFileSync(outputOf(1), "<html></html>");
    bed.answerHeld(1, "export_html", { data: {} });
    expect((await pending).url).toMatch(new RegExp(`^/api/sessions/${sessionId}/export/`));
  });

  it("leaves nothing behind at once when the worker refuses, and tells nothing of its text", async () => {
    const logs = captureLogger();
    open({
      replies: { export_html: { success: false, error: "ENOSPC: /home/u/secret/path <script>" } },
      logger: logs.logger,
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const timers = bed.clock.pending();
    const error = await bed.service.exportHtml(sessionId, OWNER).catch((caught: unknown) => caught);
    expect(error).toEqual(new PapError("command_failed"));
    expect((error as PapError).message).toBe(ERROR_MESSAGES.command_failed);
    expect(exported()).toEqual([]);
    expect(bed.clock.pending()).toBe(timers);
  });

  it("leaves nothing behind at once when the worker is lost, half-written file included", async () => {
    open({ replies: { export_html: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const pending = bed.service.exportHtml(sessionId, OWNER);
    const settled = pending.catch((caught: unknown) => caught);
    await bed.clock.advance(0);
    writeFileSync(outputOf(), "<html>half");
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    expect(await settled).toEqual(new PapError("worker_failed"));
    expect(exported()).toEqual([]);
  });

  it("keeps the entry on a timeout until the ten minutes end, and deletes what the worker writes late (M2R97)", async () => {
    open({ replies: { export_html: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const settled = bed.service.exportHtml(sessionId, OWNER).catch((caught: unknown) => caught);
    await bed.clock.advance(0);
    const path = outputOf();
    await bed.clock.advance(120_000);
    expect(await settled).toEqual(new PapError("timeout"));
    // Pi writes after the daemon gave up.
    writeFileSync(path, "<html>late</html>");
    expect(exported()).toHaveLength(1);
    await bed.clock.advance(EXPORT_TTL_MS - 120_000 - 1);
    expect(existsSync(path)).toBe(true);
    await bed.clock.advance(1);
    expect(exported()).toEqual([]);
  });

  it("refuses the 17th pending export before it starts a worker", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    const held = Array.from({ length: MAX_PENDING_EXPORTS }, () => bed.exports.prepare("x", "u9"));
    await expect(bed.service.exportHtml(sessionId, OWNER)).rejects.toThrow(new PapError("capacity"));
    expect(bed.spawned).toHaveLength(1);
    expect(held).toHaveLength(MAX_PENDING_EXPORTS);
  });

  it("discards the entry when the worker cannot be brought up", async () => {
    open({ start: (index) => (index === 0 ? undefined : { kind: "exit70" }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    const timers = bed.clock.pending();
    await expect(bed.service.exportHtml(sessionId, OWNER)).rejects.toThrow(PapError);
    expect(bed.clock.pending()).toBe(timers);
    expect(exported()).toEqual([]);
  });
});
