// @vitest-environment happy-dom
import { AgentInput, type AgentView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSettingsEn, agentSettingsFr } from "../../i18n/catalog/agent-settings.ts";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError } from "../../runtime/rpc.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { alerts, button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { AgentForm } from "./AgentForm.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const current: { runtime: Runtime | undefined } = { runtime: undefined };
function newBed() {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  return bed;
}
const inShell = (children: ReactNode) => <TooltipProvider>{children}</TooltipProvider>;

const view = (patch: Partial<Parameters<typeof AgentInput.parse>[0]> = {}, revision = 3): AgentView => ({
  id: "atlas-1a2b",
  name: "atlas",
  input: AgentInput.parse({ name: "atlas", ...patch }),
  state: "active",
  threadSessionId: null,
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision,
  createdAt: 1,
  updatedAt: 2,
});

const calls = {
  stepUp: vi.fn(),
  saved: vi.fn(),
  cancelled: vi.fn(),
};
beforeEach(() => {
  calls.stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-1"));
  calls.saved = vi.fn();
  calls.cancelled = vi.fn();
  setLocale("en");
});

async function open(agent: AgentView | null = null) {
  const bed = newBed();
  bed.handlers["agents.create"] = (params) =>
    view({ name: (params as { input: { name: string } }).input.name }, 1);
  bed.handlers["agents.update"] = () => view({}, 4);
  const page = await mount(
    inShell(
      <StepUpContext.Provider value={calls.stepUp as unknown as StepUpRunner}>
        <AgentForm
          agent={agent}
          presetField={(value) => <span data-testid="preset">preset:{value}</span>}
          onSaved={calls.saved}
          onCancel={calls.cancelled}
        />
      </StepUpContext.Provider>,
    ),
  );
  await settle();
  return { bed, page };
}
const body = () => text(document.body);
const say = (label: string, value: string) => typeInto(field(document.body, label), value);

describe("agent form: the daily budget (owner m14)", () => {
  it("is empty by default, with No budget placeholders and a Clear for each half", async () => {
    await open();
    for (const label of ["USD per day", "Tokens per day"]) {
      const input = field(document.body, label);
      expect(input.value).toBe("");
      expect(input.placeholder).toBe("No budget");
    }
    expect(body()).toContain(
      "Its automatic runs stop for the day once either is reached. Your automation budget still applies.",
    );
    await say("USD per day", "2.5");
    expect(button(document.body, "Clear USD per day").disabled).toBe(false);
    await click(button(document.body, "Clear USD per day"));
    expect(field(document.body, "USD per day").value).toBe("");
    expect(button(document.body, "Clear Tokens per day").disabled).toBe(true);
  });

  it("shows the schema's error for a budget out of range and sends nothing", async () => {
    const { bed } = await open();
    await say("Name", "atlas");
    await say("USD per day", "1001");
    await click(button(document.body, "Create agent"));
    await settle();
    expect(alerts(document.body)).toContain("Fix the marked fields first.");
    expect(body()).toContain("A number between 0 and 1000.");
    expect(bed.called("agents.create")).toEqual([]);
  });
});

