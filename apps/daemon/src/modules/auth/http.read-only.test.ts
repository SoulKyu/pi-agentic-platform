import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../kernel/db/database.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { createAuthModule } from "./index.ts";
import { createAuthTestBed, PASSWORD, setupTokenOf, type AuthTestBed } from "./testing/fixture.ts";

const ORIGIN = "http://localhost:7777";
const DAY_MS = 24 * 3600 * 1000;

let bed: AuthTestBed;
let readOnly: Db;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => {
  readOnly?.close();
  bed.dispose();
});

// A database written by a newer pap is opened read-only: the owner exists, but nothing can be written.
async function ownerThenReadOnly() {
  const writable = bed.start(ORIGIN);
  const setup = await writable.app.request("/auth/setup", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ token: setupTokenOf(writable.auth), username: "owner", password: PASSWORD }),
  });
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  readOnly = openDatabase(bed.dbPath, { readOnly: true });
  const auth = createAuthModule({
    db: readOnly,
    clock: bed.clock,
    logger: bed.logger,
    publicOrigin: ORIGIN,
    allowedOrigins: new Set([ORIGIN]),
    audit: { append: () => undefined },
  });
  const app = createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot: null,
    logger: bed.logger,
    mount: (a) => auth.mount(a),
    wsProbe: (c) => c.json({}),
  });
  return { app, cookie };
}

describe("auth routes on a read-only database", () => {
  it("answer a sign-in 503 read_only, not a bare 500", async () => {
    const { app } = await ownerThenReadOnly();
    const response = await app.request("/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: PASSWORD }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "read_only" } });
    expect(bed.events("http_error")).toEqual([]);
    expect(bed.events("http_read_only")).toHaveLength(1);
  });

  it("still answer the status check of a session that is due to slide: it just does not slide (R130)", async () => {
    const { app, cookie } = await ownerThenReadOnly();
    await bed.clock.advance(2 * DAY_MS);
    const response = await app.request("/auth/status", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authenticated: true, username: "owner" });
    expect(bed.events("http_error")).toEqual([]);
  });
});
