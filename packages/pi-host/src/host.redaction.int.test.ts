import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForkedHost } from "./testing/fork-host.ts";
import { bashScript, createHostBed, isApproval, isCallAudit, RULES } from "./testing/host-bed.ts";

const SECRET = "ghp_testsecret_0123456789";
const LEAKY_EXTENSION = `export default function (pi) {
  pi.on("agent_start", async (_event, ctx) => {
    ctx.ui.notify(process.env.GITHUB_TOKEN, "info");
    process.stderr.write("leak " + process.env.GITHUB_TOKEN + "\\n");
  });
  pi.on("agent_end", async () => {
    throw new Error(process.env.GITHUB_TOKEN);
  });
}
`;
const within = { timeout: 20_000 };

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

/** Runs one prompt; the bash call is answered "once" when the policy asks, and `asks` says whether it did. */
async function run(host: ForkedHost, asks = true): Promise<void> {
  host.send({ type: "prompt", id: "p1", message: "go" });
  if (asks) {
    const ask = await host.waitFor(isApproval);
    host.send({ type: "approval_response", id: ask.id, answer: "once" });
  }
  await host.waitFor((r) => r.type === "agent_settled");
}

const resultAudits = (records: ReadonlyArray<{ type: string; entry?: unknown }>) =>
  records.filter((r) => r.type === "audit" && (r.entry as { kind?: string }).kind === "result");

