import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

let t: TestDaemon | undefined;
let client: TestClient | undefined;
afterEach(async () => {
  client?.close();
  await t?.stop();
  t = undefined;
  client = undefined;
});

function upload(daemon: TestDaemon, cookie: string, sessionId: string, name: string, body: Buffer) {
  return new Promise<{ id: string; kind: string }>((resolve, reject) => {
    const req = request(
      `${daemon.base}/upload?sessionId=${sessionId}&name=${name}`,
      {
        method: "POST",
        headers: { origin: daemon.origin, cookie, "content-length": String(body.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 201) return reject(new Error(`upload ${res.statusCode}`));
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; kind: string });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const jsonlFiles = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? jsonlFiles(join(dir, entry.name))
          : entry.name.endsWith(".jsonl")
            ? [join(dir, entry.name)]
            : [],
      );
const userMessages = (daemon: TestDaemon) =>
  jsonlFiles(join(daemon.root, "agent", "sessions"))
    .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as { message?: { role: string; content: unknown } })
    .filter((entry) => entry.message?.role === "user")
    .map((entry) => entry.message?.content as Array<{ type: string; text?: string; mimeType?: string }>);

async function boot(clock?: FakeClock) {
  const captured = captureLogger();
  t = await startTestDaemon(
    { steps: [{ text: "ok" }, { text: "ok again" }] },
    { deps: { logger: captured.logger, ...(clock ? { clock } : {}) } },
  );
  const cookie = await t.login();
  client = await t.connect(cookie);
  const created = await client.call("sessions.create", { cwd: t.cwd });
  if (!created.ok) throw new Error("create failed");
  const sessionId = (created.result as { sessionId: string }).sessionId;
  return { daemon: t, cookie, client, sessionId, lines: captured.lines };
}

it("sends an image to Pi and a file as a path, claims once on a replay, and removes the pending image", async () => {
  const { daemon, cookie, client: c, sessionId, lines } = await boot();
  const image = await upload(daemon, cookie, sessionId, "shot.png", PNG);
  const pdf = await upload(daemon, cookie, sessionId, "report.pdf", PDF);
  expect(image.kind).toBe("image");
  const pendingPath = join(daemon.home, "attachments", "pending", image.id);
  expect(existsSync(pendingPath)).toBe(true);

  const params = { sessionId, text: "see these", attachments: [image.id, pdf.id] };
  const first = await c.call("sessions.prompt", params, 30_000, "cmd-replay-0001");
  expect(first).toMatchObject({ ok: true, result: { disposition: "started" } });
  await vi.waitFor(() => expect(userMessages(daemon)).toHaveLength(1), { timeout: 20_000 });

  const [content] = userMessages(daemon);
  const pdfPath = join(daemon.home, "attachments", sessionId, pdf.id, "report.pdf");
  expect(content?.filter((part) => part.type === "image").map((part) => part.mimeType)).toEqual([
    "image/png",
  ]);
  expect(content?.find((part) => part.type === "text")?.text).toBe(
    `see these\n\nAttached files:\n- ${pdfPath}`,
  );
  expect(existsSync(pdfPath)).toBe(true);
  await vi.waitFor(() => expect(existsSync(pendingPath)).toBe(false), { timeout: 5_000 });

  const again = await c.call("sessions.prompt", params, 30_000, "cmd-replay-0001");
  expect(again).toEqual({ ...first, id: again.id });
  expect(lines.filter((line) => line.msg === "attachments_claimed")).toHaveLength(1);
});

it("answers not_found for another session's upload", async () => {
  const { daemon, cookie, client: c, sessionId } = await boot();
  const other = await c.call("sessions.create", { cwd: daemon.cwd });
  if (!other.ok) throw new Error("create failed");
  const otherId = (other.result as { sessionId: string }).sessionId;
  const foreign = await upload(daemon, cookie, otherId, "shot.png", PNG);
  const refused = await c.call("sessions.prompt", { sessionId, text: "x", attachments: [foreign.id] });
  expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(userMessages(daemon)).toEqual([]);
});

it("answers not_found for an upload older than an hour", async () => {
  const clock = createFakeClock();
  const { daemon, cookie, client: c, sessionId } = await boot(clock);
  const image = await upload(daemon, cookie, sessionId, "shot.png", PNG);
  await clock.advance(60 * 60_000 + 1);
  // An hour of the daemon's clock also ran out the old connection's heartbeat: ask again on a fresh one.
  c.close();
  const fresh = await daemon.connect(cookie);
  client = fresh;
  const refused = await fresh.call("sessions.prompt", { sessionId, text: "x", attachments: [image.id] });
  expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(userMessages(daemon)).toEqual([]);
});
