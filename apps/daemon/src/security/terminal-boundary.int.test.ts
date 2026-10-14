import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attach, createTerminal, untilText } from "../modules/terminal/testing/wire.ts";
import { startTestDaemon } from "../testing/harness.ts";
import {
  type FileBed,
  dialogIdOf,
  markOf,
  nextDialog,
  runWithoutCard,
  sessionIdOf,
  SECRET_TEXT,
  startFileBed,
} from "./testing/fixtures.ts";

// Spec C §8.1, class "terminal access" (M8R63, M8R53, M8R119): the boundary judges where a terminal starts, never what
// the owner types; and what the shell inherits from the daemon is a clean environment and nothing but its own terminal.
let bed: FileBed;
beforeAll(async () => {
  bed = await startFileBed({
    workerEnv: {
      PAP_TEST_PROVIDER_SCRIPT: "/nowhere/script.json",
      PAP_MAX_WORKERS: "2",
      NOTIFY_SOCKET: "/run/systemd/notify",
      INVOCATION_ID: "0123456789abcdef0123456789abcdef",
    },
  });
}, 60_000);
afterAll(async () => {
  await bed?.stop();
});

/** The descriptors a shell holds, read with `ls` (a child: the shell opens nothing of its own for it) as [fd, link]. */
async function descriptorsOf(
  stream: Awaited<ReturnType<typeof attach>>,
): Promise<Array<readonly [number, string]>> {
  stream.type("ls -l /proc/$$/fd; printf 'FDS%s\\n' _END\r");
  await untilText(stream, "FDS_END");
  return stream
    .text()
    .split(/\r?\n/)
    .map((line) => /\s(\d+) -> (\S+)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => [Number(match[1]), match[2] as string] as const);
}

/** Descriptors 0 to 2 are the terminal; the shell opens its own `/dev/tty` for job control, from 10 up. Nothing else. */
function expectOnlyItsTerminal(links: ReadonlyArray<readonly [number, string]>): void {
  expect(links.map(([fd]) => fd).filter((fd) => fd <= 2)).toEqual([0, 1, 2]);
  const own = links.find(([fd]) => fd === 0)?.[1] ?? "";
  expect(own).toMatch(/^\/dev\/pts\/\d+$/);
  for (const [fd, link] of links) {
    // Its own terminal and nothing else: the same slave on 0 to 2, `/dev/tty` or that slave again from 10 up.
    const allowed = fd <= 2 ? [own] : fd >= 10 ? [own, "/dev/tty"] : [];
    expect([fd, allowed.includes(link)]).toEqual([fd, true]);
  }
}

describe("security: what a shell inherits from the daemon (M8R119)", () => {
  let fresh: FileBed;
  beforeAll(async () => {
    fresh = await startFileBed();
  }, 60_000);
  afterAll(async () => {
    await fresh?.stop();
  });

  it("holds no descriptor but its own terminal when it is the first terminal", async () => {
    const stream = await attach(fresh.client, await createTerminal(fresh.client, fresh.R));
    expectOnlyItsTerminal(await descriptorsOf(stream));
  });

  // MC29, accepted residual (Task 22 documents it): a shell inherits its sibling shells' masters; they are the owner's own
  // shells, same uid, and the terminal is not a sandbox. This asserts the residual on purpose: a fix (masters closed on
  // exec) turns it red, and the test is then turned into the plain "only its terminal" assertion.
  it("still inherits its sibling shells' masters (accepted residual)", async () => {
    const stream = await attach(fresh.client, await createTerminal(fresh.client, fresh.R));
    const links = await descriptorsOf(stream);
    expect(links.filter(([fd, link]) => fd >= 3 && link === "/dev/ptmx").length).toBeGreaterThanOrEqual(1);
  });
});

describe("security: what a worker inherits from the daemon (M8R119)", () => {
  // MC29: the worker closes every inherited pty descriptor at its entry (packages/pi-host/src/close-pty-fds.ts).
  it("holds no pty master while a terminal is open", async () => {
    const t = await startTestDaemon(
      {
        steps: [
          { toolCalls: [{ name: "bash", args: { command: "ls -l /dev/fd/" }, id: "fds" }] },
          { text: "done" },
        ],
      },
      { workerEnv: { SHELL: "/bin/sh" } },
    );
    try {
      const client = await t.connect(await t.login());
      // The first session makes the folder a root; the terminal comes next, and the session that is asked comes after it:
      // a worker started before the terminal cannot hold its master.
      sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await createTerminal(client, t.cwd);
      const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await client.call("subscribe.session", { sessionId });
      const mark = markOf(client);
      await client.call("sessions.prompt", { sessionId, text: "list your descriptors" });
      // The policy asks before an `ls`; the owner allows it once.
      const card = await nextDialog(client, mark);
      await client.call("sessions.respondDialog", {
        sessionId,
        dialogId: dialogIdOf(card),
        response: { answer: "once" },
      });
      await runWithoutCard(client, card.seq);
      const seen = JSON.stringify(client.events.map((frame) => frame.event));
      // The listing ran: descriptor 0 of the tool's shell is /dev/null.
      expect(seen).toContain("0 -> /dev/null");
      expect(seen).not.toContain("/dev/ptmx");
      expect(seen).not.toContain("/dev/pts/");
      client.close();
    } finally {
      await t.stop();
    }
  }, 60_000);
});

describe("security: terminals", () => {
  it("is the owner's shell, not a sandbox: a typed command reads a file outside every root", async () => {
    const stream = await attach(bed.client, await createTerminal(bed.client, bed.R));
    stream.type(`cd /; cat ${join(bed.O, "secret.txt")}\r`);
    await untilText(stream, SECRET_TEXT);
    // The refusal is at the start: the same folder as a working folder is not_found (files-traversal).
    const refused = await bed.client.call("terminal.create", {
      requestId: "terminal-outside-0001",
      cwd: bed.O,
      cols: 80,
      rows: 24,
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("starts the shell without PAP_* and without the platform's systemd variables the daemon had", async () => {
    const stream = await attach(bed.client, await createTerminal(bed.client, bed.R));
    // The printf formats keep the echoed command line from matching what the shell prints.
    stream.type(
      `printf 'ENVHAS%s\\n' "$(env | grep -c -e '^PATH=' -e '^TERM=')"\r` +
        `printf 'ENVHIT%s\\n' "$(env | grep -c -e '^PAP_' -e '^NOTIFY_SOCKET=' -e '^INVOCATION_ID=')"\r`,
    );
    await untilText(stream, "ENVHIT0");
    expect(stream.text()).toContain("ENVHAS2");
  });
});
