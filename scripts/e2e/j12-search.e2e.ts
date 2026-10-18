// J12: two sessions that each answered with a word of their own; the palette finds each word in the right session, Enter
// opens it, and a word in neither shows the empty state. The index is read through the RPC first, so the palette is not
// asked before the scanner (debounced, 250 ms to 1 s) has seen the Pi files.
import type { Page } from "@playwright/test";
import { expect, palette, t, test } from "./fixtures.ts";
import { actUntilVisible, writeScript } from "./seed.ts";

const FIRST = { word: "quillbert", prompt: "First report please." };
const SECOND = { word: "marmalade", prompt: "Second report please." };
const NEITHER = "xylophonic";

interface Hit {
  sessionId: string;
}

const dialog = (page: Page) => page.getByRole("dialog", { name: t("commands.palette.dialog"), exact: true });
// cmdk names its input by the dialog label, not by the aria-label the palette sets on it.
const input = (page: Page) => dialog(page).getByRole("combobox");

test("J12: the palette finds a word in the session that said it, and shows an empty state for another", async ({
  page,
  pap,
  signedIn,
}) => {
  const made: string[] = [];
  for (const { word, prompt } of [FIRST, SECOND]) {
    // A worker reads its script when it starts: the script of this session is written before it is created.
    writeScript(pap, [{ text: `The ${word} report is ready.` }]);
    const { sessionId } = await pap.rpc<{ sessionId: string }>("sessions.create", { cwd: pap.work });
    // Idle: its worker has read the script, so the next script can be written.
    await expect
      .poll(async () => {
        const { sessions } = await pap.rpc<{ sessions: { id: string; status: string }[] }>("sessions.list");
        return sessions.find((session) => session.id === sessionId)?.status;
      })
      .toBe("idle");
    await pap.rpc("sessions.prompt", { sessionId, text: prompt });
    made.push(sessionId);
  }
  const [first, second] = made;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(first).not.toBe(second);

  await test.step("the index holds each word under its own session", async () => {
    for (const [word, owner] of [
      [FIRST.word, first],
      [SECOND.word, second],
    ] as const) {
      await expect
        .poll(
          async () =>
            (await pap.rpc<{ hits: Hit[] }>("search.query", { q: word })).hits.map((hit) => hit.sessionId),
          { message: `the index holds "${word}"`, timeout: 30_000 },
        )
        .toEqual([owner]);
    }
  });

  await signedIn.goto(pap.origin);

  await test.step("the palette puts the session of the word first, Enter opens it", async () => {
    for (const [word, owner] of [
      [FIRST.word, first],
      [SECOND.word, second],
    ] as const) {
      // A keyboard chord, not a click: the page has loaded but its shortcut listener may not be attached yet, so the chord can be lost.
      await actUntilVisible(() => palette(page), dialog(page));
      await input(page).fill(word);
      const hits = dialog(page)
        .getByRole("option")
        .filter({ has: page.locator("mark") });
      await expect(hits.first().locator("mark")).toHaveText(word);
      await expect(hits).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${pap.origin}/s/${owner}`);
      await expect(dialog(page)).toBeHidden();
    }
  });

  await test.step("a word in neither session shows the empty state", async () => {
    await actUntilVisible(() => palette(page), dialog(page));
    await input(page).fill(NEITHER);
    await expect(dialog(page).getByText(t("commands.palette.empty"), { exact: true })).toBeVisible();
    await expect(dialog(page).getByRole("option")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
  });
  expect((await pap.rpc<{ hits: Hit[] }>("search.query", { q: NEITHER })).hits).toEqual([]);
});
