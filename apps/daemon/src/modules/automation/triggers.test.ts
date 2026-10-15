import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATION_LIMITS } from "@pap/contracts";
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
const count = () => bed.db.get<{ n: number }>("SELECT count(*) AS n FROM triggers")?.n;
const everything = () =>
  JSON.stringify([
    bed.db.all("SELECT * FROM triggers"),
    bed.db.all("SELECT * FROM audit"),
    bed.db.all("SELECT * FROM receipts"),
    bed.logs,
  ]);

describe("create", () => {
  it("without a step-up answers step_up_required and writes nothing", () => {
    bed = createAutomationBed();
    expect(() => bed.triggers.create(bed.unconfirmed(), webhookInput(bed.folder))).toThrow(
      code("step_up_required"),
    );
    expect(count()).toBe(0);
    expect(existsSync(bed.secretsDir)).toBe(false);
    expect(bed.auditRows()).toEqual([]);
  });

  it("with a step-up stores the row, the file and an audit row, and shows the secret once", () => {
    bed = createAutomationBed();
    const input = parsedInput({
      ...webhookInput(bed.folder),
      prompt: "PROMPT-TEXT-123 {{payload}}",
      execution: {
        cwd: bed.folder,
        precheck: "curl -H 'Authorization: Bearer hunter2' http://x",
        tools: ["read", "bash"],
      },
    });
    const { trigger, secret } = bed.triggers.create(bed.owner(), input);
    expect(secret).toMatch(/^pwh_[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(keyFile(trigger.id), "utf8")).toBe(secret);
    expect(trigger).toMatchObject({
      state: "ok",
      enabled: false,
      revision: 1,
      redacted: false,
      cwd: bed.folder,
      secretRotatedAt: bed.clock.now(),
      webhookUrl: `https://pap.example/hooks/${trigger.id}`,
    });
    expect(row(trigger.id)).toMatchObject({ owner_id: "u1", source_type: "webhook", revision: 1 });
    expect(everything()).not.toContain(secret);
    const audits = bed.auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: "user",
      actor_id: "test-device",
      kind: "policy",
      decision: "info",
      reason: "automation trigger created",
    });
    expect(JSON.parse(audits[0]?.detail ?? "")).toEqual({
      triggerId: trigger.id,
      source: "webhook",
      mode: "supervised",
      tools: 2,
      precheck: true,
    });
    const trail = JSON.stringify(audits);
    for (const hidden of ["PROMPT-TEXT-123", "hunter2", "curl", bed.folder, secret])
      expect(trail).not.toContain(hidden);
  });

  it("gives an hmac webhook trigger a secret too, and a manual trigger none", () => {
    bed = createAutomationBed();
    const hmac = bed.triggers.create(bed.owner(), webhookInput(bed.folder, "hmac"));
    expect(hmac.secret).not.toBeNull();
    expect(readTriggerSecret(bed.secretsDir, hmac.trigger.id)).toBe(hmac.secret);
    const manual = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    expect(manual.secret).toBeNull();
    expect(manual.trigger.webhookUrl).toBeNull();
    expect(manual.trigger.secretRotatedAt).toBeNull();
    expect(existsSync(keyFile(manual.trigger.id))).toBe(false);
  });

  it("files the trigger under the project of its folder", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    expect(trigger.projectId).toBe(bed.projects.port.ensure("u1", bed.folder)?.id);
    expect(trigger.projectId).not.toBeNull();
  });

  it("a token never gets past the step-up, whatever its permissions", () => {
    bed = createAutomationBed();
    expect(() => bed.triggers.create(bed.token(), manualInput(bed.folder))).toThrow(code("step_up_required"));
    expect(count()).toBe(0);
  });

  it("refuses the 201st trigger of an owner and evicts none; another owner is not counted", () => {
    bed = createAutomationBed();
    const first = bed.triggers.create(bed.owner(), manualInput(bed.folder, "first")).trigger.id;
    for (let at = 1; at < AUTOMATION_LIMITS.triggersPerOwner; at++)
      bed.triggers.create(bed.owner(), manualInput(bed.folder, `t${at}`));
    expect(count()).toBe(200);
    expect(() => bed.triggers.create(bed.owner(), manualInput(bed.folder, "one more"))).toThrow(
      code("limit_reached"),
    );
    expect(count()).toBe(200);
    expect(row(first)).toBeDefined();
    expect(() =>
      bed.triggers.create(bed.owner({ userId: "u2" }), manualInput(bed.folder, "other")),
    ).not.toThrow();
  });

  it("a full owner is refused before a secret is written", () => {
    bed = createAutomationBed();
    for (let at = 0; at < AUTOMATION_LIMITS.triggersPerOwner; at++)
      bed.triggers.create(bed.owner(), manualInput(bed.folder, `t${at}`));
    expect(() => bed.triggers.create(bed.owner(), webhookInput(bed.folder))).toThrow(code("limit_reached"));
    expect(existsSync(bed.secretsDir)).toBe(false);
  });

  it("refuses a folder inside $PAP_HOME or Pi's agent folder, and one that does not exist", () => {
    bed = createAutomationBed();
    const inHome = join(bed.home, "worktrees", "lane");
    mkdirSync(inHome, { recursive: true });
    const link = join(bed.dir, "sneaky");
    symlinkSync(bed.home, link);
    const bad = [bed.home, inHome, bed.piAgentDir, link, join(bed.dir, "missing")];
    for (const cwd of bad)
      expect(() => bed.triggers.create(bed.owner(), manualInput(cwd)), cwd).toThrow(code("invalid_cwd"));
    expect(count()).toBe(0);
  });

  it("stores the real path of a folder reached through a link", () => {
    bed = createAutomationBed();
    const link = join(bed.dir, "alias");
    symlinkSync(bed.folder, link);
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(link));
    expect(trigger.cwd).toBe(bed.folder);
    expect(trigger.execution?.cwd).toBe(bed.folder);
    expect(row(trigger.id)?.cwd).toBe(bed.folder);
  });

  it("leaves no secret file when the row cannot be inserted", () => {
    bed = createAutomationBed();
    bed.db.exec(
      "CREATE TRIGGER refuse_insert BEFORE INSERT ON triggers BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(() => bed.triggers.create(bed.owner(), webhookInput(bed.folder))).toThrow(/refused/);
    expect(existsSync(bed.secretsDir) ? readdirSync(bed.secretsDir) : []).toEqual([]);
    expect(bed.auditRows()).toEqual([]);
  });

  it("leaves no row when the secret cannot be written", () => {
    bed = createAutomationBed();
    writeFileSync(join(bed.home, "secrets"), "not a folder");
    expect(() => bed.triggers.create(bed.owner(), webhookInput(bed.folder))).toThrow();
    expect(count()).toBe(0);
    expect(bed.auditRows()).toEqual([]);
  });
});

