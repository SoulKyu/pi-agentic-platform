import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForkedHost } from "./testing/fork-host.ts";
import { bashScript, createHostBed, isApproval } from "./testing/host-bed.ts";

const SECRET = "ghp_testsecret_0123456789";
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
});
