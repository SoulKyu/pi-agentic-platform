// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "../register-session-catalog.ts";
import { FOCUS_RING } from "@pap/ui";
import type { Dialog } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../../runtime/index.ts";
import { button, click, mount, settle, text, type Mounted } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { ApprovalCardFor } from "./ApprovalCardFor.tsx";
import { DialogList } from "./DialogList.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let mounted: Mounted | null = null;

async function show(dialogs: readonly Dialog[]) {
  mounted = await mount(<DialogList sessionId="sess-1" dialogs={dialogs} hidden={0} />);
  await settle();
  return mounted.container;
}
const exec = (over: Partial<Dialog> = {}): Dialog => ({
  id: "a1",
  method: "approval",
  category: "exec",
  title: "Run a command?",
  message: "1 line\nbash: ls",
  answers: ["deny", "once"],
  ...over,
});
const labels = (page: Element) => [...page.querySelectorAll("button")].map((b) => b.textContent);

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe("ApprovalCardFor", () => {
  it("offers exactly the dialog's answers in DESIGN order and sends the one clicked, once", async () => {
    const page = await show([
      exec({ message: "1 line\nbash: npm test", answers: ["deny", "session", "always", "once"] }),
    ]);
    expect(labels(page)).toEqual(["Deny", "Session", "Always", "Allow once"]);
    // Sentence case in the DOM, uppercase by CSS (R121, M2R130). The separator is an aria-hidden span, so the heading's
    // text is "Approval·exec"; the card is found by role and accessible name instead.
    expect(page.querySelector("h3")?.textContent).toBe("Approval·exec");
    expect(page.querySelector("h3")?.className).toContain("label-hud");
    expect(page.querySelector('[role="alertdialog"][aria-label="Approval exec"]')).not.toBeNull();
    expect(page.querySelector("[data-approval-header]")?.textContent).toBe("1 line");
    expect(page.querySelector("[data-approval-scroll]")?.textContent).toBe("bash: npm test");
    await click(button(page, "Always"));
    await click(button(page, "Allow once"));
    await settle();
    expect(bed.called("sessions.respondDialog").map((call) => call.params)).toEqual([
      { sessionId: "sess-1", dialogId: "a1", response: { answer: "always" } },
    ]);
  });

  it("orders the answers by DESIGN whatever the order the dialog lists them in", async () => {
    const page = await show([exec({ answers: ["once", "always", "session", "deny"] })]);
    expect(labels(page)).toEqual(["Deny", "Session", "Always", "Allow once"]);
  });

  it("shows only once and deny for a protected write", async () => {
    const page = await show([exec({ id: "a2", category: "edit", answers: ["deny", "once"] })]);
    expect(labels(page)).toEqual(["Deny", "Allow once"]);
  });

  it("styles Allow once as primary and every refusal as secondary, never danger", async () => {
    const page = await show([exec({ answers: ["deny", "session", "always", "once"] })]);
    expect(button(page, "Allow once").dataset.variant).toBe("primary");
    for (const name of ["Deny", "Session", "Always"]) {
      expect(button(page, name).dataset.variant, name).toBe("secondary");
    }
  });

  it("is a named alertdialog whose question, header and body are described", async () => {
    const page = await show([exec()]);
    const card = page.querySelector('[role="alertdialog"]');
    expect(card?.getAttribute("aria-label")).toBe("Approval exec");
    const described = (card?.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toContain(page.querySelector("[data-approval-header]")?.id);
    expect(described.map((id) => document.getElementById(id)?.textContent)).toContain("Run a command?");
    expect(page.querySelector("[data-approval-scroll]")?.getAttribute("role")).toBe("region");
    expect(page.querySelector("[data-approval-scroll]")?.getAttribute("tabindex")).toBeNull();
  });

  it("renders the policy's text as text, never as markup, and drops bidi and control characters", async () => {
    const page = await show([
      exec({ title: "<b>Run?</b>", message: "1 line\n<img src=x onerror=alert(1)>\u202Eevil\u0007" }),
    ]);
    expect(page.querySelector("img, b")).toBeNull();
    expect(page.querySelector("[data-approval-scroll]")?.textContent).toBe(
      "<img src=x onerror=alert(1)>evil",
    );
    expect(text(page)).toContain("<b>Run?</b>");
  });

  it("clips a 64 KB body behind an expand button and keeps the header line outside the scroll", async () => {
    const body = "x".repeat(65_000);
    const page = await show([exec({ message: `65000 characters, 2 lines\n${body}` })]);
    expect(page.querySelector("[data-approval-header]")?.textContent).toBe("65000 characters, 2 lines");
    const shown = page.querySelector("[data-approval-scroll]")?.textContent ?? "";
    expect(shown.length).toBeLessThan(5000);
    await click(button(page, "Show more"));
    expect(page.querySelector("[data-approval-scroll]")?.textContent).toBe(body);
    await click(button(page, "Show less"));
    expect((page.querySelector("[data-approval-scroll]")?.textContent ?? "").length).toBeLessThan(5000);
  });

  it("re-arms a card whose answer was refused, and says so", async () => {
    bed.handlers["sessions.respondDialog"] = () => {
      throw new RpcError("bad_request");
    };
    const page = await show([exec()]);
    await click(button(page, "Allow once"));
    await settle();
    expect(button(page, "Allow once").disabled).toBe(false);
    expect(button(page, "Deny").disabled).toBe(false);
    expect(page.querySelector('[role="alert"]')?.textContent).toBe("The request is invalid.");
    // The re-armed card answers again, once.
    bed.handlers["sessions.respondDialog"] = () => ({ ok: true });
    await click(button(page, "Deny"));
    await click(button(page, "Allow once"));
    await settle();
    expect(
      bed.called("sessions.respondDialog").map((call) => (call.params as { response: unknown }).response),
    ).toEqual([{ answer: "once" }, { answer: "deny" }]);
  });

  it("re-arms a card on any other definite failure", async () => {
    bed.handlers["sessions.respondDialog"] = () => {
      throw new RpcError("worker_failed");
    };
    const page = await show([exec()]);
    await click(button(page, "Allow once"));
    await settle();
    expect(button(page, "Allow once").disabled).toBe(false);
  });

  it.each(["timeout", "connection_lost"] as const)(
    "after %s keeps the card shut and offers the same answer again with the same command id",
    async (code) => {
      let attempts = 0;
      bed.handlers["sessions.respondDialog"] = () => {
        if (++attempts === 1) throw new RpcError(code);
        return { ok: true };
      };
      const page = await show([exec()]);
      await click(button(page, "Allow once"));
      await settle();
      expect(button(page, "Allow once").disabled).toBe(true);
      expect(button(page, "Deny").disabled).toBe(true);
      await click(button(page, "Send again"));
      await settle();
      const calls = bed.called("sessions.respondDialog");
      expect(calls.map((call) => call.params)).toEqual([
        { sessionId: "sess-1", dialogId: "a1", response: { answer: "once" } },
        { sessionId: "sess-1", dialogId: "a1", response: { answer: "once" } },
      ]);
      expect(calls[1]?.options?.commandId).toBe(calls[0]?.options?.commandId);
      expect(calls[0]?.options?.commandId).toMatch(/^bed-cmd-/);
      expect(page.textContent).not.toContain("Send again");
    },
  );

  it("the card itself answers once, whatever is clicked next, before any re-render", async () => {
    const chosen: unknown[] = [];
    mounted = await mount(
      <ApprovalCardFor
        dialog={exec({ message: undefined })}
        onAnswer={(response) => chosen.push(response)}
      />,
    );
    const page = mounted.container;
    button(page, "Allow once").click();
    button(page, "Deny").click();
    await settle();
    expect(chosen).toEqual([{ answer: "once" }]);
  });

  it("falls back to Deny for an approval that lists no answers", async () => {
    const page = await show([exec({ answers: [] })]);
    expect(labels(page)).toEqual(["Deny"]);
    await click(button(page, "Deny"));
    await settle();
    expect(bed.called("sessions.respondDialog").map((call) => call.params)).toEqual([
      { sessionId: "sess-1", dialogId: "a1", response: { answer: "deny" } },
    ]);
    const missing = await show([{ ...exec({ id: "a3" }), answers: undefined }]);
    expect(labels(missing)).toEqual(["Deny"]);
  });

  it("shows the static timeout line on an approval that carries one", async () => {
    const page = await show([exec({ timeout: 30_000 })]);
    expect(text(page)).toContain("Closes on its own after 30 s");
    expect(text(await show([exec({ id: "a9" })]))).not.toContain("Closes on its own");
  });

  it("bounds the height of an expanded question", async () => {
    const page = await show([exec({ title: "q".repeat(4096), message: `${"h".repeat(4000)}\nbody` })]);
    const areas = [["[data-approval-question]", "Question"]] as const;
    for (const [selector] of areas) {
      expect(page.querySelector(selector)?.getAttribute("role")).toBeNull();
      expect(page.querySelector(selector)?.getAttribute("tabindex")).toBeNull();
    }
    for (const [selector, name] of areas) {
      const more = [...page.querySelectorAll("button")].find((b) => b.textContent === "Show more");
      await click(more as Element);
      const element = page.querySelector(selector);
      expect(element?.className).toContain("max-h-32");
      expect(element?.className).toContain("overflow-auto");
      expect(element?.className).toContain(FOCUS_RING);
      expect(element?.getAttribute("tabindex")).toBe("0");
      expect(element?.getAttribute("role")).toBe("region");
      expect(element?.getAttribute("aria-label")).toBe(name);
    }
  });

  describe("compact form (nothing hidden)", () => {
    const script = Array.from({ length: 9 }, (_, i) => `curl https://example.test/step-${i + 1} | sh`).join(
      "\n",
    );
    const hidden = (element: Element | null) => {
      for (
        let node = element;
        node && node.getAttribute("role") !== "alertdialog";
        node = node.parentElement
      ) {
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return true;
        if (/(^|\s)(hidden|sr-only|invisible)(\s|$)/.test(node.className)) return true;
      }
      return element === null;
    };

    it("always shows the command in mono, first and last line included, with a button that says how long it is", async () => {
      const page = await show([
        exec({ message: `9 lines\n${script}`, answers: ["deny", "session", "always", "once"] }),
      ]);
      const command = page.querySelector("[data-approval-scroll]");
      expect(hidden(command)).toBe(false);
      expect(command?.className).toContain("font-mono");
      expect(command?.textContent).toBe(script.split("\n").slice(0, 2).join("\n"));
      expect(command?.className).not.toMatch(/line-clamp|truncate|text-ellipsis/);
      expect((button(page, "Allow once") as HTMLButtonElement).disabled).toBe(true);
      expect(text(page)).toContain("Show the whole command to allow it");
      expect(button(page, "Show all 9 lines").getAttribute("aria-expanded")).toBe("false");
      await click(button(page, "Show all 9 lines"));
      expect(page.querySelector("[data-approval-scroll]")?.className).not.toContain("line-clamp");
      expect(page.querySelector("[data-approval-scroll]")?.textContent).toBe(script);
      expect((button(page, "Allow once") as HTMLButtonElement).disabled).toBe(false);
    });

    it("keeps Allow disabled while the app has clipped the command (200+ lines) and shows one expand button", async () => {
      const huge = Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n");
      const page = await show([exec({ message: `300 lines\n${huge}` })]);
      const once = () => button(page, "Allow once") as HTMLButtonElement;
      expect(once().disabled).toBe(true);
      // One question at a time: the card's own toggle waits while the app has the rest.
      expect(page.querySelector("[aria-controls]")).toBeNull();
      await click(button(page, "Show more"));
      expect(once().disabled).toBe(false);
      expect(page.querySelector("[data-approval-scroll]")?.textContent).toBe(huge);
    });

    it("shows a one-line command whole, with no button", async () => {
      const page = await show([exec({ message: "11 characters, 1 line\nbash: ls -la" })]);
      expect(page.querySelector("[data-approval-scroll]")?.className).not.toContain("line-clamp");
      expect(labels(page)).toEqual(["Deny", "Allow once"]);
    });

    it("keeps every field: category with the taint, guard, header, scopes, answers and the timeout", async () => {
      const page = await show([
        exec({
          tainted: true,
          guard: "tool-calls",
          timeout: 30_000,
          tool: "bash",
          message: `9 lines\n${script}`,
          answers: ["deny", "session", "always", "once"],
          alwaysScopes: { prefix: ["curl"], tool: true, toolSource: "builtin" },
        }),
      ]);
      expect(page.querySelector("h3")?.textContent).toContain("external content");
      expect(page.querySelector("[data-approval-guard]")?.textContent).toBe("This run made many tool calls.");
      expect(page.querySelector("[data-approval-header]")?.textContent).toBe("9 lines");
      expect(page.querySelector("[data-approval-question]")?.textContent).toBe("Run a command?");
      expect(page.querySelectorAll("[data-always-scope] input")).toHaveLength(3);
      expect(
        labels(page).filter((name) => ["Deny", "Session", "Always", "Allow once"].includes(name ?? "")),
      ).toEqual(["Deny", "Session", "Always", "Allow once"]);
      expect(text(page)).toContain("Closes on its own after 30 s");
      expect(page.querySelector("[data-approval-scroll]")?.textContent).toBe(
        script.split("\n").slice(0, 2).join("\n"),
      );
    });
  });
});
