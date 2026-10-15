import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TriggerInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAutomationBed,
  manualInput,
  parsedInput,
  webhookInput,
  type AutomationBed,
} from "./testing/bed.ts";
import { readTriggerSecret } from "./trigger-secrets.ts";

let bed: AutomationBed;
afterEach(() => bed.dispose());

const code = (expected: string) => expect.objectContaining({ code: expected });
const keyFile = (id: string) => join(bed.secretsDir, `${id}.key`);
const row = (id: string) =>
  bed.db.get<Record<string, unknown>>("SELECT * FROM triggers WHERE id = $id", { id });
const everything = () =>
  JSON.stringify([
    bed.db.all("SELECT * FROM triggers"),
    bed.db.all("SELECT * FROM audit"),
    bed.db.all("SELECT * FROM receipts"),
    bed.logs,
  ]);

describe("views", () => {
  it("another owner's trigger answers not_found everywhere and is not listed", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), webhookInput(bed.folder));
    const other = bed.owner({ userId: "u2" });
    expect(() => bed.triggers.view(other, trigger.id)).toThrow(code("not_found"));
    expect(() =>
      bed.triggers.update(other, { triggerId: trigger.id, baseRevision: 1, input: manualInput(bed.folder) }),
    ).toThrow(code("not_found"));
    expect(() => bed.triggers.setEnabled(other, trigger.id, true)).toThrow(code("not_found"));
    expect(() => bed.triggers.rotateSecret(other, trigger.id)).toThrow(code("not_found"));
    expect(() => bed.triggers.remove(other, trigger.id)).toThrow(code("not_found"));
    expect(bed.triggers.list(other, {}).triggers).toEqual([]);
    expect(bed.triggers.get("u2", trigger.id)).toBeNull();
    expect(row(trigger.id)).toBeDefined();
    expect(existsSync(keyFile(trigger.id))).toBe(true);
  });

  it("lists the owner's triggers, oldest first, filtered by project", async () => {
    bed = createAutomationBed();
    const other = join(bed.dir, "other-work");
    mkdirSync(other);
    const a = bed.triggers.create(bed.owner(), manualInput(bed.folder, "a")).trigger;
    await bed.clock.advance(1_000);
    const b = bed.triggers.create(bed.owner(), manualInput(other, "b")).trigger;
    expect(bed.triggers.list(bed.owner(), {}).triggers.map((view) => view.id)).toEqual([a.id, b.id]);
    expect(
      bed.triggers.list(bed.owner(), { projectId: b.projectId ?? "" }).triggers.map((view) => view.id),
    ).toEqual([b.id]);
    expect(bed.triggers.list(bed.owner(), {}).truncated).toBe(false);
  });

  it("shows a webhook trigger without its file as no_secret", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), webhookInput(bed.folder));
    rmSync(keyFile(trigger.id));
    expect(bed.triggers.view(bed.owner(), trigger.id).state).toBe("no_secret");
  });

  it("an unreadable config reads as unreadable, never fires and can be deleted", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), { ...manualInput(bed.folder), enabled: true });
    expect(bed.triggers.listEnabled().map((record) => record.id)).toEqual([trigger.id]);
    bed.db.run("UPDATE triggers SET config = '{\"x\":1}' WHERE id = $id", { id: trigger.id });
    expect(bed.triggers.view(bed.owner(), trigger.id)).toMatchObject({ state: "unreadable", enabled: true });
    expect(bed.triggers.listEnabled()).toEqual([]);
    expect(bed.triggers.remove(bed.owner(), trigger.id)).toEqual({ ok: true });
  });

  it("hides a feed URL's query (and any userinfo) from a token, and shows the browser the full URL", () => {
    bed = createAutomationBed();
    const url = "https://example.com/feeds/me.private.atom?token=s3cret#frag";
    const { trigger } = bed.triggers.create(
      bed.owner(),
      parsedInput({
        name: "Feed",
        source: { type: "feed", url, everyMinutes: 60 },
        execution: { cwd: bed.folder },
        prompt: "News: {{payload}}",
      }),
    );
    const asToken = bed.triggers.view(bed.token(), trigger.id);
    expect(asToken.source).toMatchObject({ type: "feed", url: "https://example.com/feeds/me.private.atom" });
    expect(JSON.stringify(bed.triggers.list(bed.token(), {}))).not.toMatch(/s3cret|frag/);
    expect(bed.triggers.view(bed.owner(), trigger.id).source).toMatchObject({ url });
  });

  it("shows a token the redacted view and the browser the stored one", () => {
    bed = createAutomationBed();
    const input = parsedInput({
      ...manualInput(bed.folder),
      execution: { cwd: bed.folder, precheck: "curl -u admin:hunter2 http://x", env: ["BUILD_FLAVOR"] },
    });
    const { trigger } = bed.triggers.create(bed.owner(), input);
    const asToken = bed.triggers.view(bed.token(), trigger.id);
    expect(asToken.redacted).toBe(true);
    expect(asToken.execution).toMatchObject({ precheck: null, env: [] });
    expect(JSON.stringify(asToken)).not.toContain("hunter2");
    expect(bed.triggers.list(bed.token(), {}).triggers[0]).toMatchObject({
      redacted: true,
      execution: { precheck: null, env: [] },
    });
    const asBrowser = bed.triggers.view(bed.owner(), trigger.id);
    expect(asBrowser.redacted).toBe(false);
    expect(asBrowser.execution).toMatchObject({
      precheck: "curl -u admin:hunter2 http://x",
      env: ["BUILD_FLAVOR"],
    });
    expect(bed.triggers.list(bed.owner(), {}).triggers[0]?.execution?.precheck).toBe(
      "curl -u admin:hunter2 http://x",
    );
  });

  it("a row whose column and config disagree on the source reads as unreadable", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), webhookInput(bed.folder));
    bed.db.run("UPDATE triggers SET source_type = 'manual' WHERE id = $id", { id: trigger.id });
    expect(bed.triggers.view(bed.owner(), trigger.id).state).toBe("unreadable");
  });

  it("getAt answers a trigger only at the revision asked", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    expect(bed.triggers.getAt("u1", trigger.id, 1)?.id).toBe(trigger.id);
    expect(bed.triggers.getAt("u1", trigger.id, 2)).toBeNull();
    expect(bed.triggers.getAt("u2", trigger.id, 1)).toBeNull();
  });
});

