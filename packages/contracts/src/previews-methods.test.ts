import { describe, expect, it } from "vitest";
import { ERROR_CODES, METHOD_IDEMPOTENT, methods } from "./index.ts";
import { PREVIEWS_BROWSER_ONLY, PreviewsEvent, previewsMethods } from "./previews-methods.ts";

const box = { kind: "project", id: "11111111-2222-4333-8444-555555555555" } as const;
const lease = "ab".repeat(16);
const view = {
  id: "a".repeat(32),
  name: "site",
  port: 8000,
  state: "running",
  reason: null,
  startedAt: 1,
  network: false,
  box,
};

describe("previews methods", () => {
  it("are ten, each with a permission, an idempotency row and real error codes", () => {
    expect(Object.keys(previewsMethods)).toHaveLength(10);
    for (const def of Object.values(previewsMethods)) {
      expect(methods[def.name as keyof typeof methods], def.name).toBe(def);
      expect(METHOD_IDEMPOTENT[def.name], def.name).toBe(def.idempotent);
      expect(def.permission, def.name).toBe(
        def.name === "subscribe.previews" ? "sessions:read" : "sessions:operate",
      );
      for (const code of def.errors) expect(ERROR_CODES, `${def.name} ${code}`).toContain(code);
    }
  });

  it("the non-idempotent set is exactly stop, restart, startProject, open and artifact", () => {
    const writes = Object.values(previewsMethods)
      .filter((def) => !def.idempotent)
      .map((def) => def.name)
      .sort();
    expect(writes).toEqual([
      "previews.artifact",
      "previews.open",
      "previews.restart",
      "previews.startProject",
      "previews.stop",
    ]);
  });

  it("every method whose result carries a capability URL or a lease is secretResult, and no other is", () => {
    const secret = Object.values(previewsMethods)
      .filter((def) => "secretResult" in def)
      .map((def) => def.name)
      .sort();
    expect(secret).toEqual(["previews.artifact", "previews.open"]);
    for (const def of Object.values(previewsMethods)) {
      const keys = Object.keys((def.result as unknown as { shape: Record<string, unknown> }).shape ?? {});
      const carries = keys.includes("url") || keys.includes("lease");
      expect("secretResult" in def, def.name).toBe(carries);
    }
  });

  it("minting, renewing and closing are browser only; close is idempotent and answers nothing", () => {
    expect([...PREVIEWS_BROWSER_ONLY].sort()).toEqual([
      "previews.artifact",
      "previews.close",
      "previews.open",
      "previews.renew",
    ]);
    expect(previewsMethods["previews.close"].idempotent).toBe(true);
    expect(previewsMethods["previews.close"].result.safeParse({}).success).toBe(true);
    expect(previewsMethods["previews.close"].result.safeParse({ ok: true }).success).toBe(false);
  });

  it("a lease is 32 hex and an entry id visible ASCII", () => {
    const renew = previewsMethods["previews.renew"].params;
    expect(renew.safeParse({ lease }).success).toBe(true);
    for (const bad of ["ab".repeat(15), "AB".repeat(16), "zz".repeat(16), `${lease}0`]) {
      expect(renew.safeParse({ lease: bad }).success, bad).toBe(false);
    }
    const artifact = previewsMethods["previews.artifact"].params;
    const ok = { sessionId: "s1", entryId: "e1b2c3d4", fenceIndex: 0 };
    expect(artifact.safeParse(ok).success).toBe(true);
    for (const entryId of ["", "a b", "a\nb", "é", "x".repeat(129)]) {
      expect(artifact.safeParse({ ...ok, entryId }).success, entryId).toBe(false);
    }
    expect(artifact.safeParse({ ...ok, fenceIndex: 256 }).success).toBe(false);
    expect(artifact.safeParse({ ...ok, fenceIndex: -1 }).success).toBe(false);
    expect(artifact.safeParse({ ...ok, html: "<p>x</p>" }).success).toBe(false);
  });

  it("START PREVIEW sends the command and port the page showed", () => {
    const start = previewsMethods["previews.startProject"].params;
    const ok = { projectId: box.id, command: "npm run dev", port: 5173 };
    expect(start.safeParse(ok).success).toBe(true);
    const bidi = `npm run ${String.fromCodePoint(0x202e)}dev`;
    expect(start.safeParse({ ...ok, command: bidi }).success).toBe(false);
    expect(start.safeParse({ ...ok, port: 7842 }).success).toBe(false);
    expect(start.safeParse({ projectId: box.id }).success).toBe(false);
  });

  it("bounds the lists, the logs and the stream events", () => {
    expect(previewsMethods["previews.list"].result.safeParse({ services: Array(5).fill(view) }).success).toBe(
      false,
    );
    expect(previewsMethods["previews.list"].result.safeParse({ services: [view] }).success).toBe(true);
    const logs = previewsMethods["previews.logs"].result;
    expect(logs.safeParse({ lines: Array(200).fill("x".repeat(512)) }).success).toBe(true);
    expect(logs.safeParse({ lines: Array(201).fill("x") }).success).toBe(false);
    expect(logs.safeParse({ lines: ["x".repeat(513)] }).success).toBe(false);
    expect(PreviewsEvent.safeParse({ type: "snapshot", services: [view] }).success).toBe(true);
    expect(PreviewsEvent.safeParse({ type: "service", service: view }).success).toBe(true);
    expect(PreviewsEvent.safeParse({ type: "removed", box, name: "site" }).success).toBe(true);
    expect(PreviewsEvent.safeParse({ type: "removed", box, name: "Site" }).success).toBe(false);
  });
});
