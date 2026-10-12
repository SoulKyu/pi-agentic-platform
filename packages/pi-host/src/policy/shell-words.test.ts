import { describe, expect, it } from "vitest";
import { argvOf, CommandTooComplex, CommandTooLong, readCommands } from "./shell-words.ts";

// A segment left empty once its wrappers are gone (`}` alone) has no command: it is dropped here as the stage drops it.
const argvs = (command: string) =>
  readCommands(command)
    .map((segment) => argvOf(segment).join(" "))
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

  const wordsOf = (command: string) => readCommands(command).map((segment) => segment.words.join(" "));

  it("makes a redirection operator a word of its own, wherever it touches, and drops it from the argv", () => {
    expect(wordsOf("echo>/dev/sda")).toEqual(["echo > /dev/sda"]);
    expect(wordsOf("echo x 2>&1 >>log <in &>all 3<>dev <&0")).toEqual([
      "echo x 2>& 1 >> log < in &> all 3<> dev <& 0",
    ]);
    expect(wordsOf('echo ">"|rm -rf /')).toEqual(["echo >", "rm -rf /"]);
    expect(argvs("echo>/dev/sda")).toEqual(["echo"]);
    expect(argvs(">/dev/null 2>&1 rm -rf /")).toEqual(["rm -rf /"]);
    expect(argvs("sudo 2>/dev/null rm -rf /")).toEqual(["rm -rf /"]);
    expect(argvs('echo ">" file')).toEqual(["echo > file"]);
  });

  it("skips a comment up to the newline, which still ends the command", () => {
    expect(argvs("# it's safe\nrm -rf /")).toEqual(["rm -rf /"]);
    expect(argvs("ls # don't\nterraform destroy")).toEqual(["ls", "terraform destroy"]);
    expect(argvs("echo a#b")).toEqual(["echo a#b"]);
  });

  it("strips the compound-command keywords", () => {
    expect(argvs("if true; then rm -rf /; fi")).toEqual(["true", "rm -rf /", "fi"]);
    expect(argvs("for i in 1; do rm -rf /; done")).toEqual(["for i in 1", "rm -rf /", "done"]);
    expect(argvs("while :; do terraform destroy; done")).toEqual([":", "terraform destroy", "done"]);
  });

  it('keeps quoting in step across ANSI-C quotes, $"…" and here-documents', () => {
    expect(argvs("$'it\\'s'; rm -rf /")).toEqual(["$it\\'s", "rm -rf /"]);
    expect(argvs('echo $"hi"')).toEqual(["echo hi"]);
    expect(argvs("cat <<EOF\nit's\nEOF\nrm -rf /")).toEqual(["cat", "rm -rf /"]);
    expect(argvs("cat <<-'EOF'\n\tx\n\tEOF\nls")).toEqual(["cat", "ls"]);
    expect(argvs("bash <<EOF\nit's\nEOF\nrm -rf /")).toEqual(["bash", "its\n", "rm -rf /"]);
    expect(argvs("cat <<'END OF'\nx\nEND OF\nrm -rf /")).toEqual(["cat", "rm -rf /"]);
    expect(argvs("bash 0<<EOF\nls\nEOF")).toEqual(["bash", "ls"]);
  });

  it("reads a # right after an IFS blank as part of a word, not as a comment", () => {
    expect(argvs("echo${IFS}#;rm -rf /")).toContain("rm -rf /");
    expect(argvs("ls$IFS#;terraform destroy")).toContain("terraform destroy");
    expect(argvs("echo a #;rm")).toEqual(["echo a"]);
    expect(argvs("(#c\nrm -rf /)")).toEqual(["rm -rf /"]);
  });

  it("gives a glued option value to its option, as getopt does", () => {
    expect(argvs("sudo -uroot rm -rf /")).toEqual(["rm -rf /"]);
    expect(argvs("timeout -k5s 10 rm -rf /")).toEqual(["rm -rf /"]);
    expect(argvs("xargs -d'\\n' rm -rf /")).toEqual(["rm -rf /"]);
    expect(argvs("sudo -Eu root rm -rf /")).toEqual(["rm -rf /"]);
    expect(argvs("function f { rm -rf /; }; f")).toContain("rm -rf /");
  });

  it("reads a here-document body as commands only for a shell or ssh, and a long data body costs no segment", () => {
    const body = "x = 1\n".repeat(2000);
    expect(readCommands(`cat <<'EOF' > f.py\n${body}EOF\nls`).map((s) => s.words.join(" "))).toEqual([
      "cat << EOF > f.py",
      "ls",
    ]);
    expect(argvs("ssh host <<EOF\nrm -rf /\nEOF")).toContain("rm -rf /");
  });

  it("reads ${IFS} and $IFS as a blank", () => {
    expect(argvs("rm${IFS}-rf$IFS/")).toEqual(["rm -rf /"]);
    expect(argvs("echo $IFSX")).toEqual(["echo $IFSX"]);
  });

  it("reads the command of -c after options and --, and of su, ssh and fish", () => {
    expect(argvs("bash -c -- 'rm -rf /'")).toContain("rm -rf /");
    expect(argvs("fish -c 'rm -rf /'")).toContain("rm -rf /");
    expect(argvs("su -c 'rm -rf /' nobody")).toContain("rm -rf /");
    expect(argvs("ssh -p 22 host 'rm -rf /'")).toContain("rm -rf /");
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