describe("agent form: saving and the password", () => {
  it("creates at the defaults without any password step, under one command id", async () => {
    const { bed } = await open();
    await say("Name", "atlas");
    expect(body()).not.toContain("Saving asks for your password");
    await click(button(document.body, "Create agent"));
    await settle();
    const call = bed.called("agents.create")[0];
    expect(call?.params).toEqual({ input: AgentInput.parse({ name: "atlas" }) });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(calls.stepUp).not.toHaveBeenCalled();
    expect(calls.saved).toHaveBeenCalledWith(expect.objectContaining({ name: "atlas" }));
  });

  it('has no sandbox switch, and its hosts hint does not say "VM mode:"', async () => {
    await open(view({ allowHosts: ["api.example.com"] }));
    expect(document.querySelector('[data-slot="agent-sandbox"]')).toBeNull();
    expect(body()).not.toContain("VM mode:");
  });

  it("says the password is asked up front when the profile widens, and saves through the step-up", async () => {
    const { bed } = await open(view());
    await click(document.querySelector('[data-slot="agent-network"] [role="switch"]') as Element);
    expect(body()).toContain("Saving asks for your password: this lets atlas do more.");
    await click(button(document.body, "Save"));
    await settle();
    expect(calls.stepUp).toHaveBeenCalledTimes(1);
    const call = bed.called("agents.update")[0];
    expect(call?.params).toEqual({
      agentId: "atlas-1a2b",
      baseRevision: 3,
      input: AgentInput.parse({ name: "atlas", sandbox: { required: true, network: true } }),
    });
    expect(call?.options?.commandId).toBe("step-cmd-1");
  });

  it("a budget change alone says nothing about the password and does not use the step-up", async () => {
    const { bed } = await open(view());
    await say("USD per day", "4");
    await say("Tokens per day", "100000");
    expect(body()).not.toContain("Saving asks for your password");
    await click(button(document.body, "Save"));
    await settle();
    expect(calls.stepUp).not.toHaveBeenCalled();
    expect(bed.called("agents.update")[0]?.params).toEqual({
      agentId: "atlas-1a2b",
      baseRevision: 3,
      input: AgentInput.parse({ name: "atlas", budget: { usdPerDay: 4, tokensPerDay: 100000 } }),
    });
  });

  it("emptying a saved budget sends null for it", async () => {
    const { bed } = await open(view({ budget: { usdPerDay: 4, tokensPerDay: null } }));
    expect(field(document.body, "USD per day").value).toBe("4");
    await click(button(document.body, "Clear USD per day"));
    await click(button(document.body, "Save"));
    await settle();
    expect((bed.called("agents.update")[0]?.params as { input: AgentInput }).input.budget).toEqual({
      usdPerDay: null,
      tokensPerDay: null,
    });
  });

  it("a cancelled password prompt saves nothing and says nothing is wrong", async () => {
    calls.stepUp = vi.fn(async () => null);
    const { bed } = await open(view({ sandbox: { required: true, network: false } }));
    await click(document.querySelector('[data-slot="agent-network"] [role="switch"]') as Element);
    await click(button(document.body, "Save"));
    await settle();
    expect(bed.called("agents.update")).toEqual([]);
    expect(calls.saved).not.toHaveBeenCalled();
    expect(alerts(document.body)).toEqual([]);
  });

  it("puts a refused save into words and keeps the form", async () => {
    const { bed } = await open();
    bed.handlers["agents.create"] = () => {
      throw new RpcError("conflict");
    };
    await say("Name", "atlas");
    await click(button(document.body, "Create agent"));
    await settle();
    expect(alerts(document.body)).toEqual([
      "Another agent has this name, or this one changed since you opened it.",
    ]);
    expect(calls.saved).not.toHaveBeenCalled();
    expect((field(document.body, "Name") as HTMLInputElement).value).toBe("atlas");
  });
});

describe("agent form: a pick the profile no longer holds (AVM-E42 M5)", () => {
  // Mutant: `not_found` is not in SAVE_ERRORS -> the generic text shows and this fails.
  it("says why the save is refused", async () => {
    const { bed } = await open();
    bed.handlers["agents.create"] = () => {
      throw new RpcError("not_found");
    };
    await say("Name", "atlas");
    await click(button(document.body, "Create agent"));
    await settle();
    expect(alerts(document.body)).toEqual([
      "A package you picked is no longer in your Pi profile, or the agent was deleted. Untick the package and save again.",
    ]);
  });
});

describe("agent form: the fields", () => {
  it("offers the preset through the picker it is given, the folded role help", async () => {
    await open();
    expect(document.querySelector('[data-testid="preset"]')?.textContent).toBe("preset:default");
    expect(hasButton(document.body, "What the role is for")).toBe(true);
    await click(button(document.body, "What the role is for"));
    expect(body()).toContain("What the agent is for; added to its system prompt.");
  });

  it("has no folder field", async () => {
    await open();
    expect([...document.querySelectorAll("label")].map((label) => label.textContent)).not.toContain(
      "Folders",
    );
  });

  it("cancels through the callback", async () => {
    await open();
    await click(button(document.body, "Cancel"));
    expect(calls.cancelled).toHaveBeenCalledTimes(1);
  });
});

describe("agent form: en and fr", () => {
  it("has every key in both languages, with the same slots", () => {
    expect(Object.keys(agentSettingsFr)).toEqual(Object.keys(agentSettingsEn));
    const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(agentSettingsEn) as Array<keyof typeof agentSettingsEn>) {
      expect(agentSettingsFr[key], key).not.toBe("");
      expect(slots(agentSettingsFr[key]), key).toEqual(slots(agentSettingsEn[key]));
    }
  });

  it("renders in French", async () => {
    setLocale("fr");
    await open();
    expect(body()).toContain("Budget quotidien");
    expect(field(document.body, "USD par jour").placeholder).toBe("Pas de budget");
  });
});
