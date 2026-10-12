import type { SessionStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntBed, type IntBed, type Subscription } from "./testing/int-bed.ts";
import { ASK_ALL, EDITOR_TEXT, PICKER, STATUS_BAR, WIDGETS } from "./testing/extensions.ts";

const beds: IntBed[] = [];
afterEach(async () => {
  for (const bed of beds.splice(0)) await bed.dispose();
});

async function open(extensions: Record<string, string>) {
  const bed = await createIntBed({ steps: [{ text: "unused" }] }, { extensions });
  beds.push(bed);
  const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
  return { bed, sessionId, sub: await bed.subscribe(sessionId) };
}

const dialogOf = async (sub: Subscription, method: string) => {
  const event = await sub.waitFor((e) => e.kind === "dialog_open" && e.dialog.method === method);
  if (event.kind !== "dialog_open") throw new Error("no dialog");
  return event.dialog;
};

type Snapshot = Extract<SessionStreamEvent, { kind: "snapshot" }>;

/** The worker starts at create, so session_start decorations can land before or after a subscription: a fresh snapshot is the stable place to read them. */
async function snapshotWhen(bed: IntBed, sessionId: string, ready: (snapshot: Snapshot) => boolean) {
  let found: Snapshot | undefined;
  await vi.waitFor(
    async () => {
      const first = (await bed.subscribe(sessionId)).events()[0];
      if (first?.kind !== "snapshot" || !ready(first)) throw new Error("not yet");
      found = first;
    },
    { timeout: 20_000 },
  );
  return found as Snapshot;
}

describe("extension UI end to end (D18)", () => {
  it("answers a select, an input, an editor and a confirm", async () => {
    const { bed, sub, sessionId } = await open({ ask: ASK_ALL });
    const prompted = bed.rpc["sessions.prompt"]({ sessionId, text: "/ask" }, bed.ctx);
    const select = await dialogOf(sub, "select");
    expect(select.options).toEqual(["a", "b"]);
    await bed.rpc["sessions.respondDialog"](
      { sessionId, dialogId: select.id, response: { value: "b" } },
      bed.ctx,
    );
    const input = await dialogOf(sub, "input");
    expect(input.placeholder).toBe("placeholder");
    await bed.rpc["sessions.respondDialog"](
      { sessionId, dialogId: input.id, response: { value: "typed" } },
      bed.ctx,
    );
    const editor = await dialogOf(sub, "editor");
    expect(editor.prefill).toBe("draft text");
    await bed.rpc["sessions.respondDialog"](
      { sessionId, dialogId: editor.id, response: { value: "edited" } },
      bed.ctx,
    );
    const confirm = await dialogOf(sub, "confirm");
    await bed.rpc["sessions.respondDialog"](
      { sessionId, dialogId: confirm.id, response: { confirmed: true } },
      bed.ctx,
    );
    await sub.waitFor(
      (e) => e.kind === "notice" && e.text === "answers:b|typed|edited|true" && e.source === "extension",
    );
    expect(await prompted).toEqual({ disposition: "handled" });
  });

  it("shows statuses after a reconnect and runs a status command", async () => {
    const { bed, sub, sessionId } = await open({ status: STATUS_BAR });
    const snapshot = await snapshotWhen(bed, sessionId, (s) => s.statuses.length === 2);
    expect(snapshot.statuses).toEqual([
      { key: "command:/hello", text: "Say hello" },
      { key: "branch", text: "main" },
    ]);
    // What the status bar's button does in the client (Task 27): send the command as a prompt.
    expect(await bed.rpc["sessions.prompt"]({ sessionId, text: "/hello" }, bed.ctx)).toEqual({
      disposition: "handled",
    });
    await sub.waitFor(
      (e) => e.kind === "notice" && e.text === "hello from the status bar" && e.source === "extension",
    );
  });

  it("shows a widget of lines and re-renders a component widget", async () => {
    const { bed, sub, sessionId } = await open({ widgets: WIDGETS });
    const snapshot = await snapshotWhen(bed, sessionId, (s) => s.widgets.length === 2);
    expect(snapshot.widgets).toEqual([
      { key: "todo", lines: ["- write tests", "- ship"], placement: "aboveEditor" },
      { key: "ticker", lines: ["ticks: 0"], placement: "belowEditor" },
    ]);
    await bed.rpc["sessions.prompt"]({ sessionId, text: "/tick" }, bed.ctx);
    await sub.waitFor((e) => e.kind === "widget" && e.key === "ticker" && e.widget?.lines[0] === "ticks: 1");
  });

  it("drives a custom panel and keeps it in the snapshot while it is open", async () => {
    const { bed, sub, sessionId } = await open({ picker: PICKER });
    const prompted = bed.rpc["sessions.prompt"]({ sessionId, text: "/pick" }, bed.ctx);
    const opened = await sub.waitFor((e) => e.kind === "panel");
    if (opened.kind !== "panel") throw new Error("no panel");
    expect(opened.panel.lines).toEqual(["> alpha", "  beta"]);
    const again = await bed.subscribe(sessionId);
    const snapshot = again.events()[0];
    expect(snapshot?.kind === "snapshot" && snapshot.panels).toEqual([
      { id: opened.panel.id, lines: ["> alpha", "  beta"] },
    ]);
    await bed.rpc["sessions.panelInput"]({ sessionId, panelId: opened.panel.id, data: "\u001b[B" }, bed.ctx);
    await sub.waitFor((e) => e.kind === "panel" && e.panel.lines[1] === "> beta");
    await bed.rpc["sessions.panelInput"]({ sessionId, panelId: opened.panel.id, data: "\r" }, bed.ctx);
    await sub.waitFor((e) => e.kind === "panel_closed" && e.id === opened.panel.id);
    await sub.waitFor((e) => e.kind === "notice" && e.text === "picked:beta" && e.source === "extension");
    expect(await prompted).toEqual({ disposition: "handled" });
  });

  it("puts an extension's text in the composer", async () => {
    const { bed, sub, sessionId } = await open({ fill: EDITOR_TEXT });
    await bed.rpc["sessions.prompt"]({ sessionId, text: "/fill" }, bed.ctx);
    await sub.waitFor((e) => e.kind === "editor_text" && e.text === "text from the extension");
  });
});
