import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";

// Parser-level table for here-documents, arithmetic and parameter expansions: every string goes to stage 01 and is never
// handed to a shell. A here-document body is data only when `cat` or `tee` writes it out, nothing pipes that output on,
// and its delimiter line is there; any other body is read as commands. "documented pass" rows are listed in
// docs/agents/policy.md.
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

type Row = readonly [title: string, command: string, verdict: "block" | "pass"];

async function verdictOf(command: string, denylist: readonly string[]): Promise<string | undefined> {
  const h = bed.harness({
    rules: () => ({ ...interactiveRules, denylist: [...denylist] }),
    stages: ALLOW_03,
  });
  await h.run("bash", { command });
  const entry = h.entries.at(-1);
  const stage = entry?.kind === "call" ? entry.stages[0] : undefined;
  expect(stage?.stage).toBe("01");
  return stage?.outcome;
}

const rows = (line: string): Row[] => [
  // No here-document is queued inside ((…)), $((…)), ${…} or $[…]: a false one would hide every later line.
  ["arithmetic shift, then the command", `((0<<0))\n${line}`, "block"],
  ["spaced arithmetic shift", `(( x = 1 << 2 ))\n${line}`, "block"],
  ["arithmetic shift whose operand comes back as a line", `((0<<Z))\n${line}\nZ`, "block"],
  ["arithmetic shift of a variable named cat", `((cat<<Z))\n${line}\nZ`, "block"],
  ["$((…)) holding a substitution", `echo $((cat<<'Z'\n$(${line})\nZ\n))`, "block"],
  ["${…} pattern holding <<", `cat \${x/<<Z/y}\n${line}\nZ/y}`, "block"],
  ["$[…] arithmetic shift", `cat $[1<<Z]\n${line}\nZ]`, "block"],
  ["brackets nested in $[…]", `cat $[ a[1]<<Z ]\n${line}\nZ`, "block"],
  ['double quotes nested in "${…}"', `cat "\${x:-"<<Z"}"\n${line}\nZ}`, "block"],
  ['single quotes inside "${…}"', `cat "\${x:-'}"<<Z"'}"\n${line}\nZ'}`, "block"],
  ["# inside ${…} is a character", `echo \${x:- #}; ${line}`, "block"],
  ["bodies start after a ${…} that spans lines", `cat <<EOF \${x:-\n}\nEOF\n# it's\n${line}\n# '`, "block"],
  ["# inside ((…)) is a character", `((1 #)); ${line}`, "block"],
  ["# after (( that opened two subshells", `((echo a) # it's\n${line}\n)`, "block"],
  // A shell reached other than as the receiver's command word.
  ["piped to bash", `cat <<EOF | bash\n${line}\nEOF`, "block"],
  ["piped to sudo sh", `cat <<'EOF' | sudo sh\n${line}\nEOF`, "block"],
  ["piped to ssh", `cat <<EOF | ssh host\n${line}\nEOF`, "block"],
  ["piped with |&", `cat <<EOF |& bash\n${line}\nEOF`, "block"],
  ["piped right after an escaped |", `tee <<EOF \\||bash\n${line}\nEOF`, "block"],
  ["a group piped on the same line", `{ cat <<EOF; } | bash\n${line}\nEOF`, "block"],
  ["a subshell piped on the same line", `(cat <<EOF) | sh\n${line}\nEOF`, "block"],
  ["written to a process substitution", `cat <<EOF > >(bash)\n${line}\nEOF`, "block"],
  ["read through a process substitution", `bash <(cat <<'EOF'\n${line}\nEOF\n)`, "block"],
  ["sudo -s", `sudo -s <<EOF\n${line}\nEOF`, "block"],
  ["sudo -i", `sudo -i <<EOF\n${line}\nEOF`, "block"],
  ["sudo -iu postgres", `sudo -iu postgres <<EOF\n${line}\nEOF`, "block"],
  ["sudo su -", `sudo su - <<EOF\n${line}\nEOF`, "block"],
  ["su - user", `su - user <<EOF\n${line}\nEOF`, "block"],
  ["chroot /mnt", `chroot /mnt <<EOF\n${line}\nEOF`, "block"],
  ["a shell named by a variable", `$SHELL <<EOF\n${line}\nEOF`, "block"],
  ["a body that never meets its delimiter", `cat <<EOF\n${line}`, "block"],
  ["data written by tee", `tee f <<EOF\n${line}\nEOF`, "pass"],
  ["data written by sudo tee", `sudo tee /etc/x <<'EOF'\n${line}\nEOF`, "pass"],
  ["|| is not a pipe", `cat <<EOF || bash\n${line}\nEOF`, "pass"],
  ["another command after cat on its line", `cat <<EOF; ls\n${line}\nEOF`, "pass"],
  ["a pipe before the here-document", `echo x | cat <<EOF > f\n${line}\nEOF`, "pass"],
  // Bash runs the substitutions of an unquoted body while it reads it.
  ["$(…) in an unquoted data body", `cat <<EOF > f\n$(${line})\nEOF`, "block"],
  ["backquotes in an unquoted data body", `cat <<EOF > f\n\`${line}\`\nEOF`, "block"],
  ["$(…) in a quoted data body", `cat <<'EOF' > f\n$(${line})\nEOF`, "pass"],
  ["escaped $(…) in an unquoted data body", `cat <<EOF > f\n\\$(${line})\nEOF`, "pass"],
  // bash joins a line ending in a backslash to the next one before it compares (unquoted delimiter); dash does not.
  ["delimiter split by a line continuation", `cat <<EOF\nE\\\nOF\n${line}\nEOF`, "block"],
  ["quoted delimiter, no continuation", `cat <<'EOF'\nE\\\nOF\n${line}\nEOF`, "pass"],
  ["escaped backslash is no continuation", `cat <<EOF\nA\\\\\nEOF\n${line}\nEOF`, "block"],
  ["a delimiter dash sees after a continuation", `cat <<EOF\nx\\\nEOF\n${line}\nEOF`, "block"],
  // The delimiter word read as bash reads it.
  ['\\" inside a double-quoted delimiter', `cat <<"A\\"B" #"\nx\nA"B\n${line}\nA\\B #`, "block"],
  ["\\\\ inside a double-quoted delimiter", `cat <<"A\\\\B"\nx\nA\\B\n${line}\nA\\\\B`, "block"],
  ["ANSI-C delimiter with an escaped quote", `cat <<$'\\'' ; ${line}\n'`, "block"],
  ["ANSI-C delimiter, not decoded here", `cat <<$'E\\x41'\nx\nEA\n${line}\nE\\x41`, "block"],
  ["a delimiter holding a substitution", `cat <<$(x)\n$(x)\n${line}\n$`, "block"],
  // # after $IFS: a line continuation keeps the word going.
  ["$IFS, a line continuation, then #", `echo$IFS\\\n#;${line}`, "block"],
  ["${IFS}, a line continuation, then #", `echo\${IFS}\\\n#;${line}`, "block"],
  ["a blank, a line continuation, then a comment", `echo \\\n#;${line}`, "pass"],
  // Residuals (docs/agents/policy.md, Task 26).
  ["documented pass: a function named cat", `cat() { bash; }; cat <<EOF\n${line}\nEOF`, "pass"],
  ["documented pass: a substitution fed to bash -c", `bash -c "$(cat <<'EOF'\n${line}\nEOF\n)"`, "pass"],
  ["documented pass: a group piped on a later line", `{\ncat <<EOF\n${line}\nEOF\n} | bash`, "pass"],
];

const cases: ReadonlyArray<readonly [name: string, denylist: readonly string[], line: string]> = [
  ["the built-in preset", [], "rm -rf /"],
  ["the owner pattern pap-test-blocked *", ["pap-test-blocked *"], "pap-test-blocked now"],
  ["the owner pattern terraform destroy*", ["terraform destroy*"], "terraform destroy"],
];

describe.each(cases)("here-documents and expansions under %s", (_name, denylist, line) => {
  it.each(rows(line))("%s: %j", async (_title, command, expected) => {
    expect(await verdictOf(command, denylist)).toBe(expected);
  });
});
