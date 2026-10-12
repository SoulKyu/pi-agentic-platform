import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";

// Parser-level table: every string goes to stage 01 and is never handed to a shell. Each row states its verdict;
// "documented pass" rows are residuals of M5R18 that docs/agents/policy.md lists.
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

type Row = readonly [title: string, command: string, verdict: "block" | "pass"];

async function verdictOf(command: string, denylist: string[]): Promise<string | undefined> {
  const h = bed.harness({ rules: () => ({ ...interactiveRules, denylist }), stages: ALLOW_03 });
  await h.run("bash", { command });
  const entry = h.entries.at(-1);
  const stage = entry?.kind === "call" ? entry.stages[0] : undefined;
  expect(stage?.stage).toBe("01");
  return stage?.outcome;
}

/** The same shapes for a command `word` with argument line `args`: `rm -rf /`, `pap-test-blocked now`… */
const shapes = (cmd: string, args: string): Row[] => {
  const line = `${cmd} ${args}`;
  return [
    ["plain", line, "block"],
    ["tabs", `${cmd}\t${args.replace(/ /g, "\t")}`, "block"],
    ["repeated spaces", `${cmd}   ${args.replace(/ /g, "    ")}`, "block"],
    ["single-quoted command word", `'${cmd}' ${args}`, "block"],
    ["empty quotes inside the command word", `${cmd[0]}''${cmd.slice(1)} ${args}`, "block"],
    ["double-quoted command word", `"${cmd}" ${args}`, "block"],
    ["backslash in the command word", `\\${cmd} ${args}`, "block"],
    ["line continuation", `${cmd} \\\n${args}`, "block"],
    ["$IFS as the blank", `${cmd}\${IFS}${args.replace(/ /g, "${IFS}")}`, "block"],
    ["comment with a quote before", `# it's safe\n${line}`, "block"],
    ["comment after a command", `ls # don't\n${line}`, "block"],
    ["if/then", `if true; then ${line}; fi`, "block"],
    ["if on the command", `if ${line}; then :; fi`, "block"],
    ["for/do", `for i in 1; do ${line}; done`, "block"],
    ["while/do", `while :; do ${line}; done`, "block"],
    ["redirect before the command", `>/dev/null ${line}`, "block"],
    ["fd redirect before the command", `2>&1 ${line}`, "block"],
    ["redirect between wrapper and command", `sudo 2>/dev/null ${line}`, "block"],
    ["redirect between the words", `${cmd} >log ${args}`, "block"],
    ["input redirect between the words", `${cmd} <&0 ${args}`, "block"],
    ["&> between the words", `${cmd} &>/dev/null ${args}`, "block"],
    ["ANSI-C quote with an escaped quote before", `$'it\\'s'; ${line}`, "block"],
    ["here-document body with a quote, then the command", `cat <<EOF\nit's\nEOF\n${line}`, "block"],
    ["tab-stripped here-document", `cat <<-EOF\n\tit's\n\tEOF\n${line}`, "block"],
    ['$"…" quoting', `$"${cmd}" ${args}`, "block"],
    ["bash -c --", `bash -c -- '${line}'`, "block"],
    ["bash -c -x", `bash -c -x '${line}'`, "block"],
    ["fish -c", `fish -c '${line}'`, "block"],
    ["su -c", `su -c '${line}' nobody`, "block"],
    ["runuser -c", `runuser -u nobody -- bash -c '${line}'`, "block"],
    ["script -qc", `script -qc '${line}' /dev/null`, "block"],
    ["ssh host", `ssh host '${line}'`, "block"],
    ["ssh with options", `ssh -p 22 -i key host ${line}`, "block"],
    ["sudo --user root", `sudo --user root ${line}`, "block"],
    ["sudo -Eu root", `sudo -Eu root ${line}`, "block"],
    ["timeout --signal KILL 5", `timeout --signal KILL 5 ${line}`, "block"],
    ["doas", `doas ${line}`, "block"],
    ["ionice", `ionice -c 3 ${line}`, "block"],
    ["stdbuf", `stdbuf -oL ${line}`, "block"],
    ["time -p", `time -p ${line}`, "block"],
    ["setsid", `setsid ${line}`, "block"],
    ["chroot", `chroot / ${line}`, "block"],
    ["flock", `flock /tmp/lock ${line}`, "block"],
    ["unshare", `unshare -m ${line}`, "block"],
    ["watch", `watch -n 5 ${line}`, "block"],
    ["documented pass: taskset", `taskset 0x1 ${line}`, "pass"],
    ["env", `env ${line}`, "block"],
    ["env -i X=1", `env -i X=1 ${line}`, "block"],
    ["leading assignment", `X=1 ${line}`, "block"],
    ["sudo -u x", `sudo -u x ${line}`, "block"],
    ["nice -n 5", `nice -n 5 ${line}`, "block"],
    ["command", `command ${line}`, "block"],
    ["exec", `exec ${line}`, "block"],
    ["nohup", `nohup ${line}`, "block"],
    ["timeout 5", `timeout 5 ${line}`, "block"],
    ["timeout -s KILL 5s", `timeout -s KILL 5s ${line}`, "block"],
    ["xargs", `xargs ${line}`, "block"],
    ["busybox", `busybox ${line}`, "block"],
    ["/usr/bin/env", `/usr/bin/env ${line}`, "block"],
    ["absolute path", `/opt/bin/${line}`, "block"],
    ["semicolon", `echo a; ${line}`, "block"],
    ["&&", `true && ${line}`, "block"],
    ["||", `false || ${line}`, "block"],
    ["pipe", `echo a | ${line}`, "block"],
    ["newline", `echo a\n${line}`, "block"],
    ["CRLF newline", `echo a\r\n${line}`, "block"],
    ["background &", `sleep 1 & ${line}`, "block"],
    ["braces", `{ ${line}; }`, "block"],
    ["subshell", `(${line})`, "block"],
    ["negation", `! ${line}`, "block"],
    ["$(…)", `echo $(${line})`, "block"],
    ["backticks", `echo \`${line}\``, "block"],
    ["$(…) in double quotes", `echo "$(${line})"`, "block"],
    ["bash -c", `bash -c '${line}'`, "block"],
    ["sh -c double quotes", `sh -c "${line}"`, "block"],
    ["zsh -c after another command", `zsh -c "echo 'x'; ${line}"`, "block"],
    ["bash -lc", `bash -lc '${line}'`, "block"],
    ["sudo bash -c", `sudo bash -c '${line}'`, "block"],
    ["bash -c nested in bash -c", `bash -c "bash -c '${line}'"`, "block"],
    ["eval", `eval ${line}`, "block"],
    ["eval, quoted", `eval "${line}"`, "block"],
    ["documented pass: here-string fed to a shell", `bash <<< '${line}'`, "pass"],
    ["documented pass: variable as the command word", `c=${cmd}; $c ${args}`, "pass"],
    ["documented pass: command word from a substitution", `$(echo ${cmd}) ${args}`, "pass"],
    ["documented pass: ANSI-C quoted command word", `$'${cmd}' ${args}`, "pass"],
    ["documented pass: CR after the command word", `${cmd}\r${args}`, "pass"],
  ];
};

