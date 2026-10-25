// J03: a lane writes a file, the file is committed and pushed, a pull request is opened through the `gh` stub. The bare
// repository and the stub's log are read from outside the page at the end (M13R39).
import { basename } from "node:path";
import { expect, scripted, plural, t, test } from "./fixtures.ts";
import { ghCalls, gitIn, laneEnv, makeBareRemote } from "./git.ts";

const LANE = "e2e-lane";
const BRANCH = `pi/${LANE}`;
const TARGET = "local/remote.git";

test.use({
  papEnv: laneEnv(),
  papScript: scripted([
    {
      toolCalls: [{ name: "write", id: "j03-write", args: { path: "lane.txt", content: "from the lane\n" } }],
    },
    { text: "The lane file is written." },
  ]),
});

test("J03: lane, commit, push and pull request", async ({ page, pap, signedIn }) => {
  test.setTimeout(120_000);
  const bare = await makeBareRemote(pap);
  await signedIn.goto(pap.origin);

  await test.step("new lane from the home", async () => {
    await page.getByRole("radio", { name: t("launch.mode.lane"), exact: true }).click();
    await page.getByLabel(t("launch.field"), { exact: true }).fill("Write the lane file");
    await page.getByRole("button", { name: t("launch.go.lane"), exact: true }).click();
    await page.getByRole("button", { name: basename(pap.work), exact: true }).click();
    await page.getByLabel(t("laneNew.titleField"), { exact: true }).fill(LANE);
    await page.getByRole("button", { name: t("laneNew.create"), exact: true }).click();
    await expect(page.getByRole("heading", { name: LANE, exact: true })).toBeVisible();
  });

  const bar = page.getByRole("region", { name: t("laneCommit.region"), exact: true });
  await test.step("the changed file is listed, commit it with a message", async () => {
    // The commit bar learns of the file from the daemon's status poll (15 s), not from the agent.
    const files = bar.getByRole("button", { name: plural("laneCommit.files", 1, { n: 1 }), exact: true });
    await expect(files).toBeVisible({ timeout: 40_000 });
    await bar.getByLabel(t("laneCommit.message"), { exact: true }).fill("Add the lane file");
    await bar.getByRole("button", { name: t("laneCommit.commit"), exact: true }).click();
    await expect(bar.getByRole("status").filter({ hasText: /^Committed [0-9a-f]{7}$/ })).toBeVisible();
  });

  await test.step("push", async () => {
    await bar
      .getByRole("button", { name: t("laneCommit.push.to", { n: 1, target: TARGET }), exact: true })
      .click();
    await expect(
      bar.getByRole("status").filter({ hasText: t("laneCommit.pushed", { target: TARGET }) }),
    ).toBeVisible();
  });

  await test.step("create the pull request, the badge shows number 1 and passing checks", async () => {
    await bar.getByRole("button", { name: t("laneCommit.pr.toggle"), exact: true }).click();
    await bar.getByRole("button", { name: t("laneCommit.pr.create"), exact: true }).click();
    await expect(
      bar.getByRole("button", { name: t("laneCommit.pr.toggleNumber", { number: 1 }), exact: true }),
    ).toBeVisible();
    const panel = bar.locator("[data-slot=lane-pr-panel]");
    await expect(panel.getByText("#1", { exact: true })).toBeVisible();
    await expect(panel.getByText(plural("lanes.pr.checks.passed", 1))).toBeAttached();
  });

  // From outside: the remote holds the commit and the branch, the forge CLI was asked once, without a token.
  expect(gitIn(pap, bare, "branch", "--list").trim()).toBe(BRANCH);
  expect(gitIn(pap, bare, "log", "--format=%s", BRANCH).trim().split("\n")).toEqual([
    "Add the lane file",
    "init",
  ]);
  // The daemon writes one trailer (git-ops.ts), `Pap-Lane`; the brief's `Pi-Lane` and `Pi-Session` do not exist.
  const message = gitIn(pap, bare, "log", "-1", "--format=%B", BRANCH).trimEnd();
  expect(message).toMatch(/^Add the lane file\n\nPap-Lane: e2e-lane-[0-9a-f]+$/);
  expect(gitIn(pap, bare, "show", `${BRANCH}:lane.txt`)).toBe("from the lane\n");

  const calls = ghCalls(pap);
  const created = calls.filter((line) => line.startsWith("call pr create "));
  expect(created).toHaveLength(1);
  expect(created[0]).toContain(`--head=${BRANCH}`);
  expect(created[0]).not.toMatch(/token/i);
  expect(calls.filter((line) => /^call (auth|repo) /.test(line))).toEqual([]);
});
