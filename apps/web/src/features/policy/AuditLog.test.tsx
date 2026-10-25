// @vitest-environment happy-dom
import { AUDIT_RATE_LIMIT_REASON, type AuditView } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsApprovalsEn, settingsApprovalsFr } from "../../i18n/catalog/settings-approvals.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import {
  alerts,
  statuses,
  button,
  click,
  field,
  mount,
  settle,
  text,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AuditLog } from "./AuditLog.tsx";

registerCatalog({ en: settingsApprovalsEn, fr: settingsApprovalsFr });

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed = fakeRuntime();
let page: Mounted | null = null;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const NUL = String.fromCodePoint(0);
const REPL = String.fromCodePoint(0xfffd);
const invisible = (value: string) => /[\p{Cc}\p{Cf}]/u.test(value);
const AT = Date.UTC(2026, 9, 12, 10, 30);
const row = (id: number, over: Partial<AuditView> = {}): AuditView => ({
  id,
  at: AT,
  actor: "worker",
  actorId: null,
  kind: "call",
  sessionId: "s1",
  toolCallId: `c${id}`,
  parentToolCallId: null,
  tool: "bash",
  category: "exec",
  decision: "allow",
  reason: null,
  stages: [],
  args: null,
  detail: null,
  ...over,
});
const answer = (entries: AuditView[], nextBefore: number | null = null) => ({
  entries,
  nextBefore,
  truncated: false,
});
const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
async function show(first: unknown) {
  bed.handlers["audit.list"] = () => first;
  page = await mount(<AuditLog />);
  await settle();
  return page.container;
}
const listed = () => bed.called("audit.list").map((call) => call.params);
const rows = (container: HTMLElement) => [...container.querySelectorAll("[data-audit-row]")];
const ids = (container: HTMLElement) => rows(container).map((el) => el.getAttribute("data-audit-row"));
const one = (container: HTMLElement, selector: string) => container.querySelector(selector);

describe("audit log paging", () => {
  it("asks for 100, then for older rows from nextBefore, one request at a time", async () => {
    const second = deferred();
    let calls = 0;
    const container = await show(answer([row(9), row(8)], 8));
    bed.handlers["audit.list"] = () => {
      calls += 1;
      return second.promise;
    };
    expect(listed()).toEqual([{ limit: 100 }]);
    await click(button(container, "Load older"));
    await click(button(container, "Load older"));
    expect(calls).toBe(1);
    expect(listed()[1]).toEqual({ limit: 100, before: 8 });
    second.resolve(answer([row(7), row(6)]));
    await settle();
    expect(ids(container)).toEqual(["9", "8", "7", "6"]);
    expect(text(container)).not.toContain("Load older");
  });

  it("never lists a row twice", async () => {
    const container = await show(answer([row(9), row(8)], 8));
    bed.handlers["audit.list"] = () => answer([row(8), row(7)]);
    await click(button(container, "Load older"));
    await settle();
    expect(ids(container)).toEqual(["9", "8", "7"]);
  });

  it("stops offering older rows at the cap and says so", async () => {
    const full = Array.from({ length: 1000 }, (_, index) => row(2000 - index));
    const container = await show(answer(full, 1001));
    expect(rows(container)).toHaveLength(1000);
    expect(text(container)).not.toContain("Load older");
    expect(text(container)).toContain("Showing the newest 1000 rows");
  });

  it("drops a page whose filter changed meanwhile, then loads the new filter after it", async () => {
    const slow = deferred();
    const next = deferred();
    bed.handlers["audit.list"] = (params) =>
      (params as { sessionId?: string }).sessionId === undefined ? slow.promise : next.promise;
    page = await mount(<AuditLog />);
    await settle();
    const container = page.container;
    await typeInto(field(container, "Session id"), " s2 ");
    await click(button(container, "Filter"));
    expect(listed()).toEqual([{ limit: 100 }]); // still one request at a time
    slow.resolve(answer([row(1)]));
    await settle();
    expect(listed()).toEqual([{ limit: 100 }, { limit: 100, sessionId: "s2" }]);
    expect(ids(container)).toEqual([]); // the old filter's page is not shown while the new one loads
    next.resolve(answer([row(2, { sessionId: "s2" })]));
    await settle();
    expect(ids(container)).toEqual(["2"]);
  });

  it("refuses a session id over 128 characters: no request, a message, the old list stays", async () => {
    const container = await show(answer([row(1)]));
    await typeInto(field(container, "Session id"), "a".repeat(129));
    await click(button(container, "Filter"));
    await settle();
    expect(listed()).toEqual([{ limit: 100 }]);
    expect(text(container)).toContain("A session id has at most 128 characters.");
    expect(ids(container)).toEqual(["1"]);
    await typeInto(field(container, "Session id"), "a".repeat(128));
    expect(text(container)).not.toContain("at most 128");
    await click(button(container, "Filter"));
    await settle();
    expect(listed()[1]).toEqual({ limit: 100, sessionId: "a".repeat(128) });
  });

  it("clears the filter with an empty field", async () => {
    const container = await show(answer([row(1)]));
    await typeInto(field(container, "Session id"), "s2");
    await click(button(container, "Filter"));
    await settle();
    await typeInto(field(container, "Session id"), "");
    await click(button(container, "Filter"));
    await settle();
    expect(listed()).toEqual([{ limit: 100 }, { limit: 100, sessionId: "s2" }, { limit: 100 }]);
  });

  it("applies the filter when the form is submitted (Enter in the field)", async () => {
    const container = await show(answer([row(1)]));
    await typeInto(field(container, "Session id"), "s3");
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => form.requestSubmit());
    await settle();
    expect(listed()[1]).toEqual({ limit: 100, sessionId: "s3" });
  });
});

