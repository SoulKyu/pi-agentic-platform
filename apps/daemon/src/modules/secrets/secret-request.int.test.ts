import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { EventFrame } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../kernel/ids.ts";
import { canonicalJson } from "../../kernel/ws/dispatcher.ts";
import { openOwner, outcome, type Owner, result, rows } from "../../security/testing/automation-bed.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";

// `secret.request` through a real daemon and a real worker on the process-backend VM (ADR 0081). The process backend cannot run
// the root VM shell (`vm-shell/ops.vault.test.ts` proves a one-use value reaches the first command that names it), so the
// agent "prints" a value with a scripted text step: a value its worker holds comes back as `[SECRET:NAME]`.
const ONCE = "planted-once-value-3f9a61c2d8";
const SAVED = "planted-saved-value-7b04e5a9c1";
const DECLINED = "planted-declined-value-2d6c88f013";
const NEVER = "planted-token-value-9e1f4b7a30";
const call = (name: string, id: string) => ({
  toolCalls: [{ name: "secret_request", args: { name, reason: "to read the dashboards" }, id }],
});

type StreamEvent = { kind?: string; status?: string };
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
    {
      steps: [
        // Prompt 1: one use.
        call("GRAFANA_TOKEN", "sr1"),
        { text: `first=${ONCE}` },
        // Prompt 2: the vault.
        call("SAVED_TOKEN", "sr2"),
        { text: `saved=${SAVED}` },
        // Prompt 3: declined.
        call("DECLINED_TOKEN", "sr3"),
        { text: "three" },
      ],
    },
    { vm: true, deps: { logger: logs.logger } },
  );
  owner = await openOwner(t);
});
afterAll(async () => {
  owner?.client.close();
  await t?.stop();
});

const pending = () =>
  rows<{ id: string; title: string; kind: string }>(
    t.home,
    "SELECT id, title, kind FROM agent_requests WHERE state = 'pending'",
  );
const waitForRequest = async (): Promise<string> => {
  await vi.waitFor(() => expect(pending()).toHaveLength(1), { timeout: 30_000 });
  return pending()[0]?.id ?? "";
};
/** What the agent typed during the last run, as the stream delivered it. */
let typed = "";
const output = async (toolCallId: string): Promise<string> =>
  result<{ text: string }>(await owner.client.call("sessions.toolOutput", { sessionId, toolCallId })).text;

