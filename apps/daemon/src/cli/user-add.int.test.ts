import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpRequest } from "../testing/http-client.ts";
import { startTestDaemon } from "../testing/harness.ts";
import { pap } from "./testing/pap.ts";

const PASSWORD = "correct horse battery staple";
let scratch: string;
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-cli-user-add-"));
  home = join(scratch, "home");
  env = { PATH: process.env.PATH, PAP_HOME: home, HOME: join(scratch, "user") };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("pap user add (the real entry point)", () => {
  it("creates the owner from standard input and refuses a second one", () => {
    const created = pap(["user", "add", "owner"], env, `${PASSWORD}\n`);
    expect(created.stderr).toBe("");
    expect(created.status).toBe(0);
    expect(created.stdout).toBe("owner owner created\n");
    const again = pap(["user", "add", "other"], env, "another long password\n");
    expect(again.status).toBe(1);
    expect(again.stderr).toBe("pap: an owner already exists: pap v1 has one owner\n");
  });

  it("leaves a home whose daemon prints no setup URL and signs the owner in with that password", async () => {
    expect(pap(["user", "add", "owner", "--password-stdin"], env, `${PASSWORD}\n`).status).toBe(0);
    const t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { home } });
    try {
      expect(t.daemon.setupUrl).toBeNull();
      const reply = await httpRequest(`${t.base}/auth/login`, {
        method: "POST",
        headers: { origin: t.origin, "content-type": "application/json" },
        body: JSON.stringify({ username: "owner", password: PASSWORD }),
      });
      expect(reply.status).toBe(200);
    } finally {
      await t.stop();
    }
  });

  it("refuses a short password and a bad username, and never echoes the password", () => {
    const short = pap(["user", "add", "owner"], env, "short\n");
    expect(short.status).toBe(1);
    expect(short.stderr).toBe("pap: the password needs 12 to 1024 characters\n");
    const bad = pap(["user", "add", "bad name"], env, `${PASSWORD}\n`);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe("pap: the username may use letters, digits, . _ - and 64 characters at most\n");
    expect(short.stdout + bad.stdout + bad.stderr).not.toContain(PASSWORD);
  });

  it("refuses an empty standard input and a password on the command line", () => {
    const empty = pap(["user", "add", "owner"], env, "");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toBe("pap: no password on standard input\n");
    const argv = pap(["user", "add", "owner", "--password", PASSWORD], env, "");
    expect(argv.status).toBe(64);
    expect(argv.stderr).not.toContain(PASSWORD);
  });
});
