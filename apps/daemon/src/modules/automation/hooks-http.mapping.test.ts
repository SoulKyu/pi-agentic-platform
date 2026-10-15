import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TriggerInput } from "@pap/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import type { FireInput, FireResult } from "./fire.ts";
import { newHookSecret, HOOK_BODY_MAX_BYTES } from "./hook-auth.ts";
import type { HookJournal } from "./hook-journal.ts";
import { mountHookRoute } from "./hooks-http.ts";
import { writeTriggerSecret } from "./trigger-secrets.ts";
import type { TriggerRecord } from "./triggers.ts";
import { createHmac } from "node:crypto";

const A = "0b3c1f6e-6a1d-4c11-8d52-5d8e9a7f3b21";
const H = "1c4d2a7f-7b2e-4d22-9e63-6e9fab8a4c32";

let dir: string;
let clock: FakeClock;
let secrets: Record<string, string>;
let fired: FireInput[];
let seen: Set<string>;
let journal: Array<[string, string, string | null]>;
let app: Hono;

function trigger(
  id: string,
  auth: "secret" | "hmac",
  format: "raw" | "alertmanager" | "grafana",
): TriggerRecord {
  const input = TriggerInput.parse({
    name: "Alert hook",
    source: { type: "webhook", auth, format },
    execution: { cwd: "/tmp" },
    prompt: "Alert: {{payload}}",
  });
  return {
    id,
    ownerId: "u1",
    name: "Alert hook",
    enabled: true,
    sourceType: "webhook",
    input,
    cwd: "/tmp",
    projectId: null,
    secretRotatedAt: null,
    nextFireAt: null,
    lastFireAt: null,
    lastStartAt: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-hooks-map-"));
  clock = createFakeClock();
  secrets = { [A]: newHookSecret(), [H]: newHookSecret() };
  for (const [id, secret] of Object.entries(secrets)) writeTriggerSecret(dir, id, secret);
  const records = new Map([
    [A, trigger(A, "secret", "alertmanager")],
    [H, trigger(H, "hmac", "raw")],
  ]);
  fired = [];
  seen = new Set();
  journal = [];
  const journalPort: HookJournal = {
    unauthorized: (target, mode) => void journal.push(["unauthorized", target.id, mode]),
    refused: (target, verdict, detail) => void journal.push([verdict, target.id, detail]),
  };
  app = new Hono();
  mountHookRoute(app, {
    clock,
    logger: captureLogger().logger,
    readOnly: false,
    secretsDir: dir,
    find: (id) => records.get(id) ?? null,
    journal: journalPort,
    fire: (_id, _revision, input): FireResult => {
      if (input.dedupKey !== null && seen.has(input.dedupKey)) return { verdict: "dedup" };
      if (input.allResolved) return { verdict: "resolved" };
      if (input.dedupKey !== null) seen.add(input.dedupKey);
      fired.push(input);
      return { verdict: "fired", taskId: `task-${fired.length}` };
    },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const group = (fingerprints: string[], status = "firing") => ({
  version: "4",
  status,
  alerts: fingerprints.map((fingerprint) => ({
    status,
    labels: { alertname: "DiskFull", severity: "critical", instance: fingerprint },
    annotations: { summary: "disk is full" },
    fingerprint,
  })),
});
const asJson = { "content-type": "application/json" };
const bearer = (id: string) => ({ authorization: `Bearer ${secrets[id]}`, ...asJson });
const post = (id: string, headers: Record<string, string>, body: string) =>
  app.request(`/hooks/${id}`, { method: "POST", headers, body });
const alerts = (...fingerprints: string[]) => post(A, bearer(A), JSON.stringify(group(fingerprints)));
const signed = (body: string) => ({
  ...asJson,
  "x-pap-signature-256": `sha256=${createHmac("sha256", secrets[H] ?? "")
    .update(body)
    .digest("hex")}`,
});

describe("the hook route: mapping, dedup, rate and journal lines", () => {
  it("passes the mapped lines fenced by format, the alert identity as the dedup key and the first line as detail", async () => {
    const response = await alerts("fp2", "fp1");
    expect(response.status).toBe(202);
    const input = fired[0];
    expect(input?.payload?.source).toBe("alertmanager");
    expect(input?.payload?.text.split("\n")).toHaveLength(2);
    expect(input?.dedupKey).toBe(createHash("sha256").update("firing:fp1,fp2").digest("hex"));
    expect(input?.detail).toBe("firing critical DiskFull fp2: disk is full");
    expect(input?.allResolved).toBe(false);
  });

  it("answers 409 resolved for an all-resolved group, and 409 dedup for the same group twice with one task", async () => {
    const resolved = await post(A, bearer(A), JSON.stringify(group(["fp1"], "resolved")));
    expect([resolved.status, await resolved.json()]).toEqual([409, { reason: "resolved" }]);
    expect((await alerts("fp1")).status).toBe(202);
    const again = await alerts("fp1");
    expect([again.status, await again.json()]).toEqual([409, { reason: "dedup" }]);
    expect(fired).toHaveLength(1);
  });

  it("counts the rate on authenticated deliveries whatever the verdict: 59 dedup refusals, then 429 rate", async () => {
    for (let index = 0; index < 60; index += 1) await alerts("fp1");
    expect(fired).toHaveLength(1);
    const limited = await alerts("brand-new");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ reason: "rate" });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("connection")).toBe("close");
    expect(journal.at(-1)).toEqual(["throttle", A, null]);
    expect(fired).toHaveLength(1);
    await clock.advance(60_000);
    expect((await alerts("brand-new")).status).toBe(202);
  });

  it("lets exactly 60 of 70 concurrent authenticated deliveries through (two at a time: the trigger's slots)", async () => {
    const statuses: number[] = [];
    for (let wave = 0; wave < 35; wave += 1) {
      const pair = await Promise.all([alerts(`fp${wave}a`), alerts(`fp${wave}b`)]);
      statuses.push(...pair.map((response) => response.status));
    }
    expect(statuses.filter((status) => status === 202)).toHaveLength(60);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10);
    expect(fired).toHaveLength(60);
  });

  it("does not count unauthenticated attempts in the rate", async () => {
    for (let index = 0; index < 5; index += 1)
      await post(A, { authorization: "Bearer wrong", ...asJson }, "{}");
    for (let index = 0; index < 60; index += 1) expect((await alerts(`fp${index}`)).status).toBe(202);
  });

  it("answers 400 bad_payload with a journal line for unreadable JSON, and counts it in the rate", async () => {
    const response = await post(A, bearer(A), '{"alerts": [');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "bad_request" } });
    expect(journal).toEqual([["bad_payload", A, null]]);
    expect(fired).toEqual([]);
    for (let index = 0; index < 59; index += 1) await post(A, bearer(A), "{");
    expect((await post(A, bearer(A), "{")).status).toBe(429);
  });

  it("decodes non-JSON content as text, with replacement characters, and unreadable JSON of a raw trigger is 400 too", async () => {
    const text = await post(
      A,
      { authorization: `Bearer ${secrets[A]}`, "content-type": "text/plain" },
      "{not json",
    );
    expect(text.status).toBe(202);
    expect(fired[0]?.payload?.text).toBe("{not json");
    const body = '{"x":';
    const bad = await post(H, signed(body), body);
    expect(bad.status).toBe(400);
    const ok = JSON.stringify({ text: "deploy failed" });
    expect((await post(H, signed(ok), ok)).status).toBe(202);
    expect(fired[1]?.payload).toEqual({ text: "deploy failed", source: "webhook" });
  });

  it("judges authentication before the body is decoded: a bad signature on bad JSON is 401, never 400", async () => {
    const response = await post(H, { ...asJson, "x-pap-signature-256": `sha256=${"0".repeat(64)}` }, "{");
    expect(response.status).toBe(401);
    expect(journal).toEqual([["unauthorized", H, "hmac"]]);
  });

  it("journals a wrong secret as unauthorized in secret mode", async () => {
    await post(A, { authorization: "Bearer nope", ...asJson }, "{}");
    expect(journal).toEqual([["unauthorized", A, "secret"]]);
  });

  it("survives a hostile alert body within the size cap", async () => {
    const body = JSON.stringify({
      alerts: [{ labels: Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`k${i}`, "v"])) }],
    });
    expect(body.length).toBeLessThan(HOOK_BODY_MAX_BYTES);
    expect((await post(A, bearer(A), `${"[".repeat(20_000)}${"]".repeat(20_000)}`)).status).toBe(202);
    expect((await post(A, bearer(A), body)).status).toBe(202);
  });
});
