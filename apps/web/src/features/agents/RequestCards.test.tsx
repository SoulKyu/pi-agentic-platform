// @vitest-environment happy-dom
import type { AgentRequestView } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { RequestCards } from "./RequestCards.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const NOW = Date.UTC(2026, 9, 15, 12, 0);
const approve: AgentRequestView = {
  id: "r1",
  agentId: "atlas-1a2b",
  kind: "approve",
  title: "Deploy the site?",
  detail: "Ships v2\u202e now",
  createdAt: NOW - 5 * 60_000,
  expiresAt: NOW + 20 * 60_000,
};
const secret: AgentRequestView = {
  id: "r2",
  agentId: "atlas-1a2b",
  kind: "secret",
  title: "GITHUB_TOKEN",
  detail: "to push the branch <b>now</b>",
  createdAt: NOW,
  expiresAt: NOW + 10 * 60_000,
};
let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  vi.useRealTimers();
});
const show = (
  requests: readonly AgentRequestView[],
  extra: { tainted?: boolean; onProvide?: () => void; now?: number } = {},
) =>
  mount(
    <RequestCards
      agentName="Atlas"
      requests={requests}
      tainted={extra.tainted ?? false}
      now={extra.now ?? NOW}
      {...(extra.onProvide ? { onProvide: extra.onProvide } : {})}
    />,
  );

describe("approval request cards (M11R102, M11R120)", () => {
  it("says who asks, shows the summary as stripped untrusted text and the time left", async () => {
    const page = await show([approve]);
    const words = text(page.container);
    expect(words).toContain("Atlas asks: Deploy the site?");
    expect(words).toContain("Ships v2 now");
    expect(words).not.toContain("\u202e");
    expect(words).toContain("Untrusted");
    expect(words).toContain("20 min");
  });

  it("does not overclaim what Approve does", async () => {
    const page = await show([approve]);
    expect(text(page.container)).toContain("Atlas asks before it acts; approving tells it yes.");
  });

  it("sends Approve and Deny to agents.answerApproval", async () => {
    const page = await show([approve]);
    await click(button(page.container, "Approve"));
    await settle();
    expect(bed.called("agents.answerApproval")).toEqual([
      expect.objectContaining({ params: { requestId: "r1", approved: true } }),
    ]);
    await click(button(page.container, "Deny"));
    await settle();
    expect(bed.called("agents.answerApproval")[1]?.params).toEqual({ requestId: "r1", approved: false });
  });

  it("says why an answer failed", async () => {
    bed.handlers["agents.answerApproval"] = () => {
      throw new RpcError("not_found");
    };
    const page = await show([approve]);
    await click(button(page.container, "Approve"));
    await settle();
    expect(alerts(page.container)).not.toEqual([]);
  });

  it("shows the dashed external content chip when the thread is tainted", async () => {
    const clean = await show([approve]);
    expect(text(clean.container)).not.toContain("external content");
    const tainted = await show([approve], { tainted: true });
    expect(text(tainted.container)).toContain("external content");
  });
});

describe("secret request cards (M11R120)", () => {
  it("names the secret, shows the reason as untrusted text and never as markup", async () => {
    const page = await show([secret]);
    expect(text(page.container)).toContain("Atlas asks for a secret: GITHUB_TOKEN");
    expect(text(page.container)).toContain("to push the branch <b>now</b>");
    expect(page.container.querySelector("b")).toBeNull();
  });

  it("opens the secret dialog with Provide… and declines through secrets.declineRequest", async () => {
    const onProvide = vi.fn();
    const page = await show([secret], { onProvide });
    await click(button(page.container, "Provide…"));
    expect(onProvide).toHaveBeenCalledWith(expect.objectContaining({ id: "r2" }));
    await click(button(page.container, "Decline"));
    await settle();
    expect(bed.called("secrets.declineRequest")).toEqual([
      expect.objectContaining({ params: { requestId: "r2" } }),
    ]);
  });

  it("keeps Provide… off until a dialog is wired, and says why next to it", async () => {
    const page = await show([secret]);
    const provide = button(page.container, "Provide…");
    expect(provide.disabled).toBe(true);
    expect(provide.hasAttribute("title")).toBe(false);
    const hint = document.getElementById(provide.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("Opens with the secret dialog");
    expect(hasButton(page.container, "Decline")).toBe(true);
  });

  it("shows no hint when Provide… is wired", async () => {
    const page = await show([secret], { onProvide: vi.fn() });
    expect(text(page.container)).not.toContain("Opens with the secret dialog");
  });
});

describe("an expired request (fixed clock)", () => {
  it("says expired and disables Approve and Deny, one tick before and at the deadline", async () => {
    const before = await show([approve], { now: approve.expiresAt - 60_000 });
    expect(text(before.container)).toContain("Closes in 1 min");
    expect(button(before.container, "Approve").disabled).toBe(false);
    const at = await show([{ ...approve, id: "r3" }], { now: approve.expiresAt });
    const words = text(at.container);
    expect(words).toContain("Expired");
    expect(words).not.toContain("Closes in");
    expect(button(at.container, "Approve").disabled).toBe(true);
    expect(button(at.container, "Deny").disabled).toBe(true);
    await click(button(at.container, "Approve"));
    await settle();
    expect(bed.called("agents.answerApproval")).toEqual([]);
  });

  it("disables Decline and Provide… of an expired secret request too", async () => {
    const page = await show([secret], { now: secret.expiresAt + 1, onProvide: vi.fn() });
    expect(text(page.container)).toContain("Expired");
    expect(button(page.container, "Decline").disabled).toBe(true);
    expect(button(page.container, "Provide…").disabled).toBe(true);
  });
});

describe("clipped text of an agent", () => {
  it("clips a request title to 500 UTF-16 units without cutting a pair", async () => {
    const title = `${"a".repeat(498)}\u{1F600}tail`;
    const page = await show([{ ...approve, title }]);
    const shown = (page.container.querySelector("h3 span") as HTMLElement).textContent ?? "";
    expect(shown).toBe(`Atlas asks: ${"a".repeat(498)}\u2026`);
    expect(shown.length).toBe("Atlas asks: ".length + 499);
  });
});
