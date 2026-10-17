// @vitest-environment happy-dom
import { AgentInput, type SandboxStatus } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentForm } from "./AgentForm.tsx";
import { AutonomyFields } from "./AutonomyFields.tsx";
import { draftFromInput, type Draft } from "./agent-form.vm.ts";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
const current: { runtime: Runtime | undefined } = { runtime: undefined };

const noEgress: SandboxStatus = {
  usable: true,
  path: "/usr/bin/bwrap",
  reason: null,
  checkedAt: 5,
  egress: { usable: false, python: null, reason: "no_python" },
};
const withEgress: SandboxStatus = {
  ...noEgress,
  egress: { usable: true, python: "/usr/bin/python3", reason: null },
};

beforeEach(() => setLocale("en"));

async function fields(patch: Partial<Draft> = {}, name = "atlas") {
  const set = vi.fn();
  const page = await mount(
    <TooltipProvider>
      <AutonomyFields draft={{ ...draftFromInput(null), ...patch }} errors={{}} name={name} set={set} />
    </TooltipProvider>,
  );
  return { page, set };
}

async function form(
  probe: SandboxStatus,
  patch: Parameters<typeof AgentInput.parse>[0] = { name: "atlas" },
  ownerHosts: string[] | null | "fails" = null,
) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["policy.getSettings"] = () => {
    if (ownerHosts === "fails") throw new Error("offline");
    return { value: { allowHosts: ownerHosts }, revision: 1 };
  };
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
        <AgentForm
          agent={{
            id: "atlas-1a2b",
            name: "atlas",
            input: AgentInput.parse(patch),
            state: "active",
            threadSessionId: null,
            unread: 0,
            paused: false,
            quarantinedAt: null,
            revision: 1,
            createdAt: 1,
            updatedAt: 2,
          }}
          probe={probe}
          presetField={() => null}
          onSaved={() => {}}
        />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  return text(document.body);
}

describe("AutonomyFields", () => {
  it("says the trusted-sources hint and the autonomy switch in English, naming the agent", async () => {
    const { page } = await fields();
    const body = text(page.container);
    expect(body).toContain("Autonomy");
    expect(body).toContain(
      "Hosts you control (your docs, your API). Commands that reach only these hosts, over https, do not count as reading external content. Never a site where others can write, nor a host behind a CDN that others can use.",
    );
    expect(body).toContain(
      "After external content, atlas no longer gets the extra questions for its shell's network (which reaches only its hosts, trusted sources and granted hosts) nor for agent_remind and agent_delegate. Its mode still asks what it asks in a clean thread. MCP tools, unknown tools and writes outside its folder still ask. Risk: a booby-trapped page can make it send the contents of its folder or vault to a host it can reach.",
    );
    expect(page.container.querySelector("[title]")).toBeNull();
    await page.unmount();
  });

  it("says it in French", async () => {
    setLocale("fr");
    const { page } = await fields({}, "atlas");
    const body = text(page.container);
    expect(body).toContain("Des hôtes que vous contrôlez (votre doc, votre API).");
    expect(body).toContain(
      "Après du contenu externe, atlas n'a plus les questions en plus pour le réseau de son shell",
    );
    expect(body).toContain("vers un hôte qu'il peut joindre.");
    await page.unmount();
  });

  it("is off by default and turns on through set", async () => {
    const { page, set } = await fields();
    const toggle = page.container.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await click(toggle as HTMLElement);
    expect(set).toHaveBeenCalledWith({ trustedAutonomy: true });
    await page.unmount();
  });

  it("says only remind and delegate are covered when the agent has no host list of its own", async () => {
    const own = await fields({ ownHosts: true });
    expect(text(own.page.container)).toContain(
      "atlas has no host list of its own: only agent_remind and agent_delegate are covered.",
    );
    await own.page.unmount();
    const listed = await fields({ ownHosts: false });
    expect(text(listed.page.container)).not.toContain("has no host list of its own");
    await listed.page.unmount();
    setLocale("fr");
    const fr = await fields({ ownHosts: true });
    expect(text(fr.page.container)).toContain(
      "atlas n'a pas de liste d'hôtes à lui : seuls agent_remind et agent_delegate sont couverts.",
    );
    await fr.page.unmount();
  });

  it("types sources through set", async () => {
    const { page, set } = await fields();
    const box = field(page.container, "Trusted sources");
    expect(box.tagName).toBe("TEXTAREA");
    await typeInto(box, "docs.example.com");
    expect(set).toHaveBeenLastCalledWith({ trustedSources: "docs.example.com" });
    await page.unmount();
  });
});

describe("the agent form around the autonomy group", () => {
  it("warns on the host list that a listed host can receive files and secrets", async () => {
    const body = await form(withEgress, { name: "atlas", allowHosts: ["api.example.com"] });
    expect(body).toContain(
      "A listed host can receive whatever this agent sends it, its files and secrets included. List only hosts you trust with them.",
    );
  });

  it("says the proxy needs python3 when the egress status is not usable", async () => {
    const body = await form(noEgress, { name: "atlas", sandbox: { required: true, network: true } });
    expect(body).toContain("Network goes through pap's egress proxy, which needs python3 on this server (");
  });

  it("asks for the password when its own list reaches beyond the owner's, not when the owner's covers it", async () => {
    await form(withEgress, { name: "atlas", allowHosts: null }, ["docs.example.com"]);
    await click(button(document.body, "Only these"));
    await typeInto(field(document.body, "Hosts, one per line"), "docs.example.com");
    expect(text(document.body)).not.toContain("Saving asks for your password");
    await typeInto(field(document.body, "Hosts, one per line"), "other.example.com");
    expect(text(document.body)).toContain("Saving asks for your password");
  });

  it("takes the cautious reading when the owner's list cannot be read", async () => {
    await form(withEgress, { name: "atlas", allowHosts: null }, "fails");
    await click(button(document.body, "Only these"));
    await typeInto(field(document.body, "Hosts, one per line"), "docs.example.com");
    expect(text(document.body)).toContain("Saving asks for your password");
  });

  it("says nothing about python3 while the network is off, and shows it when the switch goes on", async () => {
    const off = await form(noEgress, { name: "atlas", sandbox: { required: true, network: false } });
    expect(off).not.toContain("python3 on this server");
    await click(document.querySelector('[data-slot="agent-sandbox"] [role="switch"]') as Element);
    expect(text(document.body)).toContain("python3 on this server");
  });

  it("says nothing about python3 when the proxy is usable", async () => {
    expect(await form(withEgress)).not.toContain("python3 on this server");
  });
});