describe("pi-host worker: secret redaction", () => {
  it("the Pi file holds the marker, the result entry counts the redactions, no audit row holds the value", async () => {
    const ready = await bed.start(bashScript('echo "$GITHUB_TOKEN"; printenv GITHUB_TOKEN'), {
      env: { GITHUB_TOKEN: SECRET },
    });
    const host = bed.host();
    await run(host);
    const file = readFileSync(String(ready.sessionFile), "utf8");
    expect(file).not.toContain(SECRET);
    expect(file).toContain("[SECRET:GITHUB_TOKEN]");
    await vi.waitFor(() => expect(resultAudits(host.records)).toHaveLength(1), within);
    expect(resultAudits(host.records)).toEqual([
      {
        type: "audit",
        entry: expect.objectContaining({
          kind: "result",
          toolCallId: "call-1",
          redactions: 4, // two lines of output, stated in the text and again in the structured content
          external: false,
        }),
      },
    ]);
    expect(JSON.stringify(host.records.filter((r) => r.type === "audit"))).not.toContain(SECRET);
    expect(JSON.stringify(host.records.find((r) => r.type === "tool_execution_end"))).not.toContain(SECRET);
    expect(host.stderr()).not.toContain(SECRET);
  });

  it("a credential Pi wrote to auth.json after the session opened is redacted from the next result", async () => {
    await bed.start(bashScript("printf '%s\\n' \"$(cat auth.copy)\""), { env: {} });
    const host = bed.host();
    const token = "at-late-0123456789";
    writeFileSync(join(bed.cwd, "auth.copy"), token);
    writeFileSync(join(bed.agentDir, "auth.json"), JSON.stringify({ openai: { access: token } }));
    await run(host);
    await vi.waitFor(() => expect(resultAudits(host.records)).toHaveLength(1), within);
    // Pi's bash result states the output twice (text and structured content); live partial updates are Task 8b's.
    const end = host.records.find((r) => r.type === "tool_execution_end");
    expect(JSON.stringify(end)).not.toContain(token);
    expect(JSON.stringify(end)).toContain("[SECRET:AUTH_OPENAI_ACCESS]");
    expect(resultAudits(host.records)[0]).toMatchObject({ entry: { redactions: 2 } });
  });

  it("a placeholder password in the environment is not turned into markers", async () => {
    await bed.start(bashScript("echo postgres"), { env: { POSTGRES_PASSWORD: "postgres" } });
    const host = bed.host();
    await run(host);
    expect(resultAudits(host.records)).toEqual([]);
  });

  it("the call entry's arguments hold the marker when the command carries the value itself", async () => {
    await bed.start(bashScript(`echo ${SECRET} | wc -c`), { env: { GITHUB_TOKEN: SECRET } });
    const host = bed.host();
    await run(host);
    const call = host.records.find(isCallAudit);
    expect(call).toMatchObject({ entry: { args: "echo [SECRET:GITHUB_TOKEN] | wc -c" } });
    expect(JSON.stringify(host.records.filter((r) => r.type === "audit"))).not.toContain(SECRET);
  });

  it("a secret in the output of a failing command is redacted too", async () => {
    const ready = await bed.start(bashScript('echo "$GITHUB_TOKEN"; exit 3'), {
      env: { GITHUB_TOKEN: SECRET },
    });
    const host = bed.host();
    await run(host);
    const end = host.records.find((r) => r.type === "tool_execution_end");
    expect(end).toMatchObject({ isError: true });
    expect(JSON.stringify(end)).toContain("[SECRET:GITHUB_TOKEN]");
    expect(JSON.stringify(end)).not.toContain(SECRET);
    expect(readFileSync(String(ready.sessionFile), "utf8")).not.toContain(SECRET);
  });

  it("an audit reason that names a secret host is redacted although stage 02 wrote it in lower case", async () => {
    const host_ = "Secret-Host-0123.invalid";
    await bed.start(bashScript(`echo http://${host_}/x`), {
      env: { EVIL_TOKEN: host_ },
      policy: { ...RULES, allowHosts: ["allowed.example"] },
    });
    const host = bed.host();
    await run(host, false);
    const call = host.records.find(isCallAudit);
    expect(call).toMatchObject({ entry: { decision: "block" } });
    const text = JSON.stringify(call);
    expect(text).toContain("[SECRET:EVIL_TOKEN]");
    expect(text.toLowerCase()).not.toContain(host_.toLowerCase());
  });

  it("no record leaving the worker holds a known secret value, an extension's notice and error included (M5R36)", async () => {
    await bed.start(bashScript('echo "$GITHUB_TOKEN"; printenv GITHUB_TOKEN'), {
      env: { GITHUB_TOKEN: SECRET },
      agentFiles: { "extensions/leaky.js": LEAKY_EXTENSION },
    });
    const host = bed.host();
    await run(host);
    await vi.waitFor(() => expect(host.records.map((r) => r.type)).toContain("extension_error"), within);
    const types = host.records.map((record) => record.type);
    expect(types).toEqual(
      expect.arrayContaining(["extension_ui_request", "extension_error", "tool_execution_update"]),
    );
    expect(JSON.stringify(host.records)).not.toContain(SECRET);
    expect(JSON.stringify(host.records)).toContain("[SECRET:GITHUB_TOKEN]");
    // The worker's own output reaches the daemon's log tail: it is redacted too.
    expect(host.stderr()).toContain("leak [SECRET:GITHUB_TOKEN]");
    expect(host.stderr()).not.toContain(SECRET);
  });

  it("a file read then written back is unchanged: the marker the model saw goes back to the value (M5R119)", async () => {
    const value = "s3cr3t-Value-1";
    writeFileSync(join(bed.cwd, "cfg.txt"), `db_token=${value}\n`);
    const script = {
      steps: [
        { toolCalls: [{ name: "read", args: { path: "cfg.txt" }, id: "r" }] },
        {
          toolCalls: [
            { name: "write", args: { path: "cfg.txt", content: "db_token=[SECRET:DB_TOKEN]\n" }, id: "w" },
          ],
        },
        { text: "done" },
      ],
    };
    const ready = await bed.start(script, { env: { DB_TOKEN: value } });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "rewrite it" });
    await host.waitFor((r) => r.type === "agent_settled");
    expect(readFileSync(join(bed.cwd, "cfg.txt"), "utf8")).toBe(`db_token=${value}\n`);
    expect(readFileSync(String(ready.sessionFile), "utf8")).not.toContain(value);
    expect(JSON.stringify(host.records)).not.toContain(value);
    expect(host.records.find(isCallAudit)).toBeDefined();
  });
});
