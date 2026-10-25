import "./register-space-catalog.ts";
import type { AgentFileView } from "@pap/contracts";
import { Button, EmptyState, Heading, InlineError, TextField, usePendingAction, LoadingLine } from "@pap/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorKey, type MessageKey, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { uploadAgentFile } from "../../runtime/upload.ts";
import { fileSize, importFailure, isAllowedPath, isTooBig } from "./agent-files.vm.ts";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly files: readonly AgentFileView[] }
  | { readonly kind: "failed" };

const HEAD_CLASSES = "label-hud px-s2 py-s1 text-left text-muted";

/**
 * The agent's Files tab (sub-project 2, spec 7): the files pap writes into the agent's home. A row shows the
 * path, the size and the import date, never the content. IMPORT and REPLACE send the raw file to `PUT /agent-files`;
 * REMOVE is irreversible and asks first.
 */
export function AgentFiles({ agentId }: { readonly agentId: string }) {
  const t = useT();
  const locale = useLocale();
  const importing = usePendingAction();
  const removing = usePendingAction();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [path, setPath] = useState("");
  const [chosen, setChosen] = useState<File | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const importPicker = useRef<HTMLInputElement | null>(null);
  const replacePicker = useRef<HTMLInputElement | null>(null);
  const replacing = useRef<string | null>(null);
  const latest = useRef(0);

  const read = useCallback(async () => {
    latest.current += 1;
    const mine = latest.current;
    let next: Load;
    try {
      const answer = await getRuntime().rpc.call("agents.files.list", { agentId });
      next = { kind: "ready", files: answer.files };
    } catch {
      next = { kind: "failed" };
    }
    if (mine === latest.current) setLoad(next);
  }, [agentId]);
  useEffect(() => {
    void read();
    return () => {
      latest.current += 1;
    };
  }, [read]);

  const send = (target: string, file: File, done: () => void) =>
    void importing.run(async () => {
      setProblem(null);
      try {
        await uploadAgentFile(agentId, target, file, new AbortController().signal);
        done();
      } catch (failure) {
        setProblem(importFailure(failure));
      }
      await read();
    });

  const choose = (file: File | undefined) => {
    if (file === undefined) return;
    if (isTooBig(file)) {
      setChosen(null);
      setProblem("agentFiles.error.tooBig");
      return;
    }
    setProblem(null);
    setChosen(file);
    if (path === "" && isAllowedPath(file.name)) setPath(file.name);
  };
  const replace = (file: File | undefined) => {
    const target = replacing.current;
    replacing.current = null;
    if (file === undefined || target === null) return;
    if (isTooBig(file)) setProblem("agentFiles.error.tooBig");
    else send(target, file, () => {});
  };
  const remove = (target: string) =>
    void removing.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        await rpc.call("agents.files.remove", { agentId, path: target }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        setProblem(failure instanceof RpcError ? errorKey(failure.code) : "agentFiles.error.failed");
      }
      setConfirming(null);
      await read();
    });

  const date = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
  const pathAllowed = path === "" || isAllowedPath(path);
  const busy = importing.since !== null;
  const pickFile = () => importPicker.current?.click();
  const files = load.kind === "ready" ? load.files : [];

  return (
    <div data-agent-files="" className="flex min-h-0 min-w-0 flex-1 flex-col gap-s3 overflow-y-auto">
      <h3 className="text-h2 text-fg">{t("agentFiles.title")}</h3>
      <p className="text-ui text-muted">{t("agentFiles.hint")}</p>
      {load.kind === "loading" ? (
        <LoadingLine label={t("agentFiles.loading")} />
      ) : load.kind === "failed" ? (
        <InlineError announce="background">{t("agentFiles.failed")}</InlineError>
      ) : files.length === 0 ? (
        <EmptyState
          title={t("agentFiles.empty.title")}
          purpose={t("agentFiles.empty.purpose")}
          action={
            <Button variant="primary" onClick={pickFile}>
              {t("agentFiles.empty.action")}
            </Button>
          }
        />
      ) : (
        <table className="w-full text-ui">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={HEAD_CLASSES}>
                {t("agentFiles.col.path")}
              </th>
              <th scope="col" className={HEAD_CLASSES}>
                {t("agentFiles.col.size")}
              </th>
              <th scope="col" className={HEAD_CLASSES}>
                {t("agentFiles.col.date")}
              </th>
              <td />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {files.map((file) => (
              <tr key={file.path}>
                <td className="px-s2 py-s2 font-mono text-code text-fg">{file.path}</td>
                <td className="px-s2 py-s2 font-mono tabular-nums text-muted">{fileSize(file.size)}</td>
                <td className="px-s2 py-s2 text-muted">{date(file.importedAt)}</td>
                <td className="px-s2 py-s2">
                  {confirming === file.path ? (
                    <div role="group" aria-label={t("agentFiles.remove.label", { path: file.path })}>
                      <p className="text-ui text-attn">{t("agentFiles.remove.ask", { path: file.path })}</p>
                      <div className="flex gap-s2">
                        <Button
                          variant="danger"
                          pendingSince={removing.since}
                          onClick={() => remove(file.path)}
                        >
                          {t("agentFiles.remove.confirm")}
                        </Button>
                        <Button onClick={() => setConfirming(null)}>{t("agentFiles.remove.keep")}</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-end gap-s2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        aria-label={t("agentFiles.replace.label", { path: file.path })}
                        onClick={() => {
                          replacing.current = file.path;
                          replacePicker.current?.click();
                        }}
                      >
                        {t("agentFiles.replace")}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        aria-label={t("agentFiles.remove.label", { path: file.path })}
                        onClick={() => setConfirming(file.path)}
                      >
                        {t("agentFiles.remove")}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <section className="flex flex-col gap-s2">
        <Heading level={4} variant="group">
          {t("agentFiles.add.title")}
        </Heading>
        <TextField
          label={t("agentFiles.add.path")}
          hint={t("agentFiles.add.path.hint")}
          value={path}
          autoComplete="off"
          disabled={busy}
          {...(pathAllowed ? {} : { error: t("agentFiles.error.path") })}
          onChange={(next) => {
            setPath(next);
            setProblem(null);
          }}
        />
        <div className="flex flex-wrap items-center gap-s2">
          <Button disabled={busy} onClick={pickFile}>
            {t("agentFiles.add.choose")}
          </Button>
          {chosen === null ? null : (
            <span className="font-mono text-label text-muted">
              {t("agentFiles.add.chosen", { name: chosen.name })}
            </span>
          )}
          <Button
            variant="primary"
            disabled={chosen === null || path === "" || !pathAllowed}
            pendingSince={importing.since}
            onClick={() => {
              if (chosen !== null)
                send(path, chosen, () => {
                  setChosen(null);
                  setPath("");
                });
            }}
          >
            {t("agentFiles.add.import")}
          </Button>
        </div>
      </section>
      {problem === null ? null : <InlineError announce="action">{t(problem)}</InlineError>}
      <input
        ref={importPicker}
        type="file"
        hidden
        aria-label={t("agentFiles.add.picker")}
        onChange={(event) => {
          choose(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={replacePicker}
        type="file"
        hidden
        aria-label={t("agentFiles.replace.picker")}
        onChange={(event) => {
          replace(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
