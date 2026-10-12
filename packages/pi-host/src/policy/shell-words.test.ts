import { describe, expect, it } from "vitest";
import { argvOf, CommandTooComplex, CommandTooLong, readCommands } from "./shell-words.ts";

// A segment left empty once its wrappers are gone (`}` alone) has no command: it is dropped here as the stage drops it.
const argvs = (command: string) =>
  readCommands(command)
    .map((segment) => argvOf(segment.words).join(" "))
    .filter((argv) => argv !== "");

describe("readCommands", () => {
  it("splits on every separator and keeps the words of each command", () => {
    expect(argvs("ls -l; rm -rf / && echo ok || true | cat & sleep 1\nwhoami")).toEqual([
      "ls -l",
      "rm -rf /",
      "echo ok",
      "true",
      "cat",
      "sleep 1",
      "whoami",
    ]);
  });

  it("resolves quotes and backslashes as bash does", () => {
    expect(argvs(`r''m -rf "/"`)).toEqual(["rm -rf /"]);
    expect(argvs(`\\rm -rf '/'`)).toEqual(["rm -rf /"]);
    expect(argvs(`"r"m -rf /`)).toEqual(["rm -rf /"]);
    expect(argvs(`echo "a;b" 'c|d'`)).toEqual(["echo a;b c|d"]);
    expect(argvs('echo "a\\"b" a\\ b')).toEqual(['echo a"b a b']);
    expect(argvs("rm -rf \\\n/")).toEqual(["rm -rf /"]);
  });

  it("reads command substitutions, bash -c and eval as commands of their own, three levels deep at most", () => {
    expect(argvs("echo $(rm -rf /)")).toEqual(["rm -rf /", "echo $(…)"]);
    expect(argvs("echo `rm -rf ~`")).toEqual(["rm -rf ~", "echo `…`"]);
    expect(argvs(`echo "$(rm -rf /)"`)).toEqual(["rm -rf /", "echo $(…)"]);
    expect(argvs(`bash -c "rm -rf /"`)).toEqual(["bash -c rm -rf /", "rm -rf /"]);
    expect(argvs(`sh -lc 'sh -c "rm -rf /"'`)).toContain("rm -rf /");
    expect(argvs(`bash -o pipefail -c "rm -rf /"`)).toContain("rm -rf /");
    expect(argvs(`eval "rm -rf /"`)).toContain("rm -rf /");
    expect(() => readCommands(`bash -c "bash -c 'bash -c \\"bash -c ls\\"'"`)).toThrow(CommandTooComplex);
  });

  it("does not read a -c that belongs to a script", () => {
    expect(argvs("bash script.sh -c 'rm -rf /'")).toEqual(["bash script.sh -c rm -rf /"]);
  });

  it("strips the wrappers that only run the next word", () => {
    expect(argvs("sudo -u root env -i FOO=1 nohup nice -n 5 /bin/rm -rf /")).toEqual(["rm -rf /"]);
    expect(argvs("X=1 Y=2 time -p timeout -s KILL 5s command rm -rf ~")).toEqual(["rm -rf ~"]);
    expect(argvs("{ rm -rf /; }")).toEqual(["rm -rf /"]);
    expect(argvs("echo sudo rm")).toEqual(["echo sudo rm"]);
    expect(argvs("sudo")).toEqual([]);
  });

  it("refuses more than 1000 commands and a command over 64 KiB", () => {
    expect(() => readCommands("true;".repeat(1001))).toThrow(CommandTooComplex);
    expect(readCommands("true;".repeat(1000))).toHaveLength(1000);
    expect(() => readCommands("a".repeat(65_537))).toThrow(CommandTooLong);
    expect(readCommands("a".repeat(65_536))).toHaveLength(1);
  });
});
