import type { LoginStreamEvent, ProviderView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import {
  applyLoginStreamEvent,
  EMPTY_FLOW,
  flowDone,
  NOTES_MAX,
  providerSwitch,
  readOnlyPath,
  signInState,
  writeFailureKind,
} from "./models.vm.ts";

const model = (id: string, enabled: boolean) => ({
  provider: "p",
  id,
  name: id,
  reasoning: false,
  enabled,
});
const provider = (
  models: ReturnType<typeof model>[],
  over: Partial<ProviderView["auth"]> = {},
): ProviderView => ({
  id: "p",
  name: "P",
  origin: "builtin",
  auth: {
    oauthLabel: null,
    apiKey: true,
    configured: false,
    stored: null,
    status: "known",
    env: [],
    ...over,
  },
  models,
  modelsTruncated: false,
});

describe("provider switch", () => {
  it("is on only while every model is on", () => {
    expect(providerSwitch(provider([model("a", true), model("b", true)]).models)).toEqual({
      on: true,
      enabled: 2,
      total: 2,
    });
  });

  it("reads off with its n/m count when the selection is partial", () => {
    expect(providerSwitch(provider([model("a", true), model("b", false), model("c", false)]).models)).toEqual(
      {
        on: false,
        enabled: 1,
        total: 3,
      },
    );
  });

  it("is off with nothing to count for no model, and for none on", () => {
    expect(providerSwitch([])).toEqual({ on: false, enabled: 0, total: 0 });
    expect(providerSwitch(provider([model("a", false)]).models)).toEqual({ on: false, enabled: 0, total: 1 });
  });
});

describe("read-only scope", () => {
  it("gives the settings path of a project scope, nothing for the global one", () => {
    expect(readOnlyPath({ scope: "project", settingsPath: "/p/.pi/settings.json" })).toBe(
      "/p/.pi/settings.json",
    );
    expect(readOnlyPath({ scope: "global", settingsPath: "/a/settings.json" })).toBeNull();
  });
});

describe("sign-in state", () => {
  it("says unknown when pap could not read the files, whatever else the row says", () => {
    expect(signInState(provider([], { status: "unknown", configured: true }))).toBe("unknown");
  });
  it("says configured or not configured otherwise", () => {
    expect(signInState(provider([], { configured: true }))).toBe("configured");
    expect(signInState(provider([]))).toBe("notConfigured");
  });
});

describe("write failures", () => {
  const kind = (code: string) => writeFailureKind(new RpcError(code as never));
  it("names the refusals that have their own text", () => {
    expect(kind("conflict")).toBe("lastModel");
    expect(kind("project_scope")).toBe("projectScope");
    expect(kind("capacity")).toBe("capacity");
    expect(kind("timeout")).toBe("unknownOutcome");
    expect(kind("connection_lost")).toBe("unknownOutcome");
    expect(kind("config_invalid")).toBe("other");
    expect(writeFailureKind(new Error("x"))).toBe("other");
  });
});

describe("sign-in flow view", () => {
  const apply = (events: LoginStreamEvent[]) => events.reduce(applyLoginStreamEvent, EMPTY_FLOW);

  it("keeps the link, then the prompt that follows it", () => {
    const view = apply([
      { kind: "auth_url", url: "https://example.com/auth", instructions: "Sign in" },
      { kind: "prompt", promptId: "p1", prompt: { type: "manual_code", message: "Paste it" } },
    ]);
    expect(view.link).toEqual({ url: "https://example.com/auth", instructions: "Sign in" });
    expect(view.prompt).toEqual({ promptId: "p1", prompt: { type: "manual_code", message: "Paste it" } });
    expect(view.done).toBeNull();
  });

  it("replays a snapshot in order and ends on its done", () => {
    const view = apply([
      {
        kind: "snapshot",
        events: [
          { kind: "device_code", userCode: "AB-12", verificationUri: "https://example.com/device" },
          { kind: "done", ok: false, code: "timeout" },
        ],
      },
    ]);
    // The code is dead once the flow is over, so a replayed snapshot that ends in done shows none.
    expect(view.device).toBeNull();
    expect(view.link).toBeNull();
    expect(view.done).toEqual({ ok: false, code: "timeout" });
    expect(flowDone([{ kind: "snapshot", events: [{ kind: "done", ok: true }] }])).toBe(true);
    expect(flowDone([{ kind: "progress", message: "x" }])).toBe(false);
  });

  it("drops the open prompt when the flow ends", () => {
    const prompt: LoginStreamEvent = {
      kind: "prompt",
      promptId: "p1",
      prompt: { type: "text", message: "m" },
    };
    expect(apply([prompt, { kind: "done", ok: true }]).prompt).toBeNull();
  });

  it("keeps at most NOTES_MAX notes, the newest", () => {
    const view = apply(
      Array.from({ length: NOTES_MAX + 3 }, (_, index): LoginStreamEvent => ({
        kind: "progress",
        message: `n${index}`,
      })),
    );
    expect(view.notes).toHaveLength(NOTES_MAX);
    expect(view.notes.at(-1)).toBe(`n${NOTES_MAX + 2}`);
    expect(view.notes[0]).toBe("n3");
  });

  it("ignores an event the contract does not know", () => {
    expect(applyLoginStreamEvent(EMPTY_FLOW, { kind: "auth_url", url: "javascript:alert(1)" })).toBe(
      EMPTY_FLOW,
    );
    expect(applyLoginStreamEvent(EMPTY_FLOW, 42)).toBe(EMPTY_FLOW);
  });
});