describe("rotate, switch and delete", () => {
  it("rotating replaces the file at once, shows the new secret and records the time", async () => {
    bed = createAutomationBed();
    const { trigger, secret } = bed.triggers.create(bed.owner(), webhookInput(bed.folder));
    await bed.clock.advance(5_000);
    const rotated = bed.triggers.rotateSecret(bed.owner(), trigger.id);
    expect(rotated.secret).not.toBe(secret);
    expect(readTriggerSecret(bed.secretsDir, trigger.id)).toBe(rotated.secret);
    expect(bed.triggers.view(bed.owner(), trigger.id).secretRotatedAt).toBe(bed.clock.now());
    expect(readdirSync(bed.secretsDir)).toEqual([`${trigger.id}.key`]);
    expect(everything()).not.toContain(rotated.secret);
    expect(everything()).not.toContain(secret);
    expect(bed.auditRows().at(-1)?.reason).toBe("automation trigger secret rotated");
  });

  it("rotating needs a step-up and leaves the file alone without it", () => {
    bed = createAutomationBed();
    const { trigger, secret } = bed.triggers.create(bed.owner(), webhookInput(bed.folder));
    expect(() => bed.triggers.rotateSecret(bed.unconfirmed(), trigger.id)).toThrow(code("step_up_required"));
    expect(readTriggerSecret(bed.secretsDir, trigger.id)).toBe(secret);
  });

  it("rotating a trigger that is not a webhook, or does not parse, is bad_request", () => {
    bed = createAutomationBed();
    const manual = bed.triggers.create(bed.owner(), manualInput(bed.folder)).trigger;
    expect(() => bed.triggers.rotateSecret(bed.owner(), manual.id)).toThrow(code("bad_request"));
    bed.db.run("UPDATE triggers SET config = '{}' WHERE id = $id", { id: manual.id });
    expect(() => bed.triggers.rotateSecret(bed.owner(), manual.id)).toThrow(code("bad_request"));
    expect(existsSync(keyFile(manual.id))).toBe(false);
  });

  it("enabling, disabling and deleting need no step-up and each leave one audit row", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), webhookInput(bed.folder));
    const plain = bed.unconfirmed();
    expect(bed.triggers.setEnabled(plain, trigger.id, true)).toMatchObject({ enabled: true, revision: 2 });
    expect(bed.triggers.setEnabled(plain, trigger.id, false).enabled).toBe(false);
    expect(bed.triggers.remove(plain, trigger.id)).toEqual({ ok: true });
    expect(bed.auditRows().map((entry) => entry.reason)).toEqual([
      "automation trigger created",
      "automation trigger enabled",
      "automation trigger disabled",
      "automation trigger deleted",
    ]);
  });

  it("an audit row names the credential kind that made the change", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    bed.triggers.setEnabled(bed.token(), trigger.id, true);
    expect(bed.auditRows().at(-1)).toMatchObject({ actor: "token", actor_id: "tok1" });
    bed.triggers.setEnabled(bed.owner({ credentialId: "automation" }), trigger.id, false);
    expect(bed.auditRows().at(-1)).toMatchObject({ actor: "system", actor_id: "automation" });
  });

  it("deleting removes the row and the secret file, and the audit row carries no secret", () => {
    bed = createAutomationBed();
    const { trigger, secret } = bed.triggers.create(bed.owner(), webhookInput(bed.folder));
    bed.triggers.remove(bed.owner(), trigger.id);
    expect(row(trigger.id)).toBeUndefined();
    expect(existsSync(keyFile(trigger.id))).toBe(false);
    expect(JSON.stringify(bed.auditRows())).not.toContain(secret ?? "x");
    expect(() => bed.triggers.view(bed.owner(), trigger.id)).toThrow(code("not_found"));
  });

  it("never logs a secret", () => {
    bed = createAutomationBed();
    const made = bed.triggers.create(bed.owner(), webhookInput(bed.folder));
    const rotated = bed.triggers.rotateSecret(bed.owner(), made.trigger.id);
    bed.triggers.remove(bed.owner(), made.trigger.id);
    const logged = JSON.stringify(bed.logs);
    expect(logged).not.toContain(made.secret ?? "x");
    expect(logged).not.toContain(rotated.secret);
  });

  it("stores the parsed input and nothing the input did not carry", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    const stored = JSON.parse(String(row(trigger.id)?.config)) as unknown;
    expect(TriggerInput.safeParse(stored).success).toBe(true);
  });
});
