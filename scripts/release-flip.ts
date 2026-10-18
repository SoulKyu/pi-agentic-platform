import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_CONDITIONS, PI_COMPAT_CRON } from "./release-check.ts";

export const RELEASE_YML = ".github/workflows/release.yml";
export const PI_COMPAT_YML = ".github/workflows/pi-compat.yml";
export const UPDATE_CHECK = "apps/daemon/src/update-check.ts";
export const UPDATE_CHECK_TEST = "apps/daemon/src/update-check.test.ts";

export interface FlipFiles {
  readonly releaseYml: string;
  readonly piCompatYml: string;
  readonly updateCheckTs: string;
  readonly updateCheckTestTs: string;
}

/** What no script can do at the flip: the nightly workflow disabled by hand, and the two ADR 0066 items (a repository casing check; a setting that lives on GitHub). */
export const OWNER_ONLY_ITEMS: readonly string[] = [
  "enable the nightly workflow, disabled by hand on GitHub: gh workflow enable pi-compat.yml (the flip restores its schedule)",
  "ADR 0066 item 3: check the casing of FEED_REPO (apps/daemon/src/update-check.ts): curl -sIL -o /dev/null -w '%{url_effective}\\n' https://github.com/<FEED_REPO>",
  'ADR 0066 item 5: enable "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General)',
];

/** Prose that is true before the flip and stale after it, by file and section (line numbers move); release.md step 4.2 lists the same places. */
export const PROSE_CHECKLIST: readonly string[] = [
  "apps/daemon/src/update-check.ts, the doc comment above UPDATE_CHECK_DEFAULT: the daily check is on by default; PAP_UPDATE_CHECK=0 turns it off, =1 forces it on",
  'AGENTS.md, the bullet of "Backup, update, doctor, release (M6b)" that says the repository is private until v1: the repository is public; release.yml also runs on push to main (ADR 0066, ADR 0076)',
  'docs/agents/update.md, "Daily check" and the troubleshooting row "the update check never says anything": the check is on by default; if it says nothing, look for PAP_UPDATE_CHECK=0 in the unit',
  "docs/agents/doctor.md, the update_available row: written by the daily check (on by default) or PAP_UPDATE_CHECK=1",
  'docs/agents/install.md, the paragraph under "Container, npm, releases": drop private until v1; the repository is public, CI minutes stay unused unless you say otherwise',
  "docs/agents/install.md, the release-please row of its table: the workflow runs on push to main and on workflow_dispatch; the release PR needs the repository setting of ADR 0066 item 5",
  'docs/agents/install.md, the first sentence of "Releases and channels": the repository is public; the release steps are local commands plus a workflow that runs on a push to main or when you start it',
  'docs/agents/install.md, the bullets of "Releases and channels" that say workflow_dispatch only: the workflow runs on push to main and on workflow_dispatch; stable also runs on a push (the flip adds both push: branches: [main] and the stable if:)',
  "docs/agents/install.md, the get-pap.sh bullet: get-pap.sh needs a published release; the repository is public, so a missing release answers 404",
];

const PRE_ON = "on:\n  workflow_dispatch:";
const POST_ON = "on:\n  push:\n    branches: [main]\n  workflow_dispatch:";
const PRE_COMMENT = `# workflow_dispatch only while the repository is private (M6bR36). The v1 flip is scripts/release-flip.ts (ADR 0066 and
# ADR 0076): it adds \`push: branches: [main]\` to \`on:\` and lets \`stable\` run on that push.`;
const POST_COMMENT = `# Flipped for v1 by scripts/release-flip.ts (ADR 0066 and ADR 0076): a push to main and workflow_dispatch start the
# jobs; \`stable\` runs on both, \`next\` only on a dispatch.`;
const PRE_COMPAT_ON = "on:\n  workflow_dispatch:";
const POST_COMPAT_ON = `on:\n  schedule:\n    - cron: "${PI_COMPAT_CRON}"\n  workflow_dispatch:`;
const PRE_DEFAULT = "export const UPDATE_CHECK_DEFAULT = false;";
const POST_DEFAULT = "export const UPDATE_CHECK_DEFAULT = true;";
const PRE_ASSERT = "expect(UPDATE_CHECK_DEFAULT).toBe(false);";
const POST_ASSERT = "expect(UPDATE_CHECK_DEFAULT).toBe(true);";
const PRE_NAME = "the shipped default is off until the v1 flip";
const POST_NAME = "the shipped default is on now that the v1 flip is done";

const swap = (text: string, from: string, to: string, file: string): string => {
  if (text.split(from).length !== 2)
    throw new Error(`${file}: expected exactly one "${from}"; the file is not in the pre-flip shape`);
  return text.replace(from, () => to);
};

const REVERSALS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  [RELEASE_YML]: [
    [POST_ON, PRE_ON],
    [`if: ${JOB_CONDITIONS.after.stable}`, `if: ${JOB_CONDITIONS.before.stable}`],
    [POST_COMMENT, PRE_COMMENT],
  ],
  [PI_COMPAT_YML]: [[POST_COMPAT_ON, PRE_COMPAT_ON]],
  [UPDATE_CHECK]: [[POST_DEFAULT, PRE_DEFAULT]],
  [UPDATE_CHECK_TEST]: [
    [POST_ASSERT, PRE_ASSERT],
    [POST_NAME, PRE_NAME],
  ],
};

/** A flip file in its pre-flip shape, whichever shape it is in (tests start from it, so they hold before and after the flip). */
export function preFlipShape(file: string, text: string): string {
  let out = text;
  for (const [post, pre] of REVERSALS[file] ?? []) out = out.split(post).join(pre);
  return out;
}

/** The four files after the v1 flip. Throws "already flipped" on a flipped input and names a file it does not recognise. */
export function applyFlip(files: FlipFiles): FlipFiles {
  if (
    files.releaseYml.includes(POST_ON) ||
    files.piCompatYml.includes(POST_COMPAT_ON) ||
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
    piCompatYml: swap(files.piCompatYml, PRE_COMPAT_ON, POST_COMPAT_ON, "pi-compat.yml"),
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

/** Reads the four files under `root`, flips them in memory and writes all four only when every one was recognised. */
export function flipTree(root: string): void {
  const path = (file: string) => join(root, file);
  const flipped = applyFlip({
    releaseYml: readFileSync(path(RELEASE_YML), "utf8"),
    piCompatYml: readFileSync(path(PI_COMPAT_YML), "utf8"),
    updateCheckTs: readFileSync(path(UPDATE_CHECK), "utf8"),
    updateCheckTestTs: readFileSync(path(UPDATE_CHECK_TEST), "utf8"),
  });
  writeFileSync(path(RELEASE_YML), flipped.releaseYml);
  writeFileSync(path(PI_COMPAT_YML), flipped.piCompatYml);
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
  console.log(
    `release-flip: rewrote ${RELEASE_YML}, ${PI_COMPAT_YML}, ${UPDATE_CHECK}, ${UPDATE_CHECK_TEST}; read the diff.`,
  );
  console.log("release-flip: owner-only items, not done by this script:");
  for (const item of OWNER_ONLY_ITEMS) console.log(`  - ${item}`);
  console.log("release-flip: prose to edit in the same commit (true before the flip, stale after):");
  for (const item of PROSE_CHECKLIST) console.log(`  - ${item}`);
}
