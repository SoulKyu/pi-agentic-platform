import { join } from "node:path";
import { createRotatingFile, type RotatingFile } from "./rotating-file.ts";

const FILE_NAME = "trace.jsonl";
/** The current file and `.1` … `.9`: ten files of 10 MiB at most (spec C §3.4). */
const ROTATED = 9;

export const traceFilePath = (home: string): string => join(home, "logs", FILE_NAME);

/** Every path `pap trace summary` reads, newest first. */
export const traceFilePaths = (home: string): string[] => [
  traceFilePath(home),
  ...Array.from({ length: ROTATED }, (_, k) => `${traceFilePath(home)}.${k + 1}`),
];

/** `$PAP_HOME/logs/trace.jsonl`: 0600, never opened through a symlink, rotated at 10 MiB, nine kept. */
export function createTraceFile(home: string): RotatingFile {
  return createRotatingFile({ path: traceFilePath(home), keep: ROTATED });
}
