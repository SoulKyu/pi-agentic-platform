import { EGRESS_UNKNOWN } from "@pap/contracts";
// @vitest-environment happy-dom
import { AgentInput, type AgentView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { type Runtime, RpcError } from "../../runtime/index.ts";
import {
  alerts,
  button,
  click,
  field,
  hasButton,
  mount,
  settle,
  typeInto,
  unmountAll,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentForm } from "./AgentForm.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const current: { runtime: Runtime | undefined } = { runtime: undefined };
const probe = {
  usable: true,
  path: "/usr/bin/bwrap",
  reason: null,
  checkedAt: 5,
  egress: EGRESS_UNKNOWN,
} as const;
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
async function open(agent: AgentView | null, onReload?: () => Promise<AgentView | null>) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["agents.update"] = () => {
    throw new RpcError("conflict");
  };
  bed.handlers["agents.create"] = () => {
    throw new RpcError("conflict");
  };
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
        <AgentForm
          agent={agent}
          probe={probe}
          presetField={() => null}
          onSaved={vi.fn()}
          {...(onReload ? { onReload } : {})}
        />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  return bed;
}
const save = async (label: string) => {
  await click(button(document.body, label));
  await settle();
};
beforeEach(() => setLocale("en"));

describe("agent form: a conflict on save (carry 2)", () => {
  it("offers to reload the agent, and tells a changed agent from a taken name by the revision", async () => {
    const onReload = vi.fn(async () => view({}, 3));
    await open(view(), onReload);
    await typeInto(field(document.body, "Role"), "new role");
    await save("Save");
    expect(alerts(document.body)).toEqual([
      "Another agent has this name, or this one changed since you opened it.",
    ]);
    await click(button(document.body, "Reload the agent"));
    await settle();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(alerts(document.body)).toEqual(["Another agent has this name. Pick another name."]);
    expect((field(document.body, "Role") as HTMLTextAreaElement).value).toBe("new role");
  });

  it("says when the agent could not be reloaded", async () => {
    await open(
      view(),
      vi.fn(async () => null),
    );
    await save("Save");
    await click(button(document.body, "Reload the agent"));
    await settle();
    expect(alerts(document.body)).toEqual(["The agent could not be reloaded."]);
  });

  it("has no reload for a new agent, nor without a host that can reload", async () => {
    await open(
      null,
      vi.fn(async () => null),
    );
    await typeInto(field(document.body, "Name"), "atlas");
    await save("Create agent");
    expect(hasButton(document.body, "Reload the agent")).toBe(false);
    await unmountAll();
    await open(view());
    await save("Save");
    expect(hasButton(document.body, "Reload the agent")).toBe(false);
  });

  it("offers no reload for another refusal", async () => {
    const bed = await open(
      view(),
      vi.fn(async () => null),
    );
    bed.handlers["agents.update"] = () => {
      throw new RpcError("bad_request");
    };
    await save("Save");
    expect(hasButton(document.body, "Reload the agent")).toBe(false);
  });
});