const rmTargets: Row[] = [
  ...["/", "/*", "~", "~/", "$HOME", "${HOME}", '"$HOME"', "/.", "//", "///", "/./", "~/*", "${HOME}/"].map(
    (target): Row => [`target ${target}`, `rm -rf ${target}`, "block"],
  ),
  ["target before the flags", "rm / -rf", "block"],
  ["flag -r -f", "rm -r -f /", "block"],
  ["flag -fr", "rm -fr /", "block"],
  ["flag -Rf", "rm -Rf /", "block"],
  ["flags --recursive --force", "rm --recursive --force /", "block"],
  ["flag --no-preserve-root", "rm -rf --no-preserve-root /", "block"],
  ["flag -rf after --", "rm -rf -- /", "block"],
  ["redirection glued to the target", "rm -rf />/dev/null", "block"],
  ["redirection glued to the command", "rm -rf /</dev/null", "block"],
  ["a project path", "rm -rf ./build", "pass"],
  ["a home subdirectory", "rm -rf ~/project", "pass"],
  ["no recursive flag", "rm /", "pass"],
  ["documented pass: parent spelling", "rm -rf /..", "pass"],
  ["documented pass: glob after the root", "rm -rf /[a-z]*", "pass"],
  ["documented pass: brace expansion", "{rm,-rf,/}", "pass"],
];

