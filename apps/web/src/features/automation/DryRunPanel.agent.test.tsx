// @vitest-environment happy-dom
import { TriggerInput } from "@pap/contracts";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { button, click, field, settle, text, typeInto } from "../../testing/dom.ts";
import { current, newBed, showWithStepUp } from "./board-bed.tsx";
import { DryRunPanel } from "./DryRunPanel.tsx";
import { dryRunOf } from "./editor-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const AGENT = "atlas-1a2b";
const inputOf = (target: "thread" | "isolated") => ({
  ok: true as const,
  input: TriggerInput.parse({
    name: "n",
    source: { type: "manual" },
    execution: { agent: { agentId: AGENT, target } },
    prompt: "Look",
  }),
});

beforeEach(() => {
  const bed = newBed();
  bed.handlers["automation.dryRun"] = () => dryRunOf();
  bed.handlers["agents.sandboxStatus"] = () => ({
    usable: true,
    path: "/usr/bin/bwrap",
    reason: null,
    checkedAt: 1,
  });
  bed.handlers["trust.status"] = () => ({
    requiresTrust: false,
    decision: null,
    decisionPath: null,
    inherited: false,
    resources: {},
  });
});

describe("DryRunPanel: an agent trigger", () => {
  it("says the profile of an isolated task: sandbox state, home read-only, writes in a scratch folder", async () => {
    const page = await showWithStepUp(
      <DryRunPanel input={inputOf("isolated")} sourceType="manual" savedId={null} onInvalid={vi.fn()} />,
    );
    await click(button(page.container, "Dry-run"));
    await settle();
    const words = text(page.container);
    expect(words).toContain("isolated-task");
    expect(words).toContain("sandbox on");
    expect(words).toContain("home read-only, writes in a scratch folder");
  });

  it("offers no payload to a thread target, and one to an isolated task", async () => {
    const thread = await showWithStepUp(
      <DryRunPanel input={inputOf("thread")} sourceType="manual" savedId={null} onInvalid={vi.fn()} />,
    );
    expect(() => field(thread.container, "Sample payload")).toThrow();
    const isolated = await showWithStepUp(
      <DryRunPanel input={inputOf("isolated")} sourceType="manual" savedId={null} onInvalid={vi.fn()} />,
    );
    expect(field(isolated.container, "Sample payload")).toBeDefined();
  });

  it("says so when the sandbox state cannot be read", async () => {
    const bed = newBed();
    bed.handlers["automation.dryRun"] = () => dryRunOf();
    bed.handlers["agents.sandboxStatus"] = () => {
      throw new RpcError("internal");
    };
    const page = await showWithStepUp(
      <DryRunPanel input={inputOf("isolated")} sourceType="manual" savedId={null} onInvalid={vi.fn()} />,
    );
    await click(button(page.container, "Dry-run"));
    await settle();
    expect(text(page.container)).toContain("sandbox could not be read");
  });

  it("sends no payload once the field is hidden by a thread target, nor on a schedule", async () => {
    const bed = newBed();
    bed.handlers["automation.dryRun"] = () => dryRunOf();
    const page = await showWithStepUp(<Switcher />);
    await typeInto(field(page.container, "Sample payload"), "typed under isolated");
    await click(button(page.container, "Dry-run"));
    await settle();
    expect(bed.called("automation.dryRun")[0]?.params).toMatchObject({ payload: "typed under isolated" });
    await click(button(page.container, "to thread"));
    await click(button(page.container, "Dry-run"));
    await settle();
    expect(bed.called("automation.dryRun")[1]?.params).not.toHaveProperty("payload");
    await click(button(page.container, "to schedule"));
    await click(button(page.container, "Dry-run"));
    await settle();
    expect(bed.called("automation.dryRun")[2]?.params).not.toHaveProperty("payload");
  });
});

function Switcher() {
  const [mode, setMode] = useState<"isolated" | "thread" | "schedule">("isolated");
  return (
    <>
      <button onClick={() => setMode("thread")}>to thread</button>
      <button onClick={() => setMode("schedule")}>to schedule</button>
      <DryRunPanel
        input={inputOf(mode === "thread" ? "thread" : "isolated")}
        sourceType={mode === "schedule" ? "schedule" : "manual"}
        savedId={null}
        onInvalid={vi.fn()}
      />
    </>
  );
}
