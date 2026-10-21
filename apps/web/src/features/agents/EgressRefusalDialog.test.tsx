// @vitest-environment happy-dom
import {
  AGENT_LIMITS,
  AgentInput,
  type AgentView,
  DEFAULT_POLICY_SETTINGS,
  type EgressRefusedCardData,
} from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { EgressRefusalDialog } from "./EgressRefusalDialog.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
const toasts = vi.hoisted(() => vi.fn());
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: toasts,
}));

const OWNER_HOSTS = ["api.example.com", "*.docs.example.com"];
const DATA: EgressRefusedCardData = {
  host: "prometheus.lan",
  port: 9090,
  reason: "not_listed",
  address: null,
  source: "thread",
  count: 12,
  firstAt: Date.UTC(2026, 9, 21, 8, 0),
  lastAt: Date.UTC(2026, 9, 21, 8, 30),
};

const view = (allowHosts: string[] | null): AgentView => ({
  id: "kubedoc-1a2b",
  name: "KubeDoc",
  input: AgentInput.parse({ name: "KubeDoc", allowHosts }),
  state: "active",
  threadSessionId: null,
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 4,
  createdAt: 1,
  updatedAt: 1,
});

let bed: ReturnType<typeof fakeRuntime>;
let stepUp: ReturnType<typeof vi.fn>;
const onClose = vi.fn();

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["policy.getSettings"] = () => ({
    value: { ...DEFAULT_POLICY_SETTINGS, allowHosts: OWNER_HOSTS },
  });
  bed.handlers["agents.update"] = () => view(["api.example.com"]);
  stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-0001"));
  onClose.mockReset();
  toasts.mockReset();
});
afterEach(() => setLocale("en"));

const show = async (allowHosts: string[] | null, data: Partial<EgressRefusedCardData> = {}) => {
  bed.handlers["agents.get"] = () => view(allowHosts);
  await mount(
    <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
      <EgressRefusalDialog
        agent={{ id: "kubedoc-1a2b", name: "KubeDoc" }}
        data={{ ...DATA, ...data }}
        onClose={onClose}
      />
    </StepUpContext.Provider>,
  );
  await settle();
};
const footerClose = (): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === "Close",
  );
  if (found.length !== 1) throw new Error(`expected one visible Close, found ${found.length}`);
  return found[0] as HTMLButtonElement;
};
const body = () => document.body.textContent ?? "";

