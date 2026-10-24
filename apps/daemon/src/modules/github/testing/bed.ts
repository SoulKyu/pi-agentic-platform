import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { startFakeGithub, type FakeGithub } from "../../../kernel/testing/fake-github.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import { createVaultStore } from "../../secrets/index.ts";
import { createGithubModule, type GithubAppFile, type GithubCore } from "../index.ts";

export const OWNER = "owner-1";

export interface GithubBed {
  readonly home: string;
  readonly fake: FakeGithub;
  readonly clock: FakeClock;
  readonly core: GithubCore;
  readonly logger: Logger;
  readonly lines: Array<Record<string, unknown>>;
  readonly app: GithubAppFile;
  close(): Promise<void>;
}

/** The GitHub module on a temporary `$PAP_HOME`, a real RSA key and the fake GitHub on loopback. */
export async function startGithubBed(): Promise<GithubBed> {
  const home = mkdtempSync(join(tmpdir(), "pap-github-"));
  const fake = await startFakeGithub();
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const core = createGithubModule({
    home,
    vault: createVaultStore(join(home, "secrets", "vault")),
    clock,
    logger,
    apiOrigin: fake.origin,
    webOrigin: fake.origin,
    test: true,
  });
  const app: GithubAppFile = {
    appId: 4242,
    slug: "pap-fake",
    clientId: "Iv1.fake",
    clientSecret: "client-secret-0123456789abcdef",
    privateKey,
    htmlUrl: `${fake.origin}/apps/pap-fake`,
    callbackOrigin: "http://pap.test",
  };
  core.appSecrets.save(app);
  return {
    home,
    fake,
    clock,
    core,
    logger,
    lines,
    app,
    close: async () => {
      await fake.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
