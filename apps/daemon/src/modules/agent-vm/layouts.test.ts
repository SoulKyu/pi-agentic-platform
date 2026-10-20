import { VmLayout } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { layoutOf } from "./layouts.ts";

const KATA = {
  root: "/agent",
  home: "/agent/home",
  knowledge: "/agent/knowledge",
  inbox: "/agent/inbox",
  pi: "/agent/.pi",
  sessions: "/agent/.pi/sessions",
  piAgentDir: "/agent/.pi/agent",
  imageAgentDir: "/opt/pap/pi-agent",
  shellOverlay: "/run/pap-shell",
};

describe("layoutOf", () => {
  it("is Kata's fixed /agent for a thread", () => {
    expect(layoutOf("kata", "/home/u/.pap", { agentId: "a-1", taskKey: null })).toEqual(KATA);
  });
  it("is the same for an isolated task: each VM has its own /agent", () => {
    expect(layoutOf("kata", "/home/u/.pap", { agentId: "a-1", taskKey: "t1" })).toEqual(KATA);
  });
  it("puts the process backend under $PAP_HOME/tmp/agent-vm/<agent id>", () => {
    const layout = layoutOf("process", "/home/u/.pap", { agentId: "a-1", taskKey: null });
    expect(layout.root).toBe("/home/u/.pap/tmp/agent-vm/a-1");
    expect(layout.sessions).toBe("/home/u/.pap/tmp/agent-vm/a-1/.pi/sessions");
    expect(layout.piAgentDir).toBe("/home/u/.pap/tmp/agent-vm/a-1/.pi/agent");
    expect(layout.imageAgentDir).toBe("/home/u/.pap/tmp/agent-vm/a-1/image-agent");
  });
  it("names an isolated task's process folder with its task key", () => {
    expect(layoutOf("process", "/home/u/.pap", { agentId: "a-1", taskKey: "t1" }).root).toBe(
      "/home/u/.pap/tmp/agent-vm/a-1-t1",
    );
  });
  it("gives every layout the contract's shape and never shares a folder between two VMs", () => {
    const a = layoutOf("process", "/p", { agentId: "a-1", taskKey: null });
    const b = layoutOf("process", "/p", { agentId: "a-1", taskKey: "t1" });
    expect(VmLayout.safeParse(a).success).toBe(true);
    expect(VmLayout.safeParse(layoutOf("kata", "/p", { agentId: "a", taskKey: null })).success).toBe(true);
    for (const key of Object.keys(a) as Array<keyof typeof a>) expect(a[key]).not.toBe(b[key]);
  });
  it("returns a fresh object each time (the caller may not change Kata's constant)", () => {
    const one = layoutOf("kata", "/p", { agentId: "a", taskKey: null });
    (one as { root: string }).root = "/x";
    expect(layoutOf("kata", "/p", { agentId: "a", taskKey: null }).root).toBe("/agent");
  });
});
