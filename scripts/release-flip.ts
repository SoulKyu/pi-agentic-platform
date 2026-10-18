import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_CONDITIONS } from "./release-check.ts";

const RELEASE_YML = ".github/workflows/release.yml";
const UPDATE_CHECK = "apps/daemon/src/update-check.ts";
const UPDATE_CHECK_TEST = "apps/daemon/src/update-check.test.ts";

export interface FlipFiles {
  readonly releaseYml: string;
  readonly updateCheckTs: string;
  readonly updateCheckTestTs: string;
}

/** The two ADR 0066 items no script can do (a private repository answers 404; a setting lives on GitHub). */
export const OWNER_ONLY_ITEMS: readonly string[] = [
  "ADR 0066 item 3: check the casing of FEED_REPO (apps/daemon/src/update-check.ts): curl -sIL -o /dev/null -w '%{url_effective}\\n' https://github.com/<FEED_REPO>",
  'ADR 0066 item 5: enable "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General)',
];

const PRE_ON = "on:\n  workflow_dispatch:";
const POST_ON = "on:\n  push:\n    branches: [main]\n  workflow_dispatch:";
const PRE_COMMENT = `# workflow_dispatch only while the repository is private (M6bR36). The v1 flip is scripts/release-flip.ts (ADR 0066 and
# ADR 0076): it adds \`push: branches: [main]\` to \`on:\` and lets \`stable\` run on that push.`;
const POST_COMMENT = `# Flipped for v1 by scripts/release-flip.ts (ADR 0066 and ADR 0076): a push to main and workflow_dispatch start the
# jobs; \`stable\` runs on both, \`next\` only on a dispatch.`;
const PRE_DEFAULT = "export const UPDATE_CHECK_DEFAULT = false;";
const POST_DEFAULT = "export const UPDATE_CHECK_DEFAULT = true;";
const PRE_ASSERT = "expect(UPDATE_CHECK_DEFAULT).toBe(false);";
const POST_ASSERT = "expect(UPDATE_CHECK_DEFAULT).toBe(true);";
const PRE_NAME = "the shipped default is off until the repository is public";
const POST_NAME = "the shipped default is on now that the repository is public";

const swap = (text: string, from: string, to: string, file: string): string => {
  if (text.split(from).length !== 2)
    throw new Error(`${file}: expected exactly one "${from}"; the file is not in the pre-flip shape`);
  return text.replace(from, () => to);
};

/** The three files after the v1 flip. Throws "already flipped" on a flipped input and names a file it does not recognise. */
export function applyFlip(files: FlipFiles): FlipFiles {
  if (
    files.releaseYml.includes(POST_ON) ||
    files.updateCheckTs.includes(POST_DEFAULT) ||
    files.updateCheckTestTs.includes(POST_ASSERT)
  )
    throw new Error("already flipped: the tree holds the v1 flip");
  let releaseYml = swap(files.releaseYml, PRE_ON, POST_ON, "release.yml");
  releaseYml = swap(
    releaseYml,
    `if: ${JOB_CONDITIONS.before.stable}`,
    `if: ${JOB_CONDITIONS.after.stable}`,
    "release.yml",
  );
  releaseYml = swap(releaseYml, PRE_COMMENT, POST_COMMENT, "release.yml");
  return {
    releaseYml,
    updateCheckTs: swap(
      files.updateCheckTs,
      PRE_DEFAULT,
      POST_DEFAULT,
      "update-check.ts UPDATE_CHECK_DEFAULT",
    ),
    updateCheckTestTs: swap(
      swap(files.updateCheckTestTs, PRE_ASSERT, POST_ASSERT, "update-check.test.ts"),
      PRE_NAME,
      POST_NAME,
      "update-check.test.ts",
    ),
  };
}

/** Reads the three files under `root`, flips them in memory and writes all three only when every one was recognised. */
export function flipTree(root: string): void {
  const path = (file: string) => join(root, file);
  const flipped = applyFlip({
    releaseYml: readFileSync(path(RELEASE_YML), "utf8"),
    updateCheckTs: readFileSync(path(UPDATE_CHECK), "utf8"),
    updateCheckTestTs: readFileSync(path(UPDATE_CHECK_TEST), "utf8"),
  });
  writeFileSync(path(RELEASE_YML), flipped.releaseYml);
  writeFileSync(path(UPDATE_CHECK), flipped.updateCheckTs);
  writeFileSync(path(UPDATE_CHECK_TEST), flipped.updateCheckTestTs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    flipTree(resolve(import.meta.dirname, ".."));
  } catch (error: unknown) {
    console.error(`release-flip: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(`release-flip: rewrote ${RELEASE_YML}, ${UPDATE_CHECK}, ${UPDATE_CHECK_TEST}; read the diff.`);
  console.log("release-flip: owner-only items, not done by this script:");
  for (const item of OWNER_ONLY_ITEMS) console.log(`  - ${item}`);
}
