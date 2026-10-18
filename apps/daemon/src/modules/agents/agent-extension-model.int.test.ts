import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createIntBed, type IntBed, promptAndSettle } from "../sessions/testing/int-bed.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
// pi-claude-bridge's registration, mimicked: `pap-test-bridge/bridge-one`, registered at load, answers BRIDGE-REPLY-7c41.
const BRIDGE_LIKE = readFileSync(
  join(REPO, "packages/pi-host/src/testing/bridge-like-extension.mjs"),
  "utf8",
);
const ID = "atlas-1a2b";
const FAUX_REPLY = "FAUX-REPLY-0d93";

let bed: IntBed;

/** What the session said through pap's notices: those in a snapshot and those streamed after it. */
const noticesOf = (events: ReadonlyArray<{ kind: string }>) =>
  events.flatMap((event) =>
    event.kind === "snapshot"
      ? ((event as { notices?: unknown[] }).notices ?? [])
      : event.kind === "notice"
        ? [event]
        : [],
  );
afterEach(async () => {
  await bed?.dispose();
});

/** The agent's home and the ports the sessions module reads; no sandbox, so no bwrap is needed. */
function world(model: { provider: string; modelId: string }, extra: object = {}) {
  const home = join(bed.papHome, "agents", ID);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "MEMORY.md"), "# Memory\n");
  bed.sessions.setAgentPorts({
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ID
          ? {
              input: AgentInput.parse({
                name: "Atlas",
                model,
                sandbox: { required: false, network: false },
                ...extra,
              }),
              name: "Atlas",
              quarantined: false,
            }
          : null,
      vaultOf: () => ({}),
      probe: {
        ensure: async () => {
          throw new Error("an agent without a sandbox never asks the probe");
        },
      },
      egress: {
        ready: async () => {},
        recheck: async () => {},
        status: () => ({ usable: false, python: null, reason: "no_python" }),
        forwarderPath: "/usr/bin/true",
        openCommand: async () => ({ reason: "unavailable" }),
        closeCommand: async () => ({ hosts: [], truncated: true, up: 0, down: 0 }),
        dropSession: async () => {},
        shutdown: async () => {},
      },
    },
  });
}

/** The assistant messages of every Pi session file the bed's agent folder holds: what Pi itself recorded. */
function recordedAssistant(): Array<{ provider: string; model: string; text: string }> {
  const sessions = join(bed.agentDir, "sessions");
  const files = readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".jsonl"),
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

