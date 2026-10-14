import { join } from "node:path";
import type { FileBed } from "./fixtures.ts";

// The hostile forms of the traversal matrix (spec C §8.1, M8R67): one row per form, one cell per route.
export type Code = "not_found" | "bad_request";
export interface Row {
  readonly label: string;
  readonly path: string;
  /** `files.list`, `files.read` and `files.write` over the socket. */
  readonly rpc: Code;
  readonly search?: Code;
  /** `vcs.fileDiff`: the path as a repository path of R, and the answer. */
  readonly diff?: readonly [string, Code];
  /** `subscribe.vcs` with the path as the root. */
  readonly vcs?: Code;
  /** `terminal.create` with the path as the working folder. */
  readonly term?: Code;
  /** The HTTP routes answer 404 for every row; a row the plan leaves out of `PUT /files/raw` says so. */
  readonly noPut?: true;
}

/** Fifty folders of 100 bytes below `base`: past the 4 096 bytes a path may have. */
const deep = (base: string): string => `${base}${"/".concat("b".repeat(100)).repeat(50)}`;

export function traversalRows(bed: FileBed): Row[] {
  const { R, O, free, agentDir, t } = bed;
  const [outer = "", outside = ""] = O.split("/").slice(-2);
  const secretViaDots = `${R}/../../${outer}/${outside}/secret.txt`;
  return [
    {
      label: "R/../../O/secret.txt",
      path: secretViaDots,
      rpc: "not_found",
      search: "not_found",
      diff: ["../../outside/secret.txt", "bad_request"],
      vcs: "not_found",
      term: "not_found",
    },
    {
      label: "R/link-out/secret.txt",
      path: `${R}/link-out/secret.txt`,
      rpc: "not_found",
      diff: ["link-out/secret.txt", "not_found"],
      vcs: "not_found",
      term: "not_found",
    },
    {
      label: "R/lnk/../secret.txt",
      path: `${R}/lnk/../secret.txt`,
      rpc: "not_found",
      diff: ["lnk/../secret.txt", "bad_request"],
      vcs: "not_found",
      term: "not_found",
    },
    {
      label: "R/%2e%2e/%2e%2e/O/secret.txt (literal; %252e%252e on the wire)",
      path: `${R}/%2e%2e/%2e%2e/${outer}/${outside}/secret.txt`,
      rpc: "not_found",
      search: "not_found",
      vcs: "not_found",
      term: "not_found",
    },
    {
      // Decoded once more and normalised, this is R/ok.txt, a file the owner may read: only a double decode serves it.
      label: "R/%2e%2e/work/ok.txt (literal; decodes to a path inside R)",
      path: `${R}/%2e%2e/work/ok.txt`,
      rpc: "not_found",
      search: "not_found",
      vcs: "not_found",
      term: "not_found",
    },
    {
      label: "R/%c0%ae%c0%ae/%c0%ae%c0%ae/O/secret.txt (overlong UTF-8 dots, literal)",
      path: `${R}/%c0%ae%c0%ae/%c0%ae%c0%ae/${outer}/${outside}/secret.txt`,
      rpc: "not_found",
      search: "not_found",
      vcs: "not_found",
      term: "not_found",
    },
    {
      label: "R/nodir/a\\..\\..\\O\\secret.txt (literal backslashes)",
      path: `${R}/nodir/a\\..\\..\\outside\\secret.txt`,
      rpc: "not_found",
      // The upload route refuses the name itself (400), pinned in the backslash test below.
      noPut: true,
    },
    {
      label: "NUL inside",
      path: `${R}/a\0b/ok.txt`,
      rpc: "bad_request",
      search: "bad_request",
      diff: ["a\0b/ok.txt", "bad_request"],
      vcs: "bad_request",
      term: "bad_request",
    },
    {
      label: "a path of 5 000 bytes",
      path: `${deep(R)}/ok.txt`,
      rpc: "bad_request",
      search: "bad_request",
      diff: [`${deep("").slice(1)}/ok.txt`, "bad_request"],
      vcs: "bad_request",
      term: "bad_request",
    },
    {
      label: "a relative path",
      path: "work/ok.txt",
      rpc: "bad_request",
      search: "bad_request",
      diff: ["/work/ok.txt", "bad_request"],
      vcs: "bad_request",
      term: "bad_request",
    },
    {
      label: "pap's database, its home inside a root",
      path: join(t.home, "state.db"),
      rpc: "not_found",
      term: "not_found",
    },
    ...["auth.json", "models.json", "mcp.json", "trust.json", "settings.json", "sessions/x.jsonl"].map(
      (name): Row => ({
        label: `<agentDir>/${name}`,
        path: join(agentDir, name),
        rpc: "not_found",
      }),
    ),
    {
      label: "R/notes.txt, a hard link to Pi's auth.json",
      path: `${R}/notes.txt`,
      rpc: "not_found",
      diff: ["notes.txt", "not_found"],
    },
    {
      label: "R/db.bin, a hard link to pap's state.db",
      path: `${R}/db.bin`,
      rpc: "not_found",
      diff: ["db.bin", "not_found"],
    },
    {
      label: "R/x -> /proc/self/cwd",
      path: `${R}/x`,
      rpc: "not_found",
      diff: ["x", "not_found"],
      vcs: "not_found",
      term: "not_found",
    },
    {
      label: "R/r -> /proc/self/root",
      path: `${R}/r`,
      rpc: "not_found",
      diff: ["r", "not_found"],
      vcs: "not_found",
      term: "not_found",
    },
    { label: "a FIFO in R", path: `${R}/fifo`, rpc: "not_found", diff: ["fifo", "not_found"], noPut: true },
    {
      label: "a folder no project holds",
      path: `${free}/secret.txt`,
      rpc: "not_found",
      search: "not_found",
      vcs: "not_found",
      term: "not_found",
    },
    // `free` itself as a folder, for the columns that take one.
    {
      label: "the folder no project holds",
      path: free,
      rpc: "not_found",
      search: "not_found",
      diff: ["secret.txt", "not_found"],
      vcs: "not_found",
      term: "not_found",
    },
    // O itself, beside R.
    {
      label: "O/into-r, spelled outside every root and resolving to R/ok.txt",
      path: join(O, "into-r"),
      rpc: "not_found",
    },
    {
      label: "O/into-dir, spelled outside every root and resolving to R",
      path: join(O, "into-dir"),
      rpc: "not_found",
      search: "not_found",
      vcs: "not_found",
      term: "not_found",
    },
    {
      label: "the outside folder",
      path: O,
      rpc: "not_found",
      search: "not_found",
      vcs: "not_found",
      term: "not_found",
    },
  ];
}