describe("update", () => {
  it("bumps the revision and audits it; a stale base answers conflict and changes nothing", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    const next = manualInput(bed.folder, "Renamed");
    const updated = bed.triggers.update(bed.owner(), { triggerId: trigger.id, baseRevision: 1, input: next });
    expect(updated.trigger).toMatchObject({ name: "Renamed", revision: 2 });
    expect(updated.secret).toBeNull();
    expect(() =>
      bed.triggers.update(bed.owner(), {
        triggerId: trigger.id,
        baseRevision: 1,
        input: manualInput(bed.folder, "Late"),
      }),
    ).toThrow(code("conflict"));
    expect(row(trigger.id)).toMatchObject({ name: "Renamed", revision: 2 });
    expect(bed.auditRows().map((entry) => entry.reason)).toEqual([
      "automation trigger created",
      "automation trigger updated",
    ]);
  });

  it("needs a step-up and writes nothing without it", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    expect(() =>
      bed.triggers.update(bed.unconfirmed(), {
        triggerId: trigger.id,
        baseRevision: 1,
        input: manualInput(bed.folder, "x"),
      }),
    ).toThrow(code("step_up_required"));
    expect(row(trigger.id)?.revision).toBe(1);
  });

  it("an unknown trigger answers not_found", () => {
    bed = createAutomationBed();
    expect(() =>
      bed.triggers.update(bed.owner(), {
        triggerId: "nope",
        baseRevision: 1,
        input: manualInput(bed.folder),
      }),
    ).toThrow(code("not_found"));
  });

  it("turning another source into a webhook gives a secret; keeping a webhook keeps it; leaving one removes it", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    const toHook = bed.triggers.update(bed.owner(), {
      triggerId: trigger.id,
      baseRevision: 1,
      input: webhookInput(bed.folder),
    });
    expect(toHook.secret).toMatch(/^pwh_/);
    expect(readTriggerSecret(bed.secretsDir, trigger.id)).toBe(toHook.secret);
    expect(toHook.trigger.secretRotatedAt).toBe(bed.clock.now());
    const upd = (baseRevision: number, input: ReturnType<typeof webhookInput>) =>
      bed.triggers.update(bed.owner(), { triggerId: trigger.id, baseRevision, input });
    const stillSecret = upd(2, { ...webhookInput(bed.folder), name: "Renamed" });
    expect(stillSecret.secret).toBeNull();
    expect(readTriggerSecret(bed.secretsDir, trigger.id)).toBe(toHook.secret);
    // The secret already travelled in clear in a header: it must not become the HMAC key.
    const toHmac = upd(3, webhookInput(bed.folder, "hmac"));
    expect(toHmac.secret).toMatch(/^pwh_/);
    expect(toHmac.secret).not.toBe(toHook.secret);
    expect(readTriggerSecret(bed.secretsDir, trigger.id)).toBe(toHmac.secret);
    expect(toHmac.trigger.secretRotatedAt).toBe(bed.clock.now());
    expect(JSON.stringify(bed.db.all("SELECT * FROM audit"))).not.toContain(toHook.secret ?? "x");
    // An HMAC key never travelled: going back to a shared secret keeps it.
    const backToSecret = upd(4, webhookInput(bed.folder));
    expect(backToSecret.secret).toBeNull();
    expect(readTriggerSecret(bed.secretsDir, trigger.id)).toBe(toHmac.secret);
    const toManual = bed.triggers.update(bed.owner(), {
      triggerId: trigger.id,
      baseRevision: 5,
      input: manualInput(bed.folder),
    });
    expect(toManual.secret).toBeNull();
    expect(toManual.trigger).toMatchObject({ secretRotatedAt: null, webhookUrl: null });
    expect(existsSync(keyFile(trigger.id))).toBe(false);
  });

  it("applies the folder rule again", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    expect(() =>
      bed.triggers.update(bed.owner(), {
        triggerId: trigger.id,
        baseRevision: 1,
        input: manualInput(bed.home),
      }),
    ).toThrow(code("invalid_cwd"));
    expect(row(trigger.id)?.cwd).toBe(bed.folder);
  });

  it("an unreadable row can be saved again", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), manualInput(bed.folder));
    bed.db.run('UPDATE triggers SET config = \'{"from":"the future"}\' WHERE id = $id', { id: trigger.id });
    expect(bed.triggers.view(bed.owner(), trigger.id)).toMatchObject({
      state: "unreadable",
      source: null,
      execution: null,
      prompt: null,
    });
    const saved = bed.triggers.update(bed.owner(), {
      triggerId: trigger.id,
      baseRevision: 1,
      input: manualInput(bed.folder),
    });
    expect(saved.trigger.state).toBe("ok");
  });
});

