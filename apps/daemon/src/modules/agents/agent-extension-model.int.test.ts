import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { markOf, waitIdle } from "../../security/testing/fixtures.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
// pi-claude-bridge's registration, mimicked: `pap-test-bridge/bridge-one`, registered at load, answers BRIDGE-REPLY-7c41.
const BRIDGE_LIKE = readFileSync(
  join(REPO, "packages/pi-host/src/testing/bridge-like-extension.mjs"),
  "utf8",
);
const FAUX_REPLY = "FAUX-REPLY-0d93";

let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

/** What the session said through pap's notices: those in a snapshot and those streamed after it. */
const noticesOf = (events: ReadonlyArray<{ kind: string }>) =>
  events.flatMap((event) =>
    event.kind === "snapshot"
      ? ((event as { notices?: unknown[] }).notices ?? [])
      : event.kind === "notice"
        ? [event]
        : [],
  );
const streamOf = (b: VmBed) => b.owner.client.events.map((frame) => frame.event as { kind: string });

/** The assistant messages of every Pi session file the VM's folder holds: what Pi itself recorded. */
function recordedAssistant(b: VmBed): Array<{ provider: string; model: string; text: string }> {
  const sessions = join(b.t.home, "tmp", "agent-vm");
  const files = readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter(
    (name) => name.includes(`${join(".pi", "sessions")}`) && name.endsWith(".jsonl"),
  );
  return files.flatMap((name) =>
    readFileSync(join(sessions, name), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
      .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
      .map((entry) => {
        const message = entry.message as {
          provider: string;
          model: string;
          content: Array<{ text?: string }>;
        };
        return {
          provider: message.provider,
          model: message.model,
          text: message.content.map((part) => part.text ?? "").join(""),
        };
      }),
  );
}

/** An agent of Atlas on `model` in a VM whose Pi has the bridge-like extension; one turn, then the thread's stream. */
async function turn(
  model: { provider: string; modelId: string },
  options: { settings?: object; preset?: string } = {},
) {
  bed = await startVmBed(
    { steps: [{ text: FAUX_REPLY }] },
    {
      imageFiles: {
        "extensions/pap-test-bridge.js": BRIDGE_LIKE,
        ...(options.settings ? { "settings.json": JSON.stringify(options.settings) } : {}),
      },
    },
  );
  const agentId = await bed.createAgent({
    name: "Atlas",
    model,
    ...(options.preset ? { preset: options.preset } : {}),
  });
  const sessionId = await bed.openThread(agentId);
  const mark = markOf(bed.owner.client);
  await bed.call("sessions.prompt", { sessionId, text: "hello" });
  await waitIdle(bed.owner.client, mark);
  return { sessionId, recorded: recordedAssistant(bed), events: streamOf(bed) };
}

const BRIDGE = { provider: "pap-test-bridge", modelId: "bridge-one" };

describe("an agent whose model an extension registers", () => {
  it("resolves the model in its worker and runs a turn on it, not on Pi's default", async () => {
    const { recorded, events } = await turn(BRIDGE);
    // The worker took the profile's model (a refused one would leave the scripted default, and log it).
    const loadout = events.flatMap((event) => {
      const carried = event as { loadout?: { model?: unknown } | null };
      return (event.kind === "loadout" || event.kind === "snapshot") && carried.loadout
        ? [carried.loadout]
        : [];
    });
    expect(loadout.at(-1)?.model).toMatchObject({ provider: "pap-test-bridge", id: "bridge-one" });
    // The turn was served by the extension's own stream, and Pi's file says so.
    expect(JSON.stringify(events)).toContain("BRIDGE-REPLY-7c41");
    expect(JSON.stringify(events)).not.toContain(FAUX_REPLY);
    expect(recorded).toEqual([
      { provider: "pap-test-bridge", model: "bridge-one", text: "BRIDGE-REPLY-7c41" },
    ]);
    // Taken, so the session says nothing about it.
    expect(noticesOf(events)).toEqual([]);
  }, 120_000);

  it("says in the session when its worker refuses the saved model, naming it and what runs instead", async () => {
    const { sessionId, recorded, events } = await turn({
      provider: "pap-test-bridge",
      modelId: "bridge-two",
    });
    expect(recorded).toEqual([{ provider: "faux", model: "scripted", text: FAUX_REPLY }]);
    const refused = {
      level: "warning",
      code: "agent_model_refused",
      params: { model: "pap-test-bridge/bridge-two", running: "faux/scripted" },
    };
    expect(noticesOf(events)).toEqual([expect.objectContaining(refused)]);
    expect(JSON.stringify(noticesOf(events))).toContain("Settings › Models");
    // A tab that opens the thread later still sees it: the notice is in the snapshot.
    const late = await (bed as VmBed).t.connect((bed as VmBed).owner.cookie);
    try {
      const { sub } = await (bed as VmBed).call<{ sub: string }>("subscribe.session", { sessionId });
      expect(sub).toBeTruthy();
      await late.call("subscribe.session", { sessionId });
      const first = await late.waitForEvent(
        (frame) => (frame.event as { kind?: string }).kind === "snapshot",
      );
      expect(noticesOf([first.event as { kind: string }])).toEqual([expect.objectContaining(refused)]);
    } finally {
      late.close();
    }
  }, 120_000);

  it("m1.selection-names-it: My selection naming the bridge's model is what the worker accepts, silently", async () => {
    const { recorded, events } = await turn(BRIDGE, {
      settings: { enabledModels: ["faux/*", "pap-test-bridge/bridge-one"] },
    });
    expect(recorded).toEqual([
      { provider: "pap-test-bridge", model: "bridge-one", text: "BRIDGE-REPLY-7c41" },
    ]);
    expect(noticesOf(events)).toEqual([]);
  }, 120_000);

  it("m1.selection-without-it: a selection that leaves the bridge out is refused, and the session says so", async () => {
    const { recorded, events } = await turn(BRIDGE, { settings: { enabledModels: ["faux/*"] } });
    expect(recorded).toEqual([{ provider: "faux", model: "scripted", text: FAUX_REPLY }]);
    expect(noticesOf(events)).toEqual([
      expect.objectContaining({
        code: "agent_model_refused",
        params: { model: "pap-test-bridge/bridge-one", running: "faux/scripted" },
      }),
    ]);
  }, 120_000);

  it("i2.chat-only: an agent in Chat only loads no extension, and its notice says that, not the selection", async () => {
    const { recorded, events } = await turn(BRIDGE, { preset: "chat" });
    expect(recorded).toEqual([{ provider: "faux", model: "scripted", text: FAUX_REPLY }]);
    expect(noticesOf(events)).toEqual([
      expect.objectContaining({
        code: "agent_model_refused_chat",
        params: { model: "pap-test-bridge/bridge-one" },
      }),
    ]);
    expect(JSON.stringify(noticesOf(events))).toContain("Chat only, which loads no extension");
  }, 120_000);

  it("n1.chat-only-pi-model: in Chat only a model of Pi's own provider is refused for what it is, with the Settings advice", async () => {
    const { recorded, events } = await turn({ provider: "faux", modelId: "nope" }, { preset: "chat" });
    expect(recorded).toEqual([{ provider: "faux", model: "scripted", text: FAUX_REPLY }]);
    expect(noticesOf(events)).toEqual([
      expect.objectContaining({
        code: "agent_model_refused",
        params: { model: "faux/nope", running: "faux/scripted" },
      }),
    ]);
    expect(JSON.stringify(noticesOf(events))).not.toContain("Chat only");
  }, 120_000);
});
