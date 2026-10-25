import type { McpFileView } from "@pap/contracts";
import { Button, TextField, Heading } from "@pap/ui";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { parseUrl } from "../../lib/parse-url.ts";
import { getRuntime } from "../../runtime/index.ts";
import { ImportPaste } from "./ImportPaste.tsx";
import { RESERVED, SERVER_NAME, type Candidate } from "./import.ts";
import { escapeHidden, mcpFailureText } from "./mcp.vm.ts";
import { ProtectedAsk } from "./ProtectedAsk.tsx";
import type { StepUpRunner } from "./step-up.ts";
import type { useMcpWrites } from "./use-mcp-writes.ts";

type Scope = "global" | "project";
type Kind = "stdio" | "http";

/** `KEY<sep>value` lines. `null`: a line has no name or no separator, so the field is not valid. */
function pairLines(text: string, separator: "=" | ":"): Record<string, string> | null | undefined {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(separator);
    const key = at > 0 ? line.slice(0, at).trim() : "";
    if (key === "" || key === "__proto__") return null;
    const value = line.slice(at + 1);
    out[key] = separator === ":" ? value.trim() : value.replace(/\r$/, "");
  }
  return out;
}

interface Draft {
  readonly kind: Kind;
  readonly name: string;
  readonly command: string;
  readonly args: string;
  readonly url: string;
  readonly env: string;
  readonly headers: string;
}
const EMPTY: Draft = { kind: "stdio", name: "", command: "", args: "", url: "", env: "", headers: "" };

/** The entry the form describes, or `null` while a field is not valid. `linesBad`: env or headers has a bad line. */
function entryOf(draft: Draft): { entry: Record<string, unknown> | null; linesBad: boolean } {
  const extra = pairLines(
    draft.kind === "stdio" ? draft.env : draft.headers,
    draft.kind === "stdio" ? "=" : ":",
  );
  if (extra === null) return { entry: null, linesBad: true };
  const nameOk = SERVER_NAME.test(draft.name) && !RESERVED.has(draft.name);
  if (draft.kind === "stdio") {
    if (!nameOk || draft.command.trim() === "") return { entry: null, linesBad: false };
    const args = draft.args
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim() !== "");
    return {
      entry: {
        command: draft.command.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(extra === undefined ? {} : { env: extra }),
      },
      linesBad: false,
    };
  }
  const url = draft.url.trim();
  const parsed = parseUrl(url);
  const valid = parsed !== null && /^https?:$/.test(parsed.protocol);
  if (!nameOk || !valid) return { entry: null, linesBad: false };
  return { entry: { url, ...(extra === undefined ? {} : { headers: extra }) }, linesBad: false };
}

/**
 * Settings › MCP › Add server (M7R101, M7R102): a form or a pasted config. The save target (Global, or This project
 * with its path) comes first. Add sends `mcp.add` once per server: a project target after "Save anyway?" with
 * `confirmProtected`, a global one through the password step-up (M7R133). The entry may hold literal secrets: it is
 * sent in the call and nowhere else, never logged, never in a URL.
 */
export function AddServer(props: {
  readonly stepUp: StepUpRunner;
  readonly cwd: string | undefined;
  readonly project: McpFileView | null;
  readonly writes: ReturnType<typeof useMcpWrites>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // After a successful add the panel closes and focus goes back to the button that opened it (M1).
  const close = () => {
    setOpen(false);
    box.current?.querySelector<HTMLElement>("[data-add-open]")?.focus();
  };
  return (
    <div ref={box} className="flex flex-col items-start gap-s2">
      <Button data-add-open aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("settingsMcp.add.open")}
      </Button>
      {open ? <AddPanel {...props} onClose={close} onDone={close} /> : null}
    </div>
  );
}

