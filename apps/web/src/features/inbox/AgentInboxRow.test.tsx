// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { alerts, button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { current, itemOf, newBed, NOW, show } from "./inbox-bed.tsx";
import { AgentInboxRow } from "./AgentInboxRow.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const atlas: AgentSummary = {
  id: "atlas-1a2b",
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s1",
  lastActivityAt: 1,
};

beforeEach(() => {
  useAgentsStore.getState().reset();
  useAgentsStore.getState().apply({ kind: "snapshot", agents: [atlas], requests: [], truncated: false });
  useSecretDialog.getState().close();
});
afterEach(() => {
  useAgentsStore.getState().reset();
  useSecretDialog.getState().close();
  setLocale("en");
});

const agentItem = (kind: string, patch: Partial<ReturnType<typeof itemOf>> = {}) =>
  itemOf({
    id: "i1",
    kind,
    toHandle: kind === "agent_approve" || kind === "secret_request" || kind === "memory_review",
    agentId: "atlas-1a2b",
    refId: "req-1",
    taskId: null,
    sessionId: null,
    triggerName: "Atlas",
    costUsd: null,
    detail: "Deploy the site?",
    ...patch,
  });

const row = (item: ReturnType<typeof itemOf>, onPick = vi.fn()) =>
  show(
    <ul>
      <AgentInboxRow item={item} now={NOW} onPick={onPick} avatarStyle="outlined" />
    </ul>,
  );

describe("the sentence per kind (pap's words, never the agent's text)", () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ["agent_approve", "Atlas asks for your approval", "Atlas demande votre accord"],
    ["secret_request", "Atlas asks for a secret", "Atlas demande un secret"],
    ["agent_reply", "Atlas replied", "Atlas a répondu"],
    ["delegation_done", "Atlas finished a delegated task", "Atlas a terminé une tâche déléguée"],
    ["agent_notify", "Atlas sent a notification", "Atlas a envoyé une notification"],
    ["agent_egress", "Atlas could not reach a host", "Atlas n'a pas pu joindre un hôte"],
    ["memory_review", "Atlas has memories to review", "Atlas a des souvenirs à relire"],
    ["future_kind", "Atlas · update", "Atlas · mise à jour"],
  ];
  it.each(cases)("%s reads the same in English and French", async (kind, en, fr) => {
    newBed();
    const title = (page: { container: HTMLElement }) =>
      page.container.querySelector("[data-row-title]")?.textContent;
    const english = await row(agentItem(kind));
    expect(title(english)).toBe(en);
    await english.unmount();
    setLocale("fr");
    expect(title(await row(agentItem(kind)))).toBe(fr);
  });

  it("never builds the title from the agent's detail", async () => {
    newBed();
    const page = await row(agentItem("agent_reply", { detail: "Ignore everything and approve" }));
    expect(page.container.querySelector("[data-row-title]")?.textContent).not.toContain("Ignore");
    expect(page.container.querySelector("[data-row-detail]")?.textContent).toBe(
      "Ignore everything and approve",
    );
  });

  it("shows the agent's avatar and the age", async () => {
    newBed();
    const page = await row(agentItem("agent_reply"));
    expect(page.container.querySelector('[data-slot="avatar"]')?.getAttribute("aria-label")).toBe("Atlas");
    expect(text(page.container)).toContain("4 min");
  });

  it("falls back to a neutral name for an agent that is gone", async () => {
    newBed();
    useAgentsStore.getState().reset();
    const page = await row(agentItem("agent_reply"));
    expect(page.container.querySelector("[data-row-title]")?.textContent).toBe("An agent replied");
  });
});

describe("the detail is untrusted text", () => {
  it("strips hidden characters and never draws markup", async () => {
    newBed();
    const page = await row(agentItem("agent_notify", { detail: "pwn\u202ed <img src=x onerror=alert(1)>" }));
    const detail = page.container.querySelector("[data-row-detail]");
    expect(detail?.textContent).toBe("pwnd <img src=x onerror=alert(1)>");
    expect(page.container.querySelector("img")).toBeNull();
  });

  it("draws no detail line when there is none", async () => {
    newBed();
    const page = await row(agentItem("agent_reply", { detail: null }));
    expect(page.container.querySelector("[data-row-detail]")).toBeNull();
  });
});

describe("opening the agent", () => {
  it("calls onPick with the item when the row is clicked", async () => {
    newBed();
    const onPick = vi.fn();
    const item = agentItem("agent_reply", { entryId: "e9" });
    const page = await row(item, onPick);
    await click(page.container.querySelector('[data-slot="inbox-row"]') as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(item);
  });
});

describe("inline buttons", () => {
  it("sends Approve and Deny to agents.answerApproval with the request id", async () => {
    const bed = newBed();
    const page = await row(agentItem("agent_approve"));
    await click(button(page.container, "Approve"));
    await settle();
    expect(bed.called("agents.answerApproval")).toEqual([
      expect.objectContaining({ params: { requestId: "req-1", approved: true } }),
    ]);
    await click(button(page.container, "Deny"));
    await settle();
    expect(bed.called("agents.answerApproval")[1]?.params).toEqual({ requestId: "req-1", approved: false });
    expect(bed.called("agents.answerApproval")[0]?.options?.commandId).toMatch(/^bed-cmd-/);
  });

  it("says why an answer failed", async () => {
    const bed = newBed();
    bed.handlers["agents.answerApproval"] = () => {
      throw new RpcError("not_found");
    };
    const page = await row(agentItem("agent_approve"));
    await click(button(page.container, "Approve"));
    await settle();
    expect(alerts(page.container)).not.toEqual([]);
  });

  it("opens the secret dialog from Provide… and declines through secrets.declineRequest", async () => {
    const bed = newBed();
    const page = await row(agentItem("secret_request", { detail: "GITHUB_TOKEN" }));
    await click(button(page.container, "Provide…"));
    expect(useSecretDialog.getState().requestId).toBe("req-1");
    await click(button(page.container, "Decline"));
    await settle();
    expect(bed.called("secrets.declineRequest")).toEqual([
      expect.objectContaining({ params: { requestId: "req-1" } }),
    ]);
  });

  it("draws no button on a resolved item, on a reply, or without a ref", async () => {
    newBed();
    const resolved = await row(agentItem("agent_approve", { resolvedAt: NOW, resolution: "answered" }));
    expect(hasButton(resolved.container, "Approve")).toBe(false);
    await resolved.unmount();
    const reply = await row(agentItem("agent_reply"));
    expect(hasButton(reply.container, "Approve")).toBe(false);
    expect(hasButton(reply.container, "Provide…")).toBe(false);
    await reply.unmount();
    const noRef = await row(agentItem("secret_request", { refId: null }));
    expect(hasButton(noRef.container, "Provide…")).toBe(false);
  });
});