describe("a feed address that can never be fetched (M10R158)", () => {
  const feed = (url: string) =>
    parsedInput({
      name: "Blog",
      source: { type: "feed", url, everyMinutes: 60 },
      execution: { cwd: bed.folder },
      prompt: "{{payload}}",
    });

  it.each([
    "https://127.0.0.1/feed",
    "https://[::127.0.0.1]/",
    "https://[::a9fe:a9fe]/",
    "https://169.254.169.254/latest",
    "https://10.0.0.5/feed.xml",
    "https://2130706433/",
  ])("refuses %s on create with bad_request and writes nothing", (url) => {
    bed = createAutomationBed();
    expect(() => bed.triggers.create(bed.owner(), feed(url))).toThrow(code("bad_request"));
    expect(count()).toBe(0);
    expect(bed.auditRows()).toEqual([]);
  });

  it("refuses an address that was good on update and keeps the saved one", () => {
    bed = createAutomationBed();
    const { trigger } = bed.triggers.create(bed.owner(), feed("https://example.com/feed.xml"));
    expect(() =>
      bed.triggers.update(bed.owner(), {
        triggerId: trigger.id,
        baseRevision: 1,
        input: feed("https://192.168.1.182/feed.xml"),
      }),
    ).toThrow(code("bad_request"));
    expect(bed.triggers.view(bed.owner(), trigger.id)).toMatchObject({ revision: 1 });
  });

  it("saves a name, which is judged at each poll (DNS changes)", () => {
    bed = createAutomationBed();
    expect(bed.triggers.create(bed.owner(), feed("https://localhost/feed.xml")).trigger.revision).toBe(1);
  });
});
