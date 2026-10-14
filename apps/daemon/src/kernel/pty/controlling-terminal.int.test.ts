import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SAFE_OPEN = join(dirname(fileURLToPath(import.meta.url)), "..", "fs", "safe-open.ts");
const HOLD_SLAVE =
  "import os,pty,sys\nm,s=pty.openpty()\nprint(os.ttyname(s),flush=True)\nsys.stdin.readline()";
// A session leader without a controlling terminal opens the slave through the boundary, then reports tty_nr.
const OPEN_THROUGH_BOUNDARY = `
import { readFileSync } from "node:fs";
const { openRegularFile } = await import(${JSON.stringify(SAFE_OPEN)});
try {
  await openRegularFile(process.argv[1], { root: "/dev/pts" });
} catch (error) {
  console.log("refused:" + error.reason);
}
const stat = readFileSync("/proc/self/stat", "utf8");
console.log("tty_nr:" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[4]);
`;

function lines(command: string, args: string[], stdin: "pipe" | "ignore" = "ignore") {
  const child = spawn(command, args, { stdio: [stdin, "pipe", "inherit"] });
  let text = "";
  const waiters: Array<() => void> = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  return {
    child,
    closed,
    text: () => text,
    firstLine: () =>
      new Promise<string>((resolve) => {
        const check = () => {
          const at = text.indexOf("\n");
          if (at >= 0) resolve(text.slice(0, at));
          else waiters.push(check);
        };
        check();
      }),
  };
}

describe("opening a pty slave through the files boundary (MC8 I5)", () => {
  it("never makes it the controlling terminal of the opener", async () => {
    const holder = lines("python3", ["-c", HOLD_SLAVE], "pipe");
    try {
      const slave = await holder.firstLine();
      expect(slave).toMatch(/^\/dev\/pts\/\d+$/);
      const opener = lines("setsid", [
        "-w",
        process.execPath,
        "--disable-warning=ExperimentalWarning",
        "--conditions=development",
        "--input-type=module",
        "-e",
        OPEN_THROUGH_BOUNDARY,
        slave,
      ]);
      await opener.closed;
      expect(opener.text()).toBe("refused:not_regular\ntty_nr:0\n");
    } finally {
      holder.child.stdin?.end();
      await holder.closed;
    }
  });
});
