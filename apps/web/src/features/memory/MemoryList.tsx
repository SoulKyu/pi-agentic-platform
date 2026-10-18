import "./register-memory-catalog.ts";
import { MEMORY_LIMITS, type MemoryScopeRef, memoryMethods } from "@pap/contracts";
import { Button, Checkbox, TextField } from "@pap/ui";
import { useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { cutUnits, stripHidden } from "../../lib/untrusted-text.ts";
import { ForgetDialog } from "./ForgetDialog.tsx";
import {
  correctionCounter,
  FORGET_MAX,
  filterItems,
  pruneSelection,
  scopeKey,
  sourceLabel,
  toggleSelection,
} from "./memory.vm.ts";
import { useMemoryCall } from "./use-memory-call.ts";
import { useRpcRead } from "./use-rpc-read.ts";

const CLIP_LABEL = 60;

/** The memories of one scope (M11R150): filter, pick several to forget, promote to the user scope, correct in place. */
export function MemoryList({ scope }: { readonly scope: MemoryScopeRef }) {
  const t = useT();
  const key = scopeKey(scope);
  const { load, reload } = useRpcRead(
    `list:${key}`,
    true,
    async () =>
      memoryMethods["memory.list"].result.parse(await getRuntime().rpc.call("memory.list", { scope })),
    "memory_read_failed",
  );
  const forgetCall = useMemoryCall();
  const saveCall = useMemoryCall();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (load.kind === "loading")
    return (
      <p role="status" className="text-ui text-muted">
        {t("memory.loading")}
      </p>
    );
  if (load.kind === "failed")
    return (
      <div className="flex flex-col items-start gap-s2">
        <p role="alert" className="text-ui text-attn">
          {t("memory.list.failed")}
        </p>
        <Button onClick={reload}>{t("memory.retry")}</Button>
      </div>
    );

  const items = load.value.items;
  const shown = filterItems(items, query);
  const chosen = pruneSelection(picked, items);
  const failed = (code: string) => setProblem(t(errorKey(code)));

  const forget = async () => {
    setProblem(null);
    const result = await forgetCall.call("memory.forget", { scope, ids: [...chosen] });
    if (result === undefined) return;
    if (!result.ok) return failed(result.code);
    setConfirming(false);
    setPicked(new Set());
    setNotice(t("memory.forget.sent"));
    reload();
  };
  const save = async (text: string, replaces: string | null) => {
    setProblem(null);
    const params = replaces === null ? { scope: { kind: "user" as const }, text } : { scope, text, replaces };
    const result = await saveCall.call("memory.save", params);
    if (result === undefined) return;
    if (!result.ok) return failed(result.code);
    setEditing(null);
    setNotice(t("memory.save.sent"));
    reload();
  };

  return (
    <section data-slot="memory-list" aria-label={t("memory.list.title")} className="flex flex-col gap-s3">
      <div className="flex flex-wrap items-end gap-s2">
        <div className="min-w-0 flex-1">
          <TextField label={t("memory.filter")} value={query} onChange={setQuery} />
        </div>
        <span data-slot="memory-forget">
          <Button
            variant="danger"
            disabled={chosen.size === 0}
            onClick={() => {
              setProblem(null);
              setConfirming(true);
            }}
          >
            {chosen.size === 0 ? t("memory.forget.none") : t("memory.forget.some", { n: chosen.size })}
          </Button>
        </span>
      </div>
      {chosen.size >= FORGET_MAX ? (
        <p className="text-ui text-muted">{t("memory.forget.limit", { n: FORGET_MAX })}</p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="text-ui text-muted">
          {notice}
        </p>
      ) : null}
      {problem !== null && !confirming ? (
        <p role="alert" className="text-ui text-attn">
          {problem}
        </p>
      ) : null}
      {items.length === 0 ? <p className="text-ui text-muted">{t("memory.list.empty")}</p> : null}
      {items.length > 0 && shown.length === 0 ? (
        <p className="text-ui text-muted">{t("memory.list.noMatch")}</p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {shown.map((item) => {
            const text = stripHidden(cutUnits(item.text, MEMORY_LIMITS.textChars));
            const brief = cutUnits(text, CLIP_LABEL);
            return (
              <li key={item.id} data-memory-id={item.id} className="flex flex-col gap-s2 p-s2">
                <Checkbox
                  label={text}
                  checked={chosen.has(item.id)}
                  onChange={() => setPicked(toggleSelection(chosen, item.id))}
                />
                <div className="flex flex-wrap items-center gap-s2">
                  {item.source === null ? null : (
                    <span className="font-mono text-label text-muted">
                      {(() => {
                        const label = sourceLabel(stripHidden(item.source));
                        return "params" in label ? t(label.key, label.params) : t(label.key);
                      })()}
                    </span>
                  )}
                  <span className="flex-1" />
                  {scope.kind === "user" ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("memory.promote.label", { text: brief })}
                      pendingSince={saveCall.since}
                      onClick={() => void save(text, null)}
                    >
                      {t("memory.promote")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("memory.correct.label", { text: brief })}
                    onClick={() => setEditing({ id: item.id, text })}
                  >
                    {t("memory.correct")}
                  </Button>
                </div>
                {editing?.id === item.id ? (
                  <CorrectForm
                    text={editing.text}
                    since={saveCall.since}
                    onChange={(next) => setEditing({ id: item.id, text: next })}
                    onSave={() => void save(editing.text, item.id)}
                    onCancel={() => setEditing(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {confirming ? (
        <ForgetDialog
          count={chosen.size}
          problem={problem}
          since={forgetCall.since}
          onConfirm={() => void forget()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
}

interface CorrectFormProps {
  readonly text: string;
  readonly since: number | null;
  onChange(text: string): void;
  onSave(): void;
  onCancel(): void;
}

/** The inline correction: the memory's text, a counter of 4 096, and a save that replaces the memory it came from. */
function CorrectForm({ text, since, onChange, onSave, onCancel }: CorrectFormProps) {
  const t = useT();
  const counter = correctionCounter(text);
  return (
    <div className="flex flex-col gap-s1">
      <TextField
        multiline
        label={t("memory.correct.field")}
        value={text}
        onChange={onChange}
        error={counter.over ? t("memory.correct.over") : null}
      />
      <div className="flex flex-wrap items-center gap-s2">
        <span className={`font-mono text-label tabular-nums ${counter.over ? "text-attn" : "text-muted"}`}>
          {t("memory.correct.counter", { used: counter.used })}
        </span>
        <span className="flex-1" />
        <Button size="sm" onClick={onCancel}>
          {t("memory.correct.cancel")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={counter.over || counter.empty}
          pendingSince={since}
          onClick={onSave}
        >
          {t("memory.correct.save")}
        </Button>
      </div>
    </div>
  );
}
