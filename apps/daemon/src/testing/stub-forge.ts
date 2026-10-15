import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StubAnswer {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** The stub waits this long before it answers (a deadline test). */
  sleepMs?: number;
  /** The stub prints this many bytes of `x` instead of `stdout`. */
  stdoutBytes?: number;
}
export interface StubCall {
  argv: string[];
  cwd: string;
  stdin: string;
  /** Names only, never values. */
  envKeys: string[];
  pid: number;
}
export interface StubForge {
  /** The folder holding the executable `gh`: put it first on PATH. */
  binDir: string;
  calls(): StubCall[];
}

/**
 * The only way a test meets a forge: an executable `gh` that records argv, cwd, stdin and the environment's keys to a
 * JSON-lines file and prints a canned answer (the next one in `answers`, the last one repeating).
 */
export function writeStubForge(dir: string, answers: readonly StubAnswer[]): StubForge {
  const record = join(dir, "calls.jsonl");
  const answersFile = join(dir, "answers.json");
  writeFileSync(answersFile, JSON.stringify(answers));
  writeFileSync(record, "");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const answers = JSON.parse(fs.readFileSync(${JSON.stringify(answersFile)}, "utf8"));
  const calls = fs.readFileSync(${JSON.stringify(record)}, "utf8").split("\\n").filter(Boolean).length;
  const answer = answers[Math.min(calls, answers.length - 1)] ?? {};
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: Buffer.concat(chunks).toString("utf8"),
    envKeys: Object.keys(process.env),
    pid: process.pid,
  }) + "\\n");
  const reply = () => {
    if (answer.stderr) process.stderr.write(answer.stderr);
    process.stdout.write(answer.stdoutBytes ? "x".repeat(answer.stdoutBytes) : (answer.stdout ?? ""), () =>
      process.exit(answer.exitCode ?? 0));
  };
  if (answer.sleepMs) setTimeout(reply, answer.sleepMs); else reply();
});
`;
  const bin = join(dir, "gh");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return {
    binDir: dir,
    calls: () =>
      readFileSync(record, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StubCall),
  };
}
