// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "./register-session-catalog.ts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, settle, text } from "../../testing/dom.ts";
import { pickItem, preloadMenu } from "../../testing/menu.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: unknown }) =>
      createElement("a", { href: props.to }, props.children as never),
    useNavigate: () => vi.fn(),
  };
});

beforeAll(preloadMenu);
const screen = screenBed(current);
const rule = (id: string, tool: string, label: string, createdAt = Date.UTC(2026, 9, 11)) => ({
  id,
  scope: "/work/project",
  tool,
  label,
  createdAt,
});
const two = {
  truncated: false,
  rules: [rule("r2", "bash", "pnpm test"), rule("r1", "write", "src/a.ts")],
};
const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};

/** The rules open from the approval mode chip's menu, in the session header. */
async function open(container: HTMLElement) {
  await pickItem(
    container.querySelector("[data-policy-mode]") as HTMLElement,
    "Always allowed in this project",
  );
  await settle();
  return container.querySelector("[data-always-rules]");
}
const revokeButtons = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].filter((b) => b.textContent === "Revoke");

async function show() {
  const container = await screen.show({ cwd: "/work/project" });
  await open(container);
  return container;
}
const listed = () => screen.bed.called("policy.listRules");

describe("always rules", () => {
  it("lists the rules of the session's folder, one line each", async () => {
    screen.bed.handlers["policy.listRules"] = () => two;
    const container = await show();
    expect(listed()).toEqual([{ method: "policy.listRules", params: { cwd: "/work/project" } }]);
    const lines = [...container.querySelectorAll("[data-rule]")].map((line) => text(line));
    expect(lines).toEqual(["bashpnpm test2026-10-11Revoke", "writesrc/a.ts2026-10-11Revoke"]);
  });

  it("says when nothing is always allowed", async () => {
    screen.bed.handlers["policy.listRules"] = () => ({ rules: [], truncated: false });
    const container = await show();
    expect(text(container)).toContain("Nothing is always allowed here.");
  });

  it("revokes the first rule with a command id and reloads the list", async () => {
    let rules = two.rules;
    screen.bed.handlers["policy.listRules"] = () => ({ truncated: false, rules });
    screen.bed.handlers["policy.revokeRule"] = () => {
      rules = rules.slice(1);
      return { ok: true };
    };
    const container = await show();
    await click(revokeButtons(container)[0] as HTMLElement);
    await settle();
    expect(screen.bed.called("policy.revokeRule")).toEqual([
      {
        method: "policy.revokeRule",
        params: { ruleId: "r2" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
    expect(listed()).toHaveLength(2);
    expect(revokeButtons(container)).toHaveLength(1);
    expect(text(container)).not.toContain("pnpm test");
  });

  it("cannot double-send a revoke", async () => {
    const reply = deferred();
    screen.bed.handlers["policy.listRules"] = () => two;
    screen.bed.handlers["policy.revokeRule"] = () => reply.promise;
    const container = await show();
    const first = revokeButtons(container)[0] as HTMLButtonElement;
    await click(first);
    await click(first);
    expect(screen.bed.called("policy.revokeRule")).toHaveLength(1);
    expect(first.disabled).toBe(true);
    reply.resolve({ ok: true });
    await settle();
    expect(first.disabled).toBe(false);
  });

  it("reloads after a failure, shows it, and never retries a timeout by itself", async () => {
    screen.bed.handlers["policy.listRules"] = () => two;
    screen.bed.handlers["policy.revokeRule"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show();
    await click(revokeButtons(container)[0] as HTMLElement);
    await settle();
    expect(screen.bed.called("policy.revokeRule")).toHaveLength(1);
    expect(listed()).toHaveLength(2);
    expect(alerts(container)).toEqual([
      "The session did not answer in time. The action may still have gone through: check before trying again.",
    ]);
  });

  it("reloads after not_found: the rule was already gone", async () => {
    let rules = two.rules;
    screen.bed.handlers["policy.listRules"] = () => ({ truncated: false, rules });
    screen.bed.handlers["policy.revokeRule"] = () => {
      rules = [];
      throw new RpcError("not_found");
    };
    const container = await show();
    await click(revokeButtons(container)[0] as HTMLElement);
    await settle();
    expect(text(container)).toContain("Nothing is always allowed here.");
  });

  it("says when more rules exist than are shown", async () => {
    screen.bed.handlers["policy.listRules"] = () => ({ ...two, truncated: true });
    const container = await show();
    expect(text(container)).toContain("More rules exist than the ones shown.");
  });

  it("shows a list failure inline", async () => {
    screen.bed.handlers["policy.listRules"] = () => {
      throw new RpcError("internal");
    };
    const container = await show();
    expect(alerts(container)).toHaveLength(1);
  });

  it("renders a label as text, clipped for display", async () => {
    const label = `<img src=x onerror=alert(1)>${"x".repeat(500)}`;
    screen.bed.handlers["policy.listRules"] = () => ({
      truncated: false,
      rules: [rule("r1", "bash", label)],
    });
    const container = await show();
    expect(container.querySelector("img")).toBeNull();
    const shown = container.querySelector("[data-rule-label]")?.textContent ?? "";
    expect(shown.startsWith("<img src=x onerror=alert(1)>")).toBe(true);
    expect([...shown]).toHaveLength(201);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("stays closed, and asks nothing, until it is opened", async () => {
    screen.bed.handlers["policy.listRules"] = () => two;
    const container = await screen.show({});
    expect(listed()).toHaveLength(0);
    expect(container.querySelector("[data-always-rules]")).toBeNull();
    expect(button(container, "Session actions")).toBeTruthy();
  });

  it("closes from its own button, with the focus back on the mode chip", async () => {
    screen.bed.handlers["policy.listRules"] = () => two;
    const container = await show();
    await click(button(container, "Close"));
    await vi.waitFor(
      () => expect(document.activeElement).toBe(container.querySelector("[data-policy-mode]")),
      {
        timeout: 2_000,
      },
    );
    expect(container.querySelector("[data-always-rules]")).toBeNull();
  });

  it("drops a list answer that a later reload overtook", async () => {
    const slow = deferred();
    let calls = 0;
    screen.bed.handlers["policy.listRules"] = () => {
      calls += 1;
      if (calls === 1) return two;
      return calls === 2 ? slow.promise : { truncated: false, rules: [] };
    };
    screen.bed.handlers["policy.revokeRule"] = () => ({ ok: true });
    const container = await show();
    await click(revokeButtons(container)[0] as HTMLElement);
    await settle();
    await click(revokeButtons(container)[1] as HTMLElement);
    await settle();
    expect(text(container)).toContain("Nothing is always allowed here.");
    slow.resolve(two);
    await settle();
    expect(text(container)).toContain("Nothing is always allowed here.");
    expect(revokeButtons(container)).toHaveLength(0);
  });

  it("lists the rules of the snapshot's folder and never lists sessions", async () => {
    screen.bed.handlers["policy.listRules"] = () => two;
    const container = await screen.show({ cwd: "/w/api" });
    await open(container);
    expect(listed()).toEqual([{ method: "policy.listRules", params: { cwd: "/w/api" } }]);
    expect(screen.bed.called("sessions.list")).toEqual([]);
  });

  it("shows the loading text, and asks nothing, while the snapshot has no folder", async () => {
    const container = await screen.show({ cwd: "" });
    await open(container);
    expect(text(container)).toContain("Loading…");
    expect(listed()).toHaveLength(0);
    expect(screen.bed.called("sessions.list")).toEqual([]);
  });
});