describe("audit log errors and states", () => {
  it("shows a failed first page and tries again", async () => {
    bed.handlers["audit.list"] = () => {
      throw new RpcError("internal");
    };
    page = await mount(<AuditLog />);
    await settle();
    const container = page.container;
    expect(statuses(container)).toHaveLength(1);
    expect(text(container)).not.toContain("Loading");
    bed.handlers["audit.list"] = () => answer([row(1)]);
    await click(button(container, "Try again"));
    await settle();
    expect(alerts(container)).toEqual([]);
    expect(ids(container)).toEqual(["1"]);
  });

  it("keeps the rows when Load older fails, and retries that page", async () => {
    const container = await show(answer([row(9)], 9));
    bed.handlers["audit.list"] = () => {
      throw new RpcError("timeout");
    };
    await click(button(container, "Load older"));
    await settle();
    expect(statuses(container)).toHaveLength(1);
    expect(ids(container)).toEqual(["9"]);
    bed.handlers["audit.list"] = () => answer([row(8)]);
    await click(button(container, "Try again"));
    await settle();
    expect(listed().at(-1)).toEqual({ limit: 100, before: 9 });
    expect(ids(container)).toEqual(["9", "8"]);
    expect(alerts(container)).toEqual([]);
  });

  it("says when nothing is recorded, and explains calls without a result row", async () => {
    const container = await show(answer([]));
    expect(text(container)).toContain("Nothing is recorded.");
    expect(text(container)).toContain("A call with no result row had nothing redacted and was not external.");
  });

  it("shows the decision as a chip with its tone", async () => {
    const decisions = ["allow", "approved", "denied", "block", "info"] as const;
    const container = await show(answer(decisions.map((decision, index) => row(index + 1, { decision }))));
    const chips = [...container.querySelectorAll("[data-slot=chip]")].map((chip) => [
      chip.getAttribute("data-tone"),
      chip.textContent,
    ]);
    expect(chips).toEqual([
      ["ok", "Allowed"],
      ["ok", "Approved"],
      ["att", "Denied"],
      ["err", "Blocked"],
      ["mut", "Info"],
    ]);
  });
});

