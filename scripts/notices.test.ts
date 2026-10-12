import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
// The text of https://www.apache.org/licenses/LICENSE-2.0.txt, as Debian and Ubuntu ship it in
// /usr/share/common-licenses/Apache-2.0 (checked on the build host when this plan was written).
const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

describe("third-party notices (S6, R53)", () => {
  it("ships the canonical Apache-2.0 text, byte for byte", () => {
    expect(
      createHash("sha256")
        .update(readFileSync(join(REPO, "LICENSES/Apache-2.0.txt")))
        .digest("hex"),
    ).toBe(APACHE_2_0_SHA256);
  });

  it("names the upstream commit and the licence file", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("6a9d5b1822ffb10bba4bd97175f01edd7d8651cd");
    expect(notices).toContain("LICENSES/Apache-2.0.txt");
  });

  it("lists every file whose header says it is derived from vercel/ai-elements", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    const derived = readdirSync(join(REPO, "packages/ui/src/ai"))
      .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
      .map((name) => `packages/ui/src/ai/${name}`)
      .filter((path) => read(path).includes("vercel/ai-elements"));
    expect(derived.length).toBeGreaterThanOrEqual(1);
    for (const path of derived) expect(notices, path).toContain(`\`${path}\``);
  });
});
