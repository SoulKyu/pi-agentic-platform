import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostBed } from "./testing/host-bed.ts";
import { HOSTILE_SOURCE, PICKER_SOURCE, writeExtension } from "./testing/extensions.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

describe("pi-host worker: custom panels", () => {
  it("drives a custom panel over IPC and gets the prompt's answer only once it closed (R38)", async () => {
    writeExtension(bed.agentDir, "picker", PICKER_SOURCE);
    await bed.start({ steps: [{ text: "unused" }] });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "/pick" });
    const first = await host.waitFor((r) => r.type === "custom_render");
    host.send({ type: "custom_input", id: first.id, data: "\u001b[B" });
    await host.waitFor((r) => r.type === "custom_render" && (r.lines as string[])[1] === "> beta");
    expect(host.records.some((r) => r.type === "response" && r.id === "p1")).toBe(false);
    host.send({ type: "custom_input", id: first.id, data: "\r" });
    await host.waitFor((r) => r.type === "custom_close" && r.id === first.id);
    await host.waitFor(
      (r) => r.type === "extension_ui_request" && r.method === "notify" && r.message === "picked:beta",
    );
    expect(await host.waitFor((r) => r.type === "response" && r.id === "p1")).toMatchObject({
      data: { disposition: "handled" },
    });
  });

  it("settles an open panel on custom_cancel", async () => {
    writeExtension(bed.agentDir, "picker", PICKER_SOURCE);
    await bed.start({ steps: [{ text: "unused" }] });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "/pick" });
    const first = await host.waitFor((r) => r.type === "custom_render");
    host.send({ type: "custom_cancel", id: first.id });
    await host.waitFor((r) => r.type === "custom_close" && r.id === first.id);
    await host.waitFor(
      (r) => r.type === "extension_ui_request" && r.method === "notify" && r.message === "picked:undefined",
    );
  });

  it("never sends a terminal escape other than SGR to the daemon", async () => {
    writeExtension(bed.agentDir, "hostile", HOSTILE_SOURCE);
    await bed.start({ steps: [{ text: "unused" }] });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "/hostile" });
    const panel = await host.waitFor((r) => r.type === "custom_render");
    const widget = await host.waitFor((r) => r.type === "extension_ui_request" && r.method === "setWidget");
    const clean = "\u001b[31mred\u001b[0mlink!";
    expect(panel.lines).toEqual([clean]);
    expect(widget.widgetLines).toEqual([clean]);
    host.send({ type: "custom_cancel", id: panel.id });
    await host.waitFor((r) => r.type === "custom_close");
  });
});