describe("an agent whose model an extension registers", () => {
  it("resolves the model in its worker and runs a turn on it, not on Pi's default", async () => {
    bed = await createIntBed(
      { steps: [{ text: FAUX_REPLY }] },
      { extensions: { "pap-test-bridge": BRIDGE_LIKE } },
    );
    world({ provider: "pap-test-bridge", modelId: "bridge-one" });
    const { sessionId } = await bed.sessions.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "thread",
    });
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");

    // The worker took the profile's model (a refused one would leave the scripted default, and log it).
    const loadout = sub
      .events()
      .flatMap((event) =>
        (event.kind === "loadout" || event.kind === "snapshot") && event.loadout ? [event.loadout] : [],
      );
    expect(loadout.at(-1)?.model).toMatchObject({ provider: "pap-test-bridge", id: "bridge-one" });
    // The turn was served by the extension's own stream, and Pi's file says so.
    expect(JSON.stringify(sub.events())).toContain("BRIDGE-REPLY-7c41");
    expect(JSON.stringify(sub.events())).not.toContain(FAUX_REPLY);
    expect(recordedAssistant()).toEqual([
      { provider: "pap-test-bridge", model: "bridge-one", text: "BRIDGE-REPLY-7c41" },
    ]);
    // Taken, so the session says nothing about it.
    expect(noticesOf(sub.events())).toEqual([]);
  });

  it("says in the session when its worker refuses the saved model, naming it and what runs instead", async () => {
    bed = await createIntBed(
      { steps: [{ text: FAUX_REPLY }] },
      { extensions: { "pap-test-bridge": BRIDGE_LIKE } },
    );
    world({ provider: "pap-test-bridge", modelId: "bridge-two" });
    const { sessionId } = await bed.sessions.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "thread",
    });
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");
    expect(recordedAssistant()).toEqual([{ provider: "faux", model: "scripted", text: FAUX_REPLY }]);
    const refused = {
      level: "warning",
      code: "agent_model_refused",
      params: { model: "pap-test-bridge/bridge-two", running: "faux/scripted" },
    };
    expect(noticesOf(sub.events())).toEqual([expect.objectContaining(refused)]);
    expect(JSON.stringify(noticesOf(sub.events()))).toContain("Settings › Models");
    // A tab that opens the thread later still sees it: the notice is in the snapshot.
    const late = await bed.subscribe(sessionId);
    expect(late.events()[0]?.kind).toBe("snapshot");
    expect(noticesOf(late.events().slice(0, 1))).toEqual([expect.objectContaining(refused)]);
  });

  /** A thread of Atlas on `model`, one turn, then what Pi recorded and the session's notices. */
  async function turn(
    model: { provider: string; modelId: string },
    options: { settings?: object; preset?: string } = {},
  ) {
    bed = await createIntBed(
      { steps: [{ text: FAUX_REPLY }] },
      {
        extensions: { "pap-test-bridge": BRIDGE_LIKE },
        ...(options.settings ? { settings: options.settings } : {}),
      },
    );
    world(model, options.preset ? { preset: options.preset } : {});
    const { sessionId } = await bed.sessions.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "thread",
    });
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");
    return { recorded: recordedAssistant(), notices: noticesOf(sub.events()) };
  }
  const BRIDGE = { provider: "pap-test-bridge", modelId: "bridge-one" };

  it("m1.selection-names-it: My selection naming the bridge's model is what the worker accepts, silently", async () => {
    const { recorded, notices } = await turn(BRIDGE, {
      settings: { enabledModels: ["faux/*", "pap-test-bridge/bridge-one"] },
    });
    expect(recorded).toEqual([
      { provider: "pap-test-bridge", model: "bridge-one", text: "BRIDGE-REPLY-7c41" },
    ]);
    expect(notices).toEqual([]);
  });

  it("m1.selection-without-it: a selection that leaves the bridge out is refused, and the session says so", async () => {
    const { recorded, notices } = await turn(BRIDGE, { settings: { enabledModels: ["faux/*"] } });
    expect(recorded).toEqual([{ provider: "faux", model: "scripted", text: FAUX_REPLY }]);
    expect(notices).toEqual([
      expect.objectContaining({
        code: "agent_model_refused",
        params: { model: "pap-test-bridge/bridge-one", running: "faux/scripted" },
      }),
    ]);
  });

  it("i2.chat-only: an agent in Chat only loads no extension, and its notice says that, not the selection", async () => {
    const { recorded, notices } = await turn(BRIDGE, { preset: "chat" });
    expect(recorded).toEqual([{ provider: "faux", model: "scripted", text: FAUX_REPLY }]);
    expect(notices).toEqual([
      expect.objectContaining({
        code: "agent_model_refused_chat",
        params: { model: "pap-test-bridge/bridge-one" },
      }),
    ]);
    expect(JSON.stringify(notices)).toContain("Chat only, which loads no extension");
  });

  it("n1.chat-only-pi-model: in Chat only a model of Pi's own provider is refused for what it is, with the Settings advice", async () => {
    const { recorded, notices } = await turn({ provider: "faux", modelId: "nope" }, { preset: "chat" });
    expect(recorded).toEqual([{ provider: "faux", model: "scripted", text: FAUX_REPLY }]);
    expect(notices).toEqual([
      expect.objectContaining({
        code: "agent_model_refused",
        params: { model: "faux/nope", running: "faux/scripted" },
      }),
    ]);
    expect(JSON.stringify(notices)).not.toContain("Chat only");
  });
});