function AddPanel({
  stepUp,
  cwd,
  project,
  writes,
  onClose,
  onDone,
}: {
  readonly stepUp: StepUpRunner;
  readonly cwd: string | undefined;
  readonly project: McpFileView | null;
  readonly writes: ReturnType<typeof useMcpWrites>;
  onClose(): void;
  onDone(): void;
}) {
  const t = useT();
  const projectOk = cwd !== undefined && project !== null && project.trusted !== false;
  const [scope, setScope] = useState<Scope>("global");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [candidates, setCandidates] = useState<readonly Candidate[]>([]);
  const [ask, setAsk] = useState<{ items: readonly Candidate[]; left(list: Candidate[]): void } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The panel takes focus when it opens, so a keyboard user lands in it (M1).
  useEffect(() => panel.current?.focus(), []);
  const set = (patch: Partial<Draft>) => setDraft((all) => ({ ...all, ...patch }));
  const { entry, linesBad } = entryOf(draft);

  const send = (items: readonly Candidate[], confirmed: boolean, left: (list: Candidate[]) => void) =>
    void writes.run("add", async () => {
      const rpc = getRuntime().rpc;
      const remaining: Candidate[] = [];
      const failures: string[] = [];
      let stopped = false;
      for (const item of items) {
        if (stopped) {
          remaining.push(item);
          continue;
        }
        const call = (commandId: string) =>
          rpc.call(
            "mcp.add",
            {
              scope,
              name: item.name,
              entry: item.entry,
              ...(cwd === undefined ? {} : { cwd }),
              ...(confirmed ? { confirmProtected: true as const } : {}),
            },
            { commandId },
          );
        try {
          // A global add brings a command into Pi's own config: it takes the password step-up (M7R133).
          if (scope === "global") {
            if ((await stepUp(call)) === null) {
              stopped = true;
              remaining.push(item);
            }
          } else await call(rpc.newCommandId());
        } catch (failure) {
          remaining.push(item);
          failures.push(
            t("settingsMcp.add.failedOne", {
              name: escapeHidden(item.name),
              reason: mcpFailureText(failure, "add"),
            }),
          );
        }
      }
      if (remaining.length === 0) onDone();
      else left(remaining);
      const added = items.length - remaining.length;
      // A partial failure still says how many went in (M8); the failed ones stay listed for another try.
      if (failures.length > 0)
        return {
          tone: "error",
          text: [added > 0 ? t("settingsMcp.add.done", { count: added }) : "", ...failures]
            .filter(Boolean)
            .join(" "),
        };
      return added > 0 ? { tone: "status", text: t("settingsMcp.add.done", { count: added }) } : null;
    });

  const submit = (items: readonly Candidate[], left: (list: Candidate[]) => void) => {
    if (scope === "project") setAsk({ items, left });
    else send(items, false, left);
  };

  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="group"
      aria-label={t("settingsMcp.add.open")}
      className="flex w-full flex-col gap-s4 focus:outline-none"
    >
      <section className="flex flex-col items-start gap-s2" aria-label={t("settingsMcp.add.target")}>
        <Heading level={3} variant="group">
          {t("settingsMcp.add.target")}
        </Heading>
        <div className="flex gap-s2">
          <Button
            variant={scope === "global" ? "primary" : "secondary"}
            aria-pressed={scope === "global"}
            disabled={ask !== null}
            onClick={() => setScope("global")}
          >
            {t("settingsMcp.add.global")}
          </Button>
          <Button
            variant={scope === "project" ? "primary" : "secondary"}
            aria-pressed={scope === "project"}
            disabled={!projectOk || ask !== null}
            onClick={() => setScope("project")}
          >
            {t("settingsMcp.add.project")}
          </Button>
        </div>
        {scope === "global" ? <p className="text-ui text-muted">{t("settingsMcp.add.globalPath")}</p> : null}
        {project !== null ? (
          <p className="text-ui text-muted">
            {t("settingsMcp.add.projectPath", { path: escapeHidden(project.path) })}
          </p>
        ) : (
          <p className="text-ui text-muted">{t("settingsMcp.add.projectNone")}</p>
        )}
        {project !== null && !projectOk ? (
          <p className="text-ui text-muted">{t("settingsMcp.project.untrusted")}</p>
        ) : null}
      </section>
      {ask !== null ? (
        <ProtectedAsk
          path={project?.path ?? ""}
          disabled={writes.busy}
          onSave={() => {
            setAsk(null);
            send(ask.items, true, ask.left);
          }}
          onCancel={() => setAsk(null)}
        />
      ) : null}
      <div className="flex flex-col items-start gap-s2">
        <div className="flex gap-s2" role="group" aria-label={t("settingsMcp.add.kind")}>
          {(["stdio", "http"] as const).map((kind) => (
            <Button
              key={kind}
              variant={draft.kind === kind ? "primary" : "secondary"}
              aria-pressed={draft.kind === kind}
              onClick={() => set({ kind })}
            >
              {t(kind === "stdio" ? "settingsMcp.add.kind.stdio" : "settingsMcp.add.kind.http")}
            </Button>
          ))}
        </div>
        <TextField
          label={t("settingsMcp.add.name")}
          hint={t("settingsMcp.add.nameHint")}
          value={draft.name}
          autoComplete="off"
          onChange={(name) => set({ name })}
        />
        {draft.kind === "stdio" ? (
          <>
            <TextField
              label={t("settingsMcp.add.command")}
              value={draft.command}
              autoComplete="off"
              onChange={(command) => set({ command })}
            />
            <TextField
              label={t("settingsMcp.add.args")}
              value={draft.args}
              multiline
              mono
              rows={3}
              onChange={(args) => set({ args })}
            />
            <TextField
              label={t("settingsMcp.add.env")}
              value={draft.env}
              multiline
              mono
              rows={3}
              autoComplete="off"
              error={linesBad ? t("settingsMcp.add.linesBad") : null}
              onChange={(env) => set({ env })}
            />
          </>
        ) : (
          <>
            <TextField
              label={t("settingsMcp.add.url")}
              value={draft.url}
              autoComplete="off"
              onChange={(url) => set({ url })}
            />
            <TextField
              label={t("settingsMcp.add.headers")}
              value={draft.headers}
              multiline
              mono
              rows={3}
              autoComplete="off"
              error={linesBad ? t("settingsMcp.add.linesBad") : null}
              onChange={(headers) => set({ headers })}
            />
          </>
        )}
        <Button
          variant="primary"
          disabled={entry === null || writes.busy}
          onClick={() => entry !== null && submit([{ name: draft.name, entry }], () => {})}
        >
          {t("settingsMcp.add.submit")}
        </Button>
      </div>
      <ImportPaste
        candidates={candidates}
        busy={writes.busy}
        onCandidates={setCandidates}
        onAdd={(items) => submit(items, setCandidates)}
      />
      <div>
        <Button onClick={onClose}>{t("settingsMcp.add.close")}</Button>
      </div>
    </div>
  );
}
