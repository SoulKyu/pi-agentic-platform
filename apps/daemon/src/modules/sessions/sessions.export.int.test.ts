import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ResponseFrame } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { httpRequest } from "../../testing/http-client.ts";
import type { TestClient } from "../../testing/ws-client.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";

let t: TestDaemon | undefined;
let client: TestClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await t?.stop();
  t = undefined;
});

const resultOf = <T>(frame: ResponseFrame): T => {
  if (!frame.ok) throw new Error(`call failed: ${frame.error.code}`);
  return frame.result as T;
};

it("exports a session and serves it once as an attachment to its owner", async () => {
  t = await startTestDaemon({ steps: [{ text: "exported reply" }] });
  const cookie = await t.login();
  client = await t.connect(cookie);
  const { sessionId } = resultOf<{ sessionId: string }>(await client.call("sessions.create", { cwd: t.cwd }));
  await client.call("subscribe.session", { sessionId });
  await client.call("sessions.prompt", { sessionId, text: "export me" });
  await client.waitForEvent(
    (frame) => (frame.event as { kind?: string; status?: string }).status === "idle" && frame.seq > 2,
    20_000,
  );
  const { url } = resultOf<{ url: string }>(await client.call("sessions.exportHtml", { sessionId }));
  expect(url).toMatch(new RegExp(`^/api/sessions/${sessionId}/export/[A-Za-z0-9_-]{43}$`));

  expect((await httpRequest(`${t.base}${url}`)).status).toBe(401);
  const reply = await httpRequest(`${t.base}${url}`, { headers: { cookie } });
  expect(reply.status).toBe(200);
  expect(reply.headers["content-disposition"]).toBe('attachment; filename="pap-session.html"');
  expect(reply.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  expect(reply.headers["cache-control"]).toBe("no-store");
  expect(reply.headers["referrer-policy"]).toBe("no-referrer");
  expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(reply.headers["content-length"]).toBe(String(Buffer.byteLength(reply.body)));
  // Pi puts the session in the page as base64 JSON.
  const data = /<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/.exec(
    reply.body,
  );
  expect(Buffer.from(data?.[1] ?? "", "base64").toString("utf8")).toContain("exported reply");
  // Pi 1.1.0's real export, patched (owner M2-Q7): no recursive helper left, and the iterative ones are in.
  expect(reply.body).not.toContain("node.children.forEach(sortChildren)");
  expect(reply.body).not.toContain("node.children.forEach(mapNodes)");
  expect(reply.body).not.toContain("if (markActive(child)) has = true;");
  expect(reply.body).toContain("const pending = [root];");
  // Single use, and the file is gone.
  expect((await httpRequest(`${t.base}${url}`, { headers: { cookie } })).status).toBe(404);
  const exportsDir = join(t.home, "exports");
  expect(existsSync(exportsDir)).toBe(true);
  expect(readdirSync(exportsDir)).toEqual([]);
});