describe("audit log rows", () => {
  it("shows time, kind, tool, reason and the stage trail with each verdict's reason in the details", async () => {
    const container = await show(
      answer([
        row(1, {
          decision: "approved",
          reason: "owner said yes",
          stages: [
            { stage: "01", outcome: "pass" },
            { stage: "02", outcome: "skip" },
            { stage: "03", outcome: "ask", reason: "exec asks" },
            { stage: "04", outcome: "pass" },
          ],
        }),
      ]),
    );
    const line = rows(container)[0] as HTMLElement;
    expect(one(line, "[data-audit-time]")?.textContent).toBe(new Date(AT).toLocaleString("en"));
    expect(text(line)).toContain("Call");
    expect(one(line, "[data-audit-tool]")?.textContent).toBe("bash");
    expect(one(line, "[data-audit-text=reason]")?.textContent).toBe("owner said yes");
    expect(one(line, "[data-audit-stages]")?.textContent).toBe("01 pass · 02 skip · 03 ask · 04 pass");
    expect(text(line)).not.toContain("exec asks");
    await click(button(line as HTMLElement, "Details"));
    expect(text(line)).toContain("03 ask: exec asks");
    expect(button(line as HTMLElement, "Details").getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the session row's mode and tool names, and copes with an old row without a mode", async () => {
    const container = await show(
      answer([
        row(3, {
          kind: "session",
          tool: null,
          detail: { mode: "supervised", count: 40, truncated: true, names: ["read", "bash", "write"] },
        }),
        row(2, { kind: "session", tool: null, detail: { count: 1, names: ["read"] } }),
      ]),
    );
    const [newer, older] = rows(container) as HTMLElement[];
    expect(text(newer as HTMLElement)).toContain("Mode: supervised");
    expect(text(newer as HTMLElement)).toContain("Tools (40): read, bash, write");
    expect(text(newer as HTMLElement)).toContain("More tools are not listed.");
    expect(text(older as HTMLElement)).toContain("Mode: not recorded");
    expect(text(older as HTMLElement)).toContain("Tools (1): read");
    expect(text(older as HTMLElement)).not.toContain("not listed");
  });

  it("shows a result row's redactions and whether it was external", async () => {
    const container = await show(
      answer([row(4, { kind: "result", detail: { redactions: 2, external: true } })]),
    );
    expect(text(container)).toContain("Redactions: 2");
    expect(text(container)).toContain("External content");
  });

  it("reads a rate-limit marker as a gap", async () => {
    const container = await show(
      answer([row(5, { kind: "audit", tool: null, decision: "info", reason: AUDIT_RATE_LIMIT_REASON })]),
    );
    const gap = rows(container)[0] as HTMLElement;
    expect(gap.hasAttribute("data-audit-gap")).toBe(true);
    expect(text(gap)).toContain("Gap: rows after this point were not recorded (rate limit).");
  });

  it("shows who did an auth or policy event", async () => {
    const container = await show(
      answer([row(6, { kind: "auth", actor: "cli", actorId: "owner", sessionId: null, tool: null })]),
    );
    expect(text(container)).toContain("cli · owner");
  });
});

describe("audit log hostile rows", () => {
  it("shows args stripped and clipped to 300 code points, and the expand shows the rest, still stripped", async () => {
    const args = `${RLO}ab${ZWSP}c${"x".repeat(1000)}`;
    const container = await show(answer([row(1, { args })]));
    const block = () => one(container, "[data-audit-text=args]")?.textContent ?? "";
    expect(invisible(block())).toBe(false);
    expect([...block()]).toHaveLength(301);
    expect(block().startsWith("abcxxx")).toBe(true);
    expect(block().endsWith("…")).toBe(true);
    const region = container.querySelector("pre");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.getAttribute("aria-label")).toBe("Arguments");
    await click(button(container, "Show more"));
    expect(block()).toBe(`abc${"x".repeat(1000)}`);
    expect(button(container, "Show less").getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a reason stripped of U+202E and NUL, clipped to 200 code points with an ellipsis", async () => {
    const reason = `${RLO}${NUL}${REPL}blocked${"y".repeat(600)}`;
    const container = await show(answer([row(1, { reason })]));
    const shown = one(container, "[data-audit-text=reason]")?.textContent ?? "";
    expect(invisible(shown)).toBe(false);
    expect([...shown]).toHaveLength(201);
    expect(shown.startsWith(`${REPL}blocked`)).toBe(true);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("renders a fake closing tag, a tool name and stage reasons as text only", async () => {
    const tag = "</pre><img src=x onerror=alert(1)><script>boom()</script>**bold** [l](http://x)";
    const container = await show(
      answer([
        row(1, {
          tool: `ba${ZWSP}sh${RLO}`,
          reason: tag,
          args: tag,
          sessionId: `s${RLO}1`,
          stages: [{ stage: "03", outcome: "ask", reason: `${tag}${"z".repeat(500)}${RLO}` }],
        }),
      ]),
    );
    await click(button(container, "Details"));
    expect(container.querySelector("img, script, a, strong")).toBeNull();
    expect(container.querySelectorAll("pre")).toHaveLength(1); // only our own args block
    expect(one(container, "[data-audit-tool]")?.textContent).toBe("bash");
    expect(one(container, "[data-audit-text=reason]")?.textContent).toBe(tag);
    expect(one(container, "[data-audit-text=args]")?.textContent).toBe(tag);
    const detail = one(container, "[data-audit-text=stage-reason]")?.textContent ?? "";
    expect(invisible(detail)).toBe(false);
    expect([...detail.replace("03 ask: ", "")]).toHaveLength(201);
    expect(text(container)).toContain("s1");
    expect(invisible(text(container))).toBe(false);
  });

  it("strips the session names and the mode of a hostile session row", async () => {
    const container = await show(
      answer([
        row(1, {
          kind: "session",
          tool: null,
          detail: { mode: `su${RLO}per`, count: 1, names: [`<b>re${ZWSP}ad</b>`] },
        }),
      ]),
    );
    expect(text(container)).toContain("Mode: super");
    expect(text(container)).toContain("Tools (1): <b>read</b>");
    expect(container.querySelector("b")).toBeNull();
  });
});
