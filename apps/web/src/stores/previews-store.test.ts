import { beforeEach, describe, expect, it } from "vitest";
import { previewView, AGENT_BOX } from "../testing/previews-fixtures.ts";
import { previewKey, usePreviewsStore } from "./previews-store.ts";

const state = () => usePreviewsStore.getState();
beforeEach(() => state().reset());

describe("previews store", () => {
  it("a snapshot replaces what was held and marks the stream ready", () => {
    state().apply({ type: "service", service: previewView({ name: "old" }) });
    state().apply({
      type: "snapshot",
      services: [previewView({ name: "web" }), previewView({ name: "api", box: AGENT_BOX })],
    });
    expect([...state().services.keys()].sort()).toEqual([
      "agent:atlas-1a2b/api",
      "project:0b8f6f6e-1111-4222-8333-444455556666/web",
    ]);
    expect(state().ready).toBe(true);
  });

  it("a service event upserts by box and name", () => {
    state().apply({ type: "snapshot", services: [previewView()] });
    state().apply({
      type: "service",
      service: previewView({ id: "b".repeat(32), state: "failed", reason: "exited" }),
    });
    expect(state().services.size).toBe(1);
    expect(state().services.get(previewKey(previewView().box, "web"))?.id).toBe("b".repeat(32));
  });

  it("a removed event deletes the service", () => {
    state().apply({ type: "snapshot", services: [previewView()] });
    state().apply({ type: "removed", box: previewView().box, name: "web" });
    expect(state().services.size).toBe(0);
  });

  it("garbage is skipped, never fatal", () => {
    state().apply({ type: "snapshot", services: [previewView()] });
    state().apply({ type: "service", service: { nope: true } });
    state().apply("garbage");
    expect(state().services.size).toBe(1);
  });

  it("reset empties the services, the ready flag and the armed panes", () => {
    state().apply({ type: "snapshot", services: [previewView()] });
    state().arm("project:x/web");
    state().reset();
    expect(state().services.size).toBe(0);
    expect(state().ready).toBe(false);
    expect(state().armed.size).toBe(0);
  });

  it("an open request is held until the shell takes it, and sign-out drops it", () => {
    state().request({ box: "project:x", name: "web" });
    expect(state().requested).toEqual({ box: "project:x", name: "web" });
    state().clearRequest();
    expect(state().requested).toBeNull();
    state().request({ box: "project:x", name: "web" });
    state().reset();
    expect(state().requested).toBeNull();
  });

  it("arm and disarm record the owner's click per pane", () => {
    state().arm("project:x/web");
    expect(state().armed.has("project:x/web")).toBe(true);
    state().disarm("project:x/web");
    expect(state().armed.has("project:x/web")).toBe(false);
  });
});