/** Sends the prompt, lets `answer` act on the request that opens, then waits for the run to end. */
async function run(text: string, answer: (requestId: string) => Promise<void>): Promise<void> {
  const client = owner.client;
  const from = client.events.length;
  expect((await client.call("sessions.prompt", { sessionId, text })).ok).toBe(true);
  await client.waitForEvent(statusAfter(client, "running", from));
  await answer(await waitForRequest());
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

describe("secret.request through a real daemon and a real worker in the process-backend VM", () => {
  it("opens a request card and an Inbox item; 'use once' gives the worker the value and the agent a ref", async () => {
    agentId = result<{ id: string }>(
      await owner.client.call("agents.create", { input: { name: "Atlas", preset: "full" } as never }),
    ).id;
    sessionId = result<{ sessionId: string }>(
      await owner.client.call("agents.openThread", { agentId }),
    ).sessionId;
    expect((await owner.client.call("subscribe.session", { sessionId })).ok).toBe(true);
    expect((await owner.client.call("subscribe.agents", {})).ok).toBe(true);
    await run("go", async (requestId) => {
      expect(pending()[0]).toMatchObject({ title: "GRAFANA_TOKEN", kind: "secret" });
      const item = rows<{ kind: string; to_handle: number; resolved_at: number | null }>(
        t.home,
        "SELECT kind, to_handle, resolved_at FROM inbox_items WHERE ref_id = ?",
        requestId,
      );
      expect(item).toEqual([{ kind: "secret_request", to_handle: 1, resolved_at: null }]);
      await vi.waitFor(
        () =>
          expect(
            owner.client.events.some((frame) => (frame.event as { kind?: string }).kind === "request"),
          ).toBe(true),
        { timeout: 10_000 },
      );
      // A guessed id and a token's answer do nothing; the card stays open.
      expect(
        outcome(
          await owner.client.call("secrets.answerRequest", { requestId: "nope", value: NEVER, mode: "once" }),
        ),
      ).toBe("not_found");
      expect(
        outcome(await owner.client.call("secrets.answerRequest", { requestId, value: ONCE, mode: "once" })),
      ).toBe("ok");
    });
    const first = await output("sr1");
    expect(first).toMatch(/\(ref secret-ref:[0-9a-f]{32}\)/);
    expect(first).toContain("The owner provided GRAFANA_TOKEN");
    expect(first).toContain("for your next command that uses $GRAFANA_TOKEN");
    expect(first).not.toContain(ONCE);
    // The worker holds the one-use value (the targeted vault_update): what the agent types of it is redacted.
    expect(typed).toContain("first=[SECRET:GRAFANA_TOKEN]");
    expect(typed).not.toContain(ONCE);
    const row = rows<{ state: string; ref_hash: string }>(
      t.home,
      "SELECT state, ref_hash FROM agent_requests WHERE title = 'GRAFANA_TOKEN'",
    )[0];
    expect(row?.state).toBe("answered");
    expect(row?.ref_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.ref_hash).toBe(sha256Hex(/secret-ref:[0-9a-f]{32}/.exec(first)?.[0] ?? ""));
    expect(
      result<{ entries: unknown[] }>(await owner.client.call("secrets.list", { agentId })).entries,
    ).toEqual([]);
  });

  it("'save in the vault' puts the value in the vault, and the worker holds it", async () => {
    await run("again", async (requestId) => {
      expect(
        outcome(await owner.client.call("secrets.answerRequest", { requestId, value: SAVED, mode: "vault" })),
      ).toBe("ok");
    });
    expect(await output("sr2")).toContain("for every command");
    expect(typed).toContain("saved=[SECRET:SAVED_TOKEN]");
    expect(typed).not.toContain(SAVED);
    const listed = result<{ entries: Array<{ name: string }> }>(
      await owner.client.call("secrets.list", { agentId }),
    );
    expect(listed.entries.map((entry) => entry.name)).toEqual(["SAVED_TOKEN"]);
  });

  it("a declined request gives the agent a refusal, and a replayed or guessed answer does nothing", async () => {
    let declined = "";
    await run("last", async (requestId) => {
      declined = requestId;
      expect(outcome(await owner.client.call("secrets.declineRequest", { requestId }))).toBe("ok");
    });
    expect(await output("sr3")).toContain("pap refused secret_request");
    expect(
      outcome(
        await owner.client.call("secrets.answerRequest", {
          requestId: declined,
          value: DECLINED,
          mode: "vault",
        }),
      ),
    ).toBe("not_found");
    const answered = rows<{ id: string }>(t.home, "SELECT id FROM agent_requests WHERE state = 'answered'");
    for (const { id } of answered)
      expect(
        outcome(
          await owner.client.call("secrets.answerRequest", { requestId: id, value: NEVER, mode: "once" }),
        ),
      ).toBe("not_found");
    const ref = /secret-ref:[0-9a-f]{32}/.exec(await output("sr1"))?.[0] ?? "";
    expect(
      outcome(
        await owner.client.call("secrets.answerRequest", { requestId: ref, value: NEVER, mode: "once" }),
      ),
    ).toBe("not_found");
    expect(
      result<{ entries: Array<{ name: string }> }>(
        await owner.client.call("secrets.list", { agentId }),
      ).entries.map((entry) => entry.name),
    ).toEqual(["SAVED_TOKEN"]);
  });

  it("a token cannot answer or decline", async () => {
    const minted = await owner.client.call("auth.tokens.create", {
      name: "ci",
      permissions: ["agents:read", "sessions:read"] as never,
      expiresInDays: 7,
    });
    const bot = await t.connectBearer(result<{ value: string }>(minted).value);
    try {
      expect(
        outcome(await bot.call("secrets.answerRequest", { requestId: "r1", value: NEVER, mode: "once" })),
      ).toBe("forbidden");
      expect(outcome(await bot.call("secrets.declineRequest", { requestId: "r1" }))).toBe("forbidden");
    } finally {
      bot.close();
    }
  });

  it("RT-03: the receipt of an answer holds the selector hash of {requestId, mode}, and none of the value's digests", () => {
    const answerRows = rows<{ method: string; result: string }>(
      t.home,
      "SELECT method, result FROM receipts WHERE method = 'secrets.answerRequest'",
    );
    expect(answerRows).toHaveLength(2);
    const dump = JSON.stringify(answerRows);
    const requestIds = rows<{ id: string; title: string }>(t.home, "SELECT id, title FROM agent_requests");
    const onceId = requestIds.find((row) => row.title === "GRAFANA_TOKEN")?.id ?? "";
    const savedId = requestIds.find((row) => row.title === "SAVED_TOKEN")?.id ?? "";
    expect(dump).toContain(sha256Hex(canonicalJson({ requestId: onceId, mode: "once" })));
    expect(dump).toContain(sha256Hex(canonicalJson({ requestId: savedId, mode: "vault" })));
    for (const [value, requestId, mode] of [
      [ONCE, onceId, "once"],
      [SAVED, savedId, "vault"],
    ] as const) {
      expect(dump).not.toContain(sha256Hex(canonicalJson({ value })));
      expect(dump).not.toContain(sha256Hex(canonicalJson({ requestId, value, mode })));
      expect(dump).not.toContain(sha256Hex(value));
    }
  });

  it("the audit rows name the answer and never the value", () => {
    const audit = rows<{ reason: string; detail: string }>(
      t.home,
      "SELECT reason, detail FROM audit WHERE reason IN ('secret answer', 'secret decline', 'secret set')",
    );
    expect(audit.map((row) => row.reason)).toEqual([
      "secret answer",
      "secret answer",
      "secret set",
      "secret decline",
    ]);
    const answers = audit
      .filter((row) => row.reason === "secret answer")
      .map((row) => JSON.parse(row.detail));
    expect(answers).toEqual([
      { agentId, requestId: expect.any(String), name: "GRAFANA_TOKEN", mode: "once" },
      { agentId, requestId: expect.any(String), name: "SAVED_TOKEN", mode: "vault" },
    ]);
  });

  it("a planted value is in no log, event, table or file outside the sealed vault", () => {
    const tracked = [
      JSON.stringify(logs.lines),
      JSON.stringify(owner.client.events),
      JSON.stringify(rows(t.home, "SELECT * FROM audit")),
      JSON.stringify(rows(t.home, "SELECT * FROM receipts")),
      JSON.stringify(rows(t.home, "SELECT * FROM agent_requests")),
      JSON.stringify(rows(t.home, "SELECT * FROM inbox_items")),
    ].join("\n");
    const values = [ONCE, SAVED, DECLINED, NEVER];
    for (const value of values) {
      expect(tracked).not.toContain(value);
      expect(tracked).not.toContain(Buffer.from(value).toString("base64"));
    }
    const hits: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) scan(path);
        // Left out: the sealed vault, the test's own scripts (they type the values) and Pi's session files, which keep the
        // model's typed text raw (M5's documented limit; its tool results are redacted).
        else if (
          entry.isFile() &&
          !path.startsWith(join(t.home, "secrets", "vault")) &&
          !path.endsWith("script.json") &&
          !path.endsWith(".jsonl")
        ) {
          const bytes = readFileSync(path);
          if (values.some((value) => bytes.includes(value))) hits.push(relative(t.root, path));
        }
      }
    };
    scan(t.root);
    expect(hits).toEqual([]);
  });

  it("the ref salt is a private file beside the key, and no value or ref is in the database", () => {
    const vault = join(t.home, "secrets", "vault");
    expect(readdirSync(vault)).toHaveLength(3);
    expect(readdirSync(vault)).toEqual(expect.arrayContaining(["key", "ref-salt"]));
    expect(readFileSync(join(vault, "ref-salt"))).toHaveLength(32);
    expect(JSON.stringify(rows(t.home, "SELECT * FROM agent_requests"))).not.toMatch(/secret-ref:/);
  });
});