const others: Row[] = [
  ["chmod -R /", "chmod -R 777 /", "block"],
  ["chown -R /", "chown -R nobody /", "block"],
  ["chgrp --recursive /", "chgrp --recursive nobody /", "block"],
  ["chmod on a path", "chmod -R 755 ./dist", "pass"],
  ["dd of=/dev/sda", "dd if=/dev/zero of=/dev/sda", "block"],
  ["dd of first", "dd of=/dev/sda if=/dev/zero bs=1M", "block"],
  ["dd nvme", "dd if=x of=/dev/nvme0n1", "block"],
  ["dd to a file", "dd if=/dev/zero of=./disk.img", "pass"],
  ["mkfs.ext4", "mkfs.ext4 /dev/sda1", "block"],
  ["mkfs -t", "mkfs -t ext4 /dev/sda", "block"],
  ["mke2fs", "mke2fs /dev/sda1", "block"],
  ["mkswap", "mkswap /dev/sda2", "block"],
  ["shred", "shred -n 1 /dev/sdb", "block"],
  ["wipefs", "wipefs -a /dev/sda", "block"],
  ["blkdiscard", "blkdiscard /dev/sda", "block"],
  ["redirect with blanks", "echo x > /dev/sda", "block"],
  ["redirect without blanks", "echo x>/dev/sda", "block"],
  ["redirect append", "cat img >>/dev/mmcblk0", "block"],
  ["redirect with a file descriptor", "echo x 1>/dev/sda", "block"],
  ["redirect clobber", "echo x >| /dev/sda", "block"],
  ["redirect of both streams", "echo x &> /dev/sda", "block"],
  ["redirect >&", "echo x >& /dev/sda", "block"],
  ["redirect after a quoted >", 'echo ">"|rm -rf /', "block"],
  ["redirect to null", "echo x > /dev/null", "pass"],
  ["redirect to a partition-less name", "echo x > /dev/tty", "pass"],
  ["$IFS without braces", "rm$IFS-rf$IFS/", "block"],
  ["a variable that only starts with IFS", "rm$IFSX-rf /", "pass"],
  ["documented pass: env -S", "env -S 'rm -rf /'", "pass"],
  ["fork bomb with the function keyword", "function f { f|f& }; f", "block"],
  ["target /**", "rm -rf /**", "block"],
  ["target /***", "rm -rf /***", "block"],
  ["abbreviated --recursiv", "rm --recursiv --force /", "block"],
  ["abbreviated --recu", "rm --recu /", "block"],
  ["chmod --recursive", "chmod --recursive 777 /", "block"],
  ["chmod --rec", "chmod --rec 777 /", "block"],
  ["chmod -R /*", "chmod -R 777 /*", "block"],
  ["chown -R //", "chown -R nobody //", "block"],
  ["chmod --re is ambiguous (--reference)", "chmod --re=x 777 /", "pass"],
  ["redirect to //dev/sda", "echo x > //dev/sda", "block"],
  ["dd of=/dev//sda", "dd if=x of=/dev//sda", "block"],
  ["shred //dev/sda", "shred //dev/sda", "block"],
  ["read-write redirect", "exec 3<>/dev/sda", "block"],
  ["documented pass: find -exec", "find / -exec rm -rf {} +", "pass"],
  ["documented pass: tee to a device", "echo x | tee /dev/sda", "pass"],
  ["documented pass: cp to a device", "cp img /dev/sda", "pass"],
  ["fork bomb classic", ":(){ :|:& };:", "block"],
  ["fork bomb with blanks", ":() { : | : & }; :", "block"],
  ["fork bomb with newlines", ":(){\n :|:&\n};:", "block"],
  ["fork bomb named", "f(){ f|f& };f", "block"],
  ["fork bomb named with blanks", "bomb() { bomb | bomb & }; bomb", "block"],
  ["fork bomb in bash -c", `bash -c ':(){ :|:& };:'`, "block"],
  ["documented pass: find / -delete", "find / -delete", "pass"],
  ["documented pass: root reached by cd", "cd / && rm -rf *", "pass"],
  ["documented pass: arguments from standard input", "echo / | xargs rm -rf", "pass"],
  ["documented pass: output piped to a shell", "printf 'rm -rf /' | sh", "pass"],
  ["documented pass: interpreter", "python3 -c \"import shutil; shutil.rmtree('/')\"", "pass"],
];

describe("variants of the built-in preset", () => {
  const rows: Row[] = [...shapes("rm", "-rf /"), ...rmTargets, ...others];
  it.each(rows)("%s: %j", async (_title, command, expected) => {
    expect(await verdictOf(command, [])).toBe(expected);
  });
});

describe.each([
  ["pap-test-blocked *", "pap-test-blocked", "now"],
  ["terraform destroy*", "terraform", "destroy"],
])("variants of the owner pattern %j", (pattern, cmd, args) => {
  const rows: Row[] = [
    ...shapes(cmd, args),
    ["redirect glued before the pattern's args", `${cmd} 2>&1 ${args}`, "block"],
    ["a different command", `${cmd}-other ${args}`, "pass"],
    ["only echoed", `echo ${cmd} ${args}`, "pass"],
  ];
  it.each(rows)("%s: %j", async (_title, command, expected) => {
    expect(await verdictOf(command, [pattern])).toBe(expected);
  });
});

describe.each([
  [
    "*>/etc/*",
    [
      ["glued", "cat x >/etc/passwd", "block"],
      ["spaced", "cat x > /etc/passwd", "block"],
      ["no blanks", "cat x>/etc/passwd", "block"],
      ["appended is another operator", "cat x >> /etc/passwd", "pass"],
      ["other target", "cat x > /tmp/y", "pass"],
    ],
  ],
  [
    "* 2>&1*",
    [
      ["glued", "make 2>&1", "block"],
      ["piped on", "make 2>&1 | tee log", "block"],
      ["no redirect", "make", "pass"],
    ],
  ],
] as const)("redirections in the owner pattern %j", (pattern, rows) => {
  it.each(rows as unknown as Row[])("%s: %j", async (_title, command, expected) => {
    expect(await verdictOf(command, [pattern])).toBe(expected);
  });
});
