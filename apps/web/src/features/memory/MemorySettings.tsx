import "./register-memory-catalog.ts";
import { type MemoryScopeRef, type MemoryScopeView, memoryMethods } from "@pap/contracts";
import { Button, Select } from "@pap/ui";
import { useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { type Translate, useLocale, useT } from "../../i18n/index.ts";
import { useVmStatus } from "../../lib/use-vm-status.ts";
import { getRuntime } from "../../runtime/index.ts";
import { cutUnits, stripHidden } from "../../lib/untrusted-text.ts";
import { MemoryList } from "./MemoryList.tsx";
import { scopeKey } from "./memory.vm.ts";
import { ReviewList } from "./ReviewList.tsx";
import { useRpcRead } from "./use-rpc-read.ts";

const ask = async (method: "memory.status" | "memory.scopes" | "memory.staged") =>
  getRuntime().rpc.call(method, {});

function scopeLabel(view: MemoryScopeView, t: Translate): string {
  if (view.scope.kind === "user") return t("memory.scope.user");
  const name = view.label ?? view.scope.id;
  return t(view.scope.kind === "project" ? "memory.scope.project" : "memory.scope.agent", { name });
}

/**
 * Settings › Memory (M11R150, M11R151): pi-mem0's state, the facts waiting for the owner, and one scope's memories.
 * pi-mem0 owns the memories; pap reads its snapshots and writes requests it applies later.
 */
export function MemorySettings({ initialScope }: { readonly initialScope?: MemoryScopeRef }) {
  const t = useT();
  const locale = useLocale();
  const [now] = useState(() => Date.now());
  const vm = useVmStatus().status?.runtime === "vm";
  const [picked, setPicked] = useState(initialScope === undefined ? "user" : scopeKey(initialScope));
  const status = useRpcRead(
    "status",
    true,
    async () => memoryMethods["memory.status"].result.parse(await ask("memory.status")),
    "memory_read_failed",
  );
  const installed = status.load.kind === "ready" && status.load.value.installed;
  const scopes = useRpcRead(
    "scopes",
    installed,
    async () => memoryMethods["memory.scopes"].result.parse(await ask("memory.scopes")).scopes,
    "memory_read_failed",
  );
  const staged = useRpcRead(
    "staged",
    installed,
    async () => memoryMethods["memory.staged"].result.parse(await ask("memory.staged")).facts,
    "memory_read_failed",
  );

  if (status.load.kind === "loading")
    return (
      <p role="status" className="text-ui text-muted">
        {t("memory.loading")}
      </p>
    );
  if (status.load.kind === "failed")
    return (
      <div className="flex flex-col items-start gap-s2">
        <p role="alert" className="text-ui text-attn">
          {t("memory.status.failed")}
        </p>
        <Button onClick={status.reload}>{t("memory.retry")}</Button>
      </div>
    );

  const state = status.load.value;
  const options = scopes.load.kind === "ready" ? scopes.load.value : [];
  const current = options.find((option) => scopeKey(option.scope) === picked) ?? options[0];
  const watcher =
    state.watcher === "fresh" && state.checkedAt !== null
      ? t("memory.status.fresh", { age: formatAge(now, state.checkedAt, t) })
      : state.watcher === "stale"
        ? t("memory.status.stale")
        : t("memory.status.unknown");

  const capturedMs = state.lastCaptureAt === null ? Number.NaN : Date.parse(state.lastCaptureAt);
  const capturedAt = Number.isFinite(capturedMs) ? new Date(capturedMs).toLocaleString(locale) : null;

  return (
    <div data-memory-settings="" className="flex flex-col gap-s6">
      <p className="text-ui text-muted">{t("memory.intro")}</p>
      {vm ? <p className="text-ui text-attn">{t("memory.vmNote")}</p> : null}
      <section data-slot="memory-status" className="flex flex-col gap-s1">
        {state.installed ? (
          <>
            <p className={`text-ui ${state.watcher === "stale" ? "text-attn" : "text-fg"}`}>{watcher}</p>
            <p className="text-ui text-muted">{t("memory.residual")}</p>
            {state.lastCaptureError === null ? null : (
              <div data-slot="memory-capture-error" className="flex flex-col gap-s1">
                {capturedAt === null ? null : (
                  <p className="text-ui text-muted">{t("memory.capture.since", { time: capturedAt })}</p>
                )}
                <p className="label-hud text-attn">{t("memory.capture.failed")}</p>
                <p className="whitespace-pre-wrap break-words font-mono text-code text-muted">
                  {stripHidden(cutUnits(state.lastCaptureError, 300))}
                </p>
              </div>
            )}
          </>
        ) : (
          <p role="status" className="text-ui text-attn">
            {t("memory.status.notInstalled")}
          </p>
        )}
      </section>
      {installed && staged.load.kind === "failed" ? (
        <FeedFailure text={t("memory.review.failed")} onRetry={staged.reload} />
      ) : null}
      {installed && staged.load.kind === "ready" ? (
        <ReviewList facts={staged.load.value} onChanged={staged.reload} />
      ) : null}
      {installed && scopes.load.kind === "failed" ? (
        <FeedFailure text={t("memory.scopes.failed")} onRetry={scopes.reload} />
      ) : null}
      {installed && current !== undefined ? (
        <div className="flex flex-col gap-s3">
          <div data-slot="memory-scope">
            <Select
              label={t("memory.scope")}
              value={scopeKey(current.scope)}
              options={options.map((option) => ({
                value: scopeKey(option.scope),
                label: scopeLabel(option, t),
              }))}
              onChange={setPicked}
            />
          </div>
          <MemoryList key={scopeKey(current.scope)} scope={current.scope} />
        </div>
      ) : null}
    </div>
  );
}

function FeedFailure({ text, onRetry }: { readonly text: string; onRetry(): void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-s2">
      <p role="alert" className="text-ui text-attn">
        {text}
      </p>
      <Button onClick={onRetry}>{t("memory.retry")}</Button>
    </div>
  );
}
