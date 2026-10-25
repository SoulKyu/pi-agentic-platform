import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventFrame } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../kernel/ids.ts";
import { canonicalJson } from "../../kernel/ws/dispatcher.ts";
import { openOwner, outcome, type Owner, result, rows } from "../../security/testing/automation-bed.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import { writeScript } from "../../security/testing/agent-bed.ts";

// The vault through a real daemon and a real worker on the process-backend VM (ADR 0081). The process backend cannot run the
// root VM shell (`vm-shell/ops.vault.test.ts` proves what the shell is given), so the agent "prints" a value with a scripted
// text step: a value its worker holds comes back as `[SECRET:NAME]`, one it does not hold comes back raw.
const VALUE = "planted-vault-value-8e2c41b7d9";
const LATE = "late-vault-value-4a7f10c2e6";

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
  t = await startTestDaemon(
    { steps: [{ text: "placeholder" }] },
    { vm: true, deps: { logger: logs.logger } },
  );
  owner = await openOwner(t);
});
afterAll(async () => {
  owner?.client.close();
  await t?.stop();
});

/** What the agent typed during the last prompt, as the stream delivered it. */
let typed = "";
async function prompt(text: string): Promise<void> {
  const client = owner.client;
  const from = client.events.length;
  expect((await client.call("sessions.prompt", { sessionId, text })).ok).toBe(true);
  await client.waitForEvent(statusAfter(client, "running", from));
  await client.waitForEvent(statusAfter(client, "idle", from));
  typed = client.events
    .slice(from)
    .map(
      (frame) =>
        (frame.event as { event?: { assistantMessageEvent?: { type?: string; delta?: string } } }).event,
    )
    .filter((event) => /_delta$/.test(event?.assistantMessageEvent?.type ?? ""))
    .map((event) => event?.assistantMessageEvent?.delta ?? "")
    .join("");
}

describe("the vault through a real daemon and a real worker in the process-backend VM", () => {
  it("a browser sets a secret; the worker holds it from its init, and everything the agent prints comes back redacted", async () => {
    const created = result<{ id: string }>(
      await owner.client.call("agents.create", { input: { name: "Atlas", preset: "full" } as never }),
    );
    agentId = created.id;
    expect(
      outcome(await owner.client.call("secrets.set", { agentId, name: "API_TOKEN", value: VALUE })),
    ).toBe("ok");
    writeScript(t, {
      steps: [{ text: `first=${VALUE}` }, { text: `late=${LATE}` }, { text: `gone=[${VALUE}]` }],
    });
    sessionId = result<{ sessionId: string }>(
      await owner.client.call("agents.openThread", { agentId }),
    ).sessionId;
    expect((await owner.client.call("subscribe.session", { sessionId })).ok).toBe(true);
    await prompt("go");
    expect(typed).toContain("first=[SECRET:API_TOKEN]");
    expect(typed).not.toContain(VALUE);
  });

  it("a secret saved while the worker runs reaches it at once, a deleted one is still redacted until the worker exits", async () => {
    expect(
      outcome(await owner.client.call("secrets.set", { agentId, name: "LATE_TOKEN", value: LATE })),
    ).toBe("ok");
    await prompt("again");
    expect(typed).toContain("late=[SECRET:LATE_TOKEN]");
    expect(outcome(await owner.client.call("secrets.delete", { agentId, name: "API_TOKEN" }))).toBe("ok");
    await prompt("once more");
    // A value that leaves stays redacted until the worker exits (the redactor retires it, never forgets it).
    expect(typed).toContain("gone=[[SECRET:API_TOKEN]]");
    const listed = result<{ entries: Array<{ name: string }>; state: string }>(
      await owner.client.call("secrets.list", { agentId }),
    );
    expect(listed).toMatchObject({ state: "ok", entries: [{ name: "LATE_TOKEN" }] });
    expect(JSON.stringify(listed)).not.toContain(LATE);
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
    expect(files).toHaveLength(1);
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
    expect(audit.map((row) => row.reason)).toEqual(["secret set", "secret set", "secret delete"]);
    expect(audit.map((row) => JSON.parse(String(row.detail)))).toEqual([
      { agentId, name: "API_TOKEN", op: "set" },
      { agentId, name: "LATE_TOKEN", op: "set" },
      { agentId, name: "API_TOKEN", op: "delete" },
    ]);
    expect(JSON.stringify(audit)).not.toContain(VALUE);
  });

  it("a planted value is in no log, event, table or file outside the sealed vault (M11R58 style)", async () => {
    // The search index is a cache of Pi's session files (ADR 0013): once the scanner has read the thread's three replies
    // (its debounce, or its 60 s reconcile for a mirror file seen before the row named it), it holds their raw text, the
    // same M5 limit as the session file, and no value anywhere else.
    const searchDb = join(t.home, "search.db");
    const indexed = (sql: string, ...params: string[]): Array<Record<string, unknown>> => {
      const db = new DatabaseSync(searchDb, { readOnly: true });
      try {
        return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      } finally {
        db.close();
      }
    };
    await vi.waitFor(
      () =>
        expect(
          indexed("SELECT id FROM rows WHERE session_id = ? AND role = 'assistant'", sessionId),
        ).toHaveLength(3),
      { timeout: 65_000, interval: 100 },
    );
    const holding = [VALUE, LATE].flatMap((value) =>
      indexed("SELECT session_id, role, text FROM rows WHERE instr(text, ?) > 0 ORDER BY id", value),
    );
    expect(holding).toEqual([
      { session_id: sessionId, role: "assistant", text: `first=${VALUE}` },
      { session_id: sessionId, role: "assistant", text: `gone=[${VALUE}]` },
      { session_id: sessionId, role: "assistant", text: `late=${LATE}` },
    ]);
    const indexRest = JSON.stringify([indexed("SELECT * FROM files"), indexed("SELECT * FROM meta")]);
    const tracked = [
      indexRest,
      JSON.stringify(logs.lines),
      JSON.stringify(owner.client.events),
      JSON.stringify(rows(t.home, "SELECT * FROM audit")),
      JSON.stringify(rows(t.home, "SELECT * FROM receipts")),
    ].join("\n");
    for (const value of [VALUE, LATE]) {
      expect(tracked).not.toContain(value);
      expect(tracked).not.toContain(Buffer.from(value).toString("base64"));
    }
    const hits: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) scan(path);
        // Left out: the sealed vault, the test's own scripts (they type the values), Pi's session files, which keep the
        // model's typed text raw (M5's documented limit; its tool results are redacted), and the search index read above.
        else if (
          entry.isFile() &&
          !path.startsWith(join(t.home, "secrets", "vault")) &&
          !path.startsWith(searchDb) &&
          !path.endsWith("script.json") &&
          !path.endsWith(".jsonl")
        ) {
          const bytes = readFileSync(path);
          if (bytes.includes(VALUE) || bytes.includes(LATE)) hits.push(relative(t.root, path));
        }
      }
    };
    scan(t.root);
    expect(hits).toEqual([]);
    expect(existsSync(join(t.home, "secrets", "vault", "key"))).toBe(true);
  }, 90_000);
});
