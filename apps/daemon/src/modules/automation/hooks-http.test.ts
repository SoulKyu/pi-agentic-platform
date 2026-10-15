import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TriggerInput } from "@pap/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import type { FireInput, FireResult } from "./fire.ts";
import { HOOK_BODY_MAX_BYTES, newHookSecret } from "./hook-auth.ts";
import { mountHookRoute } from "./hooks-http.ts";
import type { TriggerRecord } from "./triggers.ts";
import { writeTriggerSecret } from "./trigger-secrets.ts";

const A = "0b3c1f6e-6a1d-4c11-8d52-5d8e9a7f3b21";
const B = "1c4d2a7f-7b2e-4d22-9e63-6e9fab8a4c32";
const GONE = "2d5e3b80-8c3f-4e33-8f74-7fa0bc9b5d43";

let dir: string;
let clock: FakeClock;
let secrets: Record<string, string>;
let records: Map<string, TriggerRecord>;
let fired: Array<{ id: string; revision: number; input: FireInput }>;
let order: string[];
let verdict: () => FireResult;
let lines: Array<Record<string, unknown>>;
let readOnly: boolean;
let app: Hono;

function trigger(id: string, auth: "secret" | "hmac", extra: Partial<TriggerRecord> = {}): TriggerRecord {
  const input = TriggerInput.parse({
    name: "Alert hook",
    source: { type: "webhook", auth },
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
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-hooks-"));
  clock = createFakeClock();
  secrets = { [A]: newHookSecret(), [B]: newHookSecret() };
  for (const [id, secret] of Object.entries(secrets)) writeTriggerSecret(dir, id, secret);
  records = new Map([
    [A, trigger(A, "hmac")],
    [B, trigger(B, "secret")],
  ]);
  fired = [];
  order = [];
  readOnly = false;
  verdict = () => ({ verdict: "fired", taskId: "task-1" });
  const captured = captureLogger();
  lines = captured.lines;
  app = new Hono();
  mountHookRoute(app, {
    clock,
    logger: captured.logger,
    get readOnly() {
      return readOnly;
    },
    secretsDir: dir,
    find: (id) => records.get(id) ?? null,
    fire: (id, revision, input) => {
      fired.push({ id, revision, input });
      order.push("fire");
      return verdict();
    },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Body = string | ReadableStream<Uint8Array>;
const sign = (id: string, body: string): string =>
  `sha256=${createHmac("sha256", secrets[id] ?? "")
    .update(body)
    .digest("hex")}`;
const post = async (id: string, headers: Record<string, string>, body: Body = "{}"): Promise<Response> =>
  app.request(`/hooks/${id}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
const asSecret = (id: string, secret = secrets[id] ?? "") => ({ authorization: `Bearer ${secret}` });
const asHmac = (id: string, body = "{}") => ({ "x-pap-signature-256": sign(id, body) });
const trap = (): { stream: ReadableStream<Uint8Array>; pulled: () => boolean } => {
  let pulled = false;
  return {
    stream: new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
          throw new Error("the body was read");
        },
      },
      { highWaterMark: 0 },
    ),
    pulled: () => pulled,
  };
};
const stalled = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }, { highWaterMark: 0 });

describe("the hook route", () => {
  it("answers 202 {taskId} for a good secret, after the fire, with the saved revision and a fenced raw payload", async () => {
    const response = await post(B, asSecret(B), '{"alert":"disk"}');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ taskId: "task-1" });
    expect(order).toEqual(["fire"]);
    expect(fired[0]).toMatchObject({
      id: B,
      revision: 3,
      input: { ownerId: "u1", source: "webhook", gated: true, gates: { exemptDisabled: false } },
    });
    expect(fired[0]?.input.payload?.text).toBe('{"alert":"disk"}');
  });
  it("accepts X-Pap-Secret and a good HMAC", async () => {
    expect((await post(B, { "x-pap-secret": secrets[B] ?? "" })).status).toBe(202);
    expect((await post(A, asHmac(A))).status).toBe(202);
  });
  it("sets no-store, no cookie, and connection: close on every answer but 202", async () => {
    const ok = await post(B, asSecret(B));
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("set-cookie")).toBeNull();
    expect(ok.headers.get("connection")).not.toBe("close");
    const refusals = [
      await post(B, {}),
      await post(GONE, {}),
      await post(B, asSecret(B), "x".repeat(HOOK_BODY_MAX_BYTES + 1)),
    ];
    for (const refusal of refusals) {
      expect(refusal.headers.get("connection")).toBe("close");
      expect(refusal.headers.get("cache-control")).toBe("no-store");
      expect(refusal.headers.get("set-cookie")).toBeNull();
    }
  });
  it("answers 404 for an unknown id, a trigger that is not a webhook and an unreadable config", async () => {
    const manual = TriggerInput.parse({
      name: "Manual",
      source: { type: "manual" },
      execution: { cwd: "/tmp" },
      prompt: "p",
    });
    records.set(GONE, trigger(GONE, "secret", { sourceType: "manual", input: manual }));
    const unreadable = "3e6f4c91-9d40-4f44-8085-80b1cdac6e54";
    records.set(unreadable, trigger(unreadable, "secret", { input: null }));
    for (const id of ["4f705da2-ae51-4055-9196-91c2deadbf65", GONE, unreadable]) {
      const response = await post(id, {});
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found" } });
    }
  });
  it("answers 404 for a path that is not the exact hook path", async () => {
    expect((await app.request(`/hooks/${A.toUpperCase()}`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`/hooks/${A}/x`, { method: "POST" })).status).toBe(404);
  });
  it("answers 503 read_only before anything else, without reading the body", async () => {
    readOnly = true;
    const body = trap();
    const response = await post(B, {}, body.stream);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "read_only" } });
    expect(response.headers.get("connection")).toBe("close");
    expect(body.pulled()).toBe(false);
  });
  it("answers 401 when the secret file is missing", async () => {
    rmSync(join(dir, `${B}.key`));
    expect((await post(B, asSecret(B))).status).toBe(401);
  });
  it("answers 401 for a wrong, missing or Basic secret before the body is read", async () => {
    for (const headers of [{}, asSecret(B, "pwh_wrong"), { authorization: "Basic dXNlcjpwdw==" }]) {
      const body = trap();
      const response = await post(B, headers, body.stream);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "unauthenticated" } });
      expect(body.pulled()).toBe(false);
    }
    expect(fired).toEqual([]);
  });
  it("answers 413 for a declared length over 64 KiB without reading the body", async () => {
    const body = trap();
    const response = await post(B, { ...asSecret(B), "content-length": "65537" }, body.stream);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "payload_too_large" } });
    expect(body.pulled()).toBe(false);
  });
  it("counts the body as it streams: 64 KiB passes, one byte more is 413", async () => {
    expect((await post(B, asSecret(B), "x".repeat(HOOK_BODY_MAX_BYTES))).status).toBe(202);
    expect((await post(B, asSecret(B), "x".repeat(HOOK_BODY_MAX_BYTES + 1))).status).toBe(413);
  });
  it("answers 401 for a bad or missing signature, after the body", async () => {
    expect((await post(A, {}, "{}")).status).toBe(401);
    expect((await post(A, asHmac(A, "{}"), '{"tampered":1}')).status).toBe(401);
    expect(fired).toEqual([]);
  });
  it("keeps the secret out of every answer and every log line", async () => {
    const responses = [
      await post(B, asSecret(B, "pwh_wrong")),
      await post(B, asSecret(B)),
      await post(A, {}),
    ];
    const text = JSON.stringify(lines) + (await Promise.all(responses.map((r) => r.text()))).join("");
    for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
    expect(text).not.toContain("pwh_wrong");
  });

  it("is not told a refusal by a rotated key: the old secret stops working at once", async () => {
    const old = secrets[B] ?? "";
    secrets[B] = newHookSecret();
    writeTriggerSecret(dir, B, secrets[B]);
    expect((await post(B, asSecret(B, old))).status).toBe(401);
    expect((await post(B, asSecret(B))).status).toBe(202);
  });
});

describe("the fire verdicts", () => {
  const cases: Array<[FireResult, number, unknown, string | null]> = [
    [{ verdict: "disabled" }, 409, { reason: "disabled" }, null],
    [{ verdict: "paused" }, 409, { reason: "paused" }, null],
    [{ verdict: "resolved" }, 409, { reason: "resolved" }, null],
    [{ verdict: "budget" }, 409, { reason: "budget" }, null],
    [{ verdict: "dedup" }, 409, { reason: "dedup" }, null],
    [{ verdict: "queue_full" }, 429, { reason: "queue_full" }, "60"],
    [{ verdict: "throttle" }, 429, { reason: "rate" }, "60"],
    [{ verdict: "error", detail: "changed" }, 429, { reason: "changed" }, "1"],
    [{ verdict: "error", detail: "prompt_too_large" }, 413, { error: { code: "payload_too_large" } }, null],
  ];
  it.each(cases)("maps %j to %i", async (result, status, body, retryAfter) => {
    verdict = () => result;
    const response = await post(B, asSecret(B));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("retry-after")).toBe(retryAfter);
    expect(response.headers.get("connection")).toBe("close");
  });
  it("answers a disabled trigger 409 only after authentication", async () => {
    verdict = () => ({ verdict: "disabled" });
    expect((await post(B, {})).status).toBe(401);
    expect((await post(B, asSecret(B))).status).toBe(409);
  });
  it("answers 500 internal with connection: close and no-store when the route itself throws", async () => {
    vi.spyOn(records, "get").mockImplementation(() => {
      throw new Error("boom");
    });
    const response = await post(B, asSecret(B));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal" } });
    expect(response.headers.get("connection")).toBe("close");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(lines.some((line) => line.msg === "hook_failed")).toBe(true);
  });
  it("answers 500 internal and logs when the fire throws", async () => {
    verdict = () => {
      throw new Error("boom");
    };
    const response = await post(B, asSecret(B));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal" } });
    expect(response.headers.get("connection")).toBe("close");
    expect(lines.some((line) => line.msg === "hook_fire_failed")).toBe(true);
  });
});

describe("the failure backoff (RT-01)", () => {
  it("lets the right secret through after 10 bad ones, and answers a bad one 429 for 60 s", async () => {
    for (let i = 0; i < 10; i++) expect((await post(B, asSecret(B, `pwh_bad${i}`))).status).toBe(401);
    const blocked = await post(B, asSecret(B, "pwh_bad"));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ reason: "backoff" });
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(blocked.headers.get("connection")).toBe("close");
    expect((await post(B, asSecret(B))).status).toBe(202);
    await clock.advance(60_000);
    expect((await post(B, asSecret(B, "pwh_bad"))).status).toBe(401);
  });
  it("judges an hmac delivery after its body: a good signature passes while blocked", async () => {
    for (let i = 0; i < 10; i++) await post(A, {}, "{}");
    expect((await post(A, {}, "{}")).status).toBe(429);
    expect((await post(A, asHmac(A))).status).toBe(202);
  });
  it("counts unknown ids on one shared state that never touches a real trigger", async () => {
    for (let i = 0; i < 12; i++) expect((await post(GONE, {})).status).toBe(404);
    expect((await post(B, asSecret(B, "pwh_bad"))).status).toBe(401);
    expect(lines.filter((line) => line.msg === "hook_unknown_flood")).toHaveLength(1);
  });
});

describe("the body pools (RT-01)", () => {
  it("holds 2 stalled hmac bodies per trigger, refuses the rest 503, and still serves a secret trigger", async () => {
    const answers: Response[] = [];
    const pending = Array.from({ length: 8 }, () => post(A, {}, stalled()).then((r) => answers.push(r)));
    await vi.waitFor(() => expect(answers).toHaveLength(6), { timeout: 5_000 });
    expect(answers.map((r) => r.status)).toEqual(Array(6).fill(503));
    expect(await answers[0]?.json()).toEqual({ error: { code: "capacity" } });
    expect(answers[0]?.headers.get("connection")).toBe("close");
    expect((await post(A, {}, stalled())).status).toBe(503);
    expect((await post(B, asSecret(B))).status).toBe(202);
    await clock.advance(10_000);
    await Promise.all(pending);
    expect(answers.slice(6).map((r) => r.status)).toEqual([400, 400]);
  });
  it("keeps the authenticated pool out of reach of a full unauthenticated pool", async () => {
    const others = [
      "5a816eb3-bf62-4166-a2a7-a2d3efc0c076",
      "6b927fc4-c073-4277-b3b8-b3e4f0d1d187",
      "7ca30fd5-d184-4388-84c9-c4f501e2e298",
    ];
    for (const id of others) {
      records.set(id, trigger(id, "hmac"));
      writeTriggerSecret(dir, id, newHookSecret());
    }
    const ids = [A, ...others];
    const pending = ids.flatMap((id) => [post(id, {}, stalled()), post(id, {}, stalled())]);
    await clock.advance(0);
    expect((await post(A, {}, stalled())).status).toBe(503);
    expect((await post(others[0] ?? "", {}, stalled())).status).toBe(503);
    expect((await post(B, asSecret(B))).status).toBe(202);
    await clock.advance(10_000);
    await Promise.all(pending);
  });
  it("gives a secret trigger 2 concurrent reads and the authenticated pool 4", async () => {
    const pending = [post(B, asSecret(B), stalled()), post(B, asSecret(B), stalled())];
    await clock.advance(0);
    expect((await post(B, asSecret(B), stalled())).status).toBe(503);
    await clock.advance(10_000);
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([400, 400]);
  });
  it("frees the slot when the read ends", async () => {
    for (let i = 0; i < 5; i++) expect((await post(A, asHmac(A))).status).toBe(202);
  });
});