describe("the refused host dialog (spec §6)", () => {
  it("shows the host and port, the attempts, the VM and the scope", async () => {
    await show(["api.example.com"]);
    expect(body()).toContain("prometheus.lan:9090");
    expect(body()).toContain("12");
    expect(body()).toContain("thread");
    expect(body()).toContain("For this agent only, from its next request");
  });

  it("names the task for a task VM", async () => {
    await show(["api.example.com"], { source: "nightly" });
    expect(body()).toContain("nightly");
  });

  it("with a private address, shows it and that the name comes from the agent", async () => {
    await show(["api.example.com"], { reason: "private_wildcard", address: "192.168.1.40" });
    expect(body()).toContain("192.168.1.40");
    expect(body()).toContain("this name comes from the agent; add it only if you know it");
  });

  it("shows no such line for a public refusal", async () => {
    await show(["api.example.com"]);
    expect(body()).not.toContain("comes from the agent");
  });

  it("an agent on the owner's list gets its own copy plus the host, through the step-up, and the dialog says so", async () => {
    await show(null);
    expect(body()).toContain("uses your list");
    await click(button(document.body, "Add to list"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.update")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          agentId: "kubedoc-1a2b",
          baseRevision: 4,
          input: expect.objectContaining({ allowHosts: [...OWNER_HOSTS, "prometheus.lan:9090"] }),
        }),
        options: expect.objectContaining({ commandId: "step-cmd-0001" }),
      }),
    ]);
    expect(alerts(document.body)).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveBeenCalled();
  });

  it("an agent with its own list gets the entry appended: the bare host for 443", async () => {
    await show(["api.example.com"], { host: "grafana.lan", port: 443 });
    expect(body()).not.toContain("uses your list");
    await click(button(document.body, "Add to list"));
    await settle();
    expect(bed.called("agents.update")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          input: expect.objectContaining({ allowHosts: ["api.example.com", "grafana.lan"] }),
        }),
      }),
    ]);
  });

  it("an IPv6 host with a port is bracketed", async () => {
    await show(["api.example.com"], { host: "fd00::1", port: 6443, reason: "not_listed" });
    await click(button(document.body, "Add to list"));
    await settle();
    expect(bed.called("agents.update")[0]).toMatchObject({
      params: { input: { allowHosts: ["api.example.com", "[fd00::1]:6443"] } },
    });
  });

  it("CLOSE writes nothing", async () => {
    await show(null);
    await click(footerClose());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.update")).toEqual([]);
    expect(stepUp).not.toHaveBeenCalled();
  });

  it("a cancelled password prompt writes nothing and stays open without an error", async () => {
    stepUp.mockResolvedValue(null);
    await show(["api.example.com"]);
    await click(button(document.body, "Add to list"));
    await settle();
    expect(bed.called("agents.update")).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(alerts(document.body)).toEqual([]);
  });

  it("a conflict says the agent changed and nothing was added", async () => {
    bed.handlers["agents.update"] = () => {
      throw new RpcError("conflict");
    };
    await show(["api.example.com"]);
    await click(button(document.body, "Add to list"));
    await settle();
    expect(alerts(document.body).join(" ")).toContain("changed");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not offer the add until the owner's list is known when the agent uses it", async () => {
    bed.handlers["policy.getSettings"] = () => {
      throw new RpcError("internal");
    };
    await show(null);
    expect(button(document.body, "Add to list").disabled).toBe(true);
  });

  it("a private_wildcard add of an exact name under the agent's wildcard asks the step-up (AVM2-E12)", async () => {
    await show(["*.home.lan"], {
      host: "nas.home.lan",
      port: 443,
      reason: "private_wildcard",
      address: "192.168.1.9",
    });
    await click(button(document.body, "Add to list"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.update")[0]).toMatchObject({
      params: { input: { allowHosts: ["*.home.lan", "nas.home.lan"] } },
    });
  });

  it("an owner's list that would pass the agent's cap says so before anything is copied (M2)", async () => {
    const owner = Array.from({ length: AGENT_LIMITS.hosts }, (_, i) => `h${i}.example.com`);
    bed.handlers["policy.getSettings"] = () => ({ value: { ...DEFAULT_POLICY_SETTINGS, allowHosts: owner } });
    await show(null);
    expect(alerts(document.body).join(" ")).toContain(`${AGENT_LIMITS.hosts}`);
    expect(alerts(document.body).join(" ")).toContain("Nothing was added");
    expect(button(document.body, "Add to list").disabled).toBe(true);
    expect(bed.called("agents.update")).toEqual([]);
  });

  it("an agent already at the cap says so too", async () => {
    const own = Array.from({ length: AGENT_LIMITS.hosts }, (_, i) => `h${i}.example.com`);
    await show(own);
    expect(alerts(document.body).join(" ")).toContain("Nothing was added");
    expect(button(document.body, "Add to list").disabled).toBe(true);
  });

  it("shows the date when the last attempt is not from today (M5)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 21, 12, 0)));
      await show(["api.example.com"], { lastAt: Date.UTC(2026, 9, 20, 8, 30) });
      expect(body()).toMatch(/Oct/);
      expect(body()).toMatch(/20/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only the time when the last attempt is from today (M5)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 21, 12, 0)));
      await show(["api.example.com"], { lastAt: Date.UTC(2026, 9, 21, 8, 30) });
      expect(body()).not.toMatch(/Oct/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks French", async () => {
    setLocale("fr");
    await show(["api.example.com"]);
    expect(hasButton(document.body, "Ajouter à la liste")).toBe(true);
    expect(hasButton(document.body, "Fermer")).toBe(true);
  });
});
