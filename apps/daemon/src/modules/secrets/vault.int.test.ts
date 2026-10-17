import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { EventFrame } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../kernel/ids.ts";
import { canonicalJson } from "../../kernel/ws/dispatcher.ts";
import { openOwner, outcome, type Owner, result, rows } from "../../security/testing/automation-bed.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";

// The real /usr/bin/bwrap in temporary folders. CI must provide a working bwrap; locally the file skips with one line.
function bwrapWorks(): boolean {
  try {
    execFileSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "/bin/true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
const usable = bwrapWorks();
if (!usable && process.env.CI) throw new Error("vault.int.test: CI must provide a working bwrap");
if (!usable) console.warn("vault.int.test: skipped: no usable /usr/bin/bwrap on this machine");

const VALUE = "planted-vault-value-8e2c41b7d9";
const BOLT = "bolt-vault-value-6d3e90a1f5";
const LATE = "late-vault-value-4a7f10c2e6";
const bash = (command: string, id: string) => ({ toolCalls: [{ name: "bash", args: { command }, id }] });

type StreamEvent = { kind?: string; status?: string };
/** A status event that arrived after position `from` of the connection's event list (seq restarts per session). */
const statusAfter = (client: Owner["client"], name: string, from: number) => (frame: EventFrame) =>
  (frame.event as StreamEvent).kind === "status" &&
  (frame.event as StreamEvent).status === name &&
  client.events.indexOf(frame) >= from;

const logs = captureLogger();
let t: TestDaemon;
let owner: Owner;
let agentId: string;
let sessionId: string;

beforeAll(async () => {
  if (!usable) return;
  t = await startTestDaemon(
    {
      steps: [
        bash("echo first=$API_TOKEN; echo bolt=[$BOLT_TOKEN]", "b1"),
        { text: "one" },
        bash("echo late=$LATE_TOKEN", "b2"),
        { text: "two" },
        bash("echo gone=[$API_TOKEN]", "b3"),
        { text: "three" },
      ],
    },
    { deps: { logger: logs.logger } },
  );
  owner = await openOwner(t);
});
afterAll(async () => {
  owner?.client.close();
  await t?.stop();
});

async function prompt(text: string): Promise<void> {
  const client = owner.client;
  const from = client.events.length;
  expect((await client.call("sessions.prompt", { sessionId, text })).ok).toBe(true);
  await client.waitForEvent(statusAfter(client, "running", from));
  await client.waitForEvent(statusAfter(client, "idle", from));
}
const output = async (toolCallId: string): Promise<string> =>
  result<{ text: string }>(await owner.client.call("sessions.toolOutput", { sessionId, toolCallId })).text;

describe.skipIf(!usable)("the vault through a real daemon, a real worker and a real bwrap", () => {
  it("a browser sets a secret; the agent's shell sees it, and everything it prints comes back redacted", async () => {
    const created = result<{ id: string }>(
      await owner.client.call("agents.create", { input: { name: "Atlas", preset: "full" } as never }),
    );
    agentId = created.id;
    expect(
      outcome(await owner.client.call("secrets.set", { agentId, name: "API_TOKEN", value: VALUE })),
    ).toBe("ok");
    sessionId = result<{ sessionId: string }>(
      await owner.client.call("agents.openThread", { agentId }),
    ).sessionId;
    expect((await owner.client.call("subscribe.session", { sessionId })).ok).toBe(true);
    await prompt("go");
    expect(await output("b1")).toContain("first=[SECRET:API_TOKEN]");
    expect(await output("b1")).not.toContain(VALUE);
  });

  it("a secret saved while the worker runs reaches its shell at once, a deleted one is gone", async () => {
    expect(
      outcome(await owner.client.call("secrets.set", { agentId, name: "LATE_TOKEN", value: LATE })),
    ).toBe("ok");
    await prompt("again");
    expect(await output("b2")).toContain("late=[SECRET:LATE_TOKEN]");
    expect(outcome(await owner.client.call("secrets.delete", { agentId, name: "API_TOKEN" }))).toBe("ok");
    await prompt("once more");
    expect(await output("b3")).toContain("gone=[]");
    const listed = result<{ entries: Array<{ name: string }>; state: string }>(
      await owner.client.call("secrets.list", { agentId }),
    );
    expect(listed).toMatchObject({ state: "ok", entries: [{ name: "LATE_TOKEN" }] });
    expect(JSON.stringify(listed)).not.toContain(LATE);
  });

  it("an agent that runs without the sandbox never gets its vault (W5-R17)", async () => {
    const bolt = result<{ id: string }>(
      await owner.client.call("agents.create", {
        input: { name: "Bolt", preset: "full", mode: "full-access", sandbox: { required: false } } as never,
      }),
    ).id;
    expect(
      outcome(await owner.client.call("secrets.set", { agentId: bolt, name: "BOLT_TOKEN", value: BOLT })),
    ).toBe("ok");
    // The only way to tell, from outside, that the vault was asked for: its file is made unreadable, and an unreadable
    // vault that is read is logged (once per agent). A launch that passed the vault to this worker would log it.
    const vaultRoot = join(t.home, "secrets", "vault");
    const [ownerDir] = readdirSync(vaultRoot).filter((name) => name !== "key");
    const file = join(vaultRoot, ownerDir ?? "", `agent-${bolt}.json`);
    chmodSync(file, 0o644);
    try {
      sessionId = result<{ sessionId: string }>(
        await owner.client.call("agents.openThread", { agentId: bolt }),
      ).sessionId;
      expect((await owner.client.call("subscribe.session", { sessionId })).ok).toBe(true);
      await prompt("go");
      expect(logs.lines.filter((line) => line.msg === "vault_unreadable" && line.agentId === bolt)).toEqual(
        [],
      );
    } finally {
      chmodSync(file, 0o600);
    }
    // Each worker walks the script from its first step: this thread ran `b1` with its stored secret out of its shell.
    expect(await output("b1")).toContain("bolt=[]");
    expect(await output("b1")).not.toContain(BOLT);
  });

  it("a token cannot list, set or delete", async () => {
    const minted = await owner.client.call("auth.tokens.create", {
      name: "ci",
      permissions: ["agents:read", "sessions:read"] as never,
      expiresInDays: 7,
    });
    const bot = await t.connectBearer(result<{ value: string }>(minted).value);
    try {
      expect(outcome(await bot.call("secrets.list", { agentId }))).toBe("forbidden");
      expect(outcome(await bot.call("secrets.set", { agentId, name: "X_TOKEN", value: "v" }))).toBe(
        "forbidden",
      );
      expect(outcome(await bot.call("secrets.delete", { agentId, name: "LATE_TOKEN" }))).toBe("forbidden");
    } finally {
      bot.close();
    }
  });

  it("refuses a hijack name and another agent, and keeps the files private", async () => {
    expect(outcome(await owner.client.call("secrets.set", { agentId, name: "LD_PRELOAD", value: "x" }))).toBe(
      "bad_request",
    );
    expect(
      outcome(await owner.client.call("secrets.set", { agentId: "ghost-0000", name: "X_TOKEN", value: "x" })),
    ).toBe("not_found");
    const vault = join(t.home, "secrets", "vault");
    expect(statSync(vault).mode & 0o777).toBe(0o700);
    expect(statSync(join(vault, "key")).mode & 0o777).toBe(0o600);
    const [ownerDir] = readdirSync(vault).filter((name) => name !== "key");
    expect(statSync(join(vault, ownerDir ?? "")).mode & 0o777).toBe(0o700);
    const files = readdirSync(join(vault, ownerDir ?? ""));
    expect(files).toHaveLength(2);
    expect(files).toContain(`agent-${agentId}.json`);
    expect(statSync(join(vault, ownerDir ?? "", files[0] ?? "")).mode & 0o777).toBe(0o600);
  });

  it("RT-03: the receipt holds the selector hash of agent and name, and no hash of the value", () => {
    const table = rows<{ method: string; result: string }>(
      t.home,
      "SELECT method, result FROM receipts WHERE method LIKE 'secrets.%'",
    );
    const dump = JSON.stringify(table);
    expect(table.some((row) => row.method === "secrets.set")).toBe(true);
    for (const value of [VALUE, LATE]) {
      expect(dump).not.toContain(sha256Hex(canonicalJson({ value })));
      expect(dump).not.toContain(sha256Hex(value));
    }
    expect(dump).not.toContain(sha256Hex(canonicalJson({ agentId, name: "API_TOKEN", value: VALUE })));
    expect(dump).toContain(sha256Hex(canonicalJson({ agentId, name: "API_TOKEN" })));
  });

  it("the audit rows name the change and never the value", () => {
    const audit = rows<Record<string, unknown>>(t.home, "SELECT * FROM audit WHERE reason LIKE 'secret %'");
    expect(audit.map((row) => row.reason)).toEqual([
      "secret set",
      "secret set",
      "secret delete",
      "secret set",
    ]);
    expect(audit.map((row) => JSON.parse(String(row.detail)))).toEqual([
      { agentId, name: "API_TOKEN", op: "set" },
      { agentId, name: "LATE_TOKEN", op: "set" },
      { agentId, name: "API_TOKEN", op: "delete" },
      { agentId: expect.any(String), name: "BOLT_TOKEN", op: "set" },
    ]);
    expect(JSON.stringify(audit)).not.toContain(VALUE);
  });

  it("a planted value is in no log, event, table or file outside the sealed vault (M11R58 style)", () => {
    const tracked = [
      JSON.stringify(logs.lines),
      JSON.stringify(owner.client.events),
      JSON.stringify(rows(t.home, "SELECT * FROM audit")),
      JSON.stringify(rows(t.home, "SELECT * FROM receipts")),
    ].join("\n");
    for (const value of [VALUE, LATE, BOLT]) {
      expect(tracked).not.toContain(value);
      expect(tracked).not.toContain(Buffer.from(value).toString("base64"));
    }
    const hits: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.isFile() && !path.startsWith(join(t.home, "secrets", "vault"))) {
          const bytes = readFileSync(path);
          if (bytes.includes(VALUE) || bytes.includes(LATE) || bytes.includes(BOLT))
            hits.push(relative(t.root, path));
        }
      }
    };
    scan(t.root);
    expect(hits).toEqual([]);
    expect(existsSync(join(t.home, "secrets", "vault", "key"))).toBe(true);
  });
});
