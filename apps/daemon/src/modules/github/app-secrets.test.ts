import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import {
  createAppSecrets,
  GITHUB_APP_FILE,
  GITHUB_APP_MAX_BYTES,
  type GithubAppFile,
} from "./app-secrets.ts";

const APP: GithubAppFile = {
  appId: 1,
  slug: "pap-x",
  clientId: "Iv1.x",
  clientSecret: "client-secret-0123456789",
  privateKey: "-----BEGIN PRIVATE KEY-----\nQUJDREVGR0g=\n-----END PRIVATE KEY-----\n",
  htmlUrl: "https://github.com/apps/pap-x",
  callbackOrigin: "https://pap.test",
};
let root: string;
let secrets: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-gh-app-"));
  secrets = join(root, "secrets");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("app secrets", () => {
  it("saves 0600, loads, reports a status without values and forgets", () => {
    const { logger } = captureLogger();
    const store = createAppSecrets({ secretsDir: secrets, logger });
    expect(store.load()).toBeNull();
    store.save(APP);
    expect(statSync(join(secrets, GITHUB_APP_FILE)).mode & 0o777).toBe(0o600);
    expect(store.load()).toEqual(APP);
    expect(JSON.stringify(store.status())).not.toContain("secret");
    expect(store.secretValues()).toEqual([APP.clientSecret, APP.privateKey, "QUJDREVGR0g="]);
    store.forget();
    expect(store.load()).toBeNull();
    store.forget();
  });

  it("refuses a link and a file over 16 KiB", () => {
    const { logger, lines } = captureLogger();
    const store = createAppSecrets({ secretsDir: secrets, logger });
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(APP));
    symlinkSync(outside, join(secrets, GITHUB_APP_FILE));
    expect(store.load()).toBeNull();
    expect(lines.some((line) => line.msg === "github_app_unreadable" && line.err === "ELOOP")).toBe(true);
    // Saving replaces the link instead of writing through it.
    store.save(APP);
    expect(store.load()).toEqual(APP);
    expect(JSON.parse(readFileSync(outside, "utf8")).appId).toBe(1);
    writeFileSync(join(secrets, GITHUB_APP_FILE), Buffer.alloc(GITHUB_APP_MAX_BYTES + 1, 0x20));
    expect(store.load()).toBeNull();
    expect(lines.some((line) => line.err === "not_an_app_file")).toBe(true);
    writeFileSync(join(secrets, GITHUB_APP_FILE), "{not json");
    expect(store.load()).toBeNull();
  });
});
