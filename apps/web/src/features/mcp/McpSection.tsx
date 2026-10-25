import "./register-mcp-catalog.ts";
import type { McpServerView, McpTestResult } from "@pap/contracts";
import { Button, InlineError, useIsPhone } from "@pap/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { AddServer } from "./AddServer.tsx";
import { CodemodePane, type CodemodePatch } from "./CodemodePane.tsx";
import { rowFailureText, serverKey } from "./mcp.vm.ts";
import { ProtectedAsk } from "./ProtectedAsk.tsx";
import { ServerDetail } from "./ServerDetail.tsx";
import { ServerList } from "./ServerList.tsx";
import type { StepUpRunner } from "./step-up.ts";
import { UndoToast, type UndoOffer } from "./UndoToast.tsx";
import { useMcpOverview } from "./use-mcp-overview.ts";
import { useMcpWrites } from "./use-mcp-writes.ts";

// Review opens the trust dialog of the trust feature, fetched on first use; it asks the shell's password prompt itself.
const loadTrustDialog = () =>
  import("../trust/TrustDialog.tsx").then((module) => ({ default: module.TrustDialog }));

const protect = (confirmed: boolean) => (confirmed ? { confirmProtected: true as const } : {});

/** A write that waits for "Save anyway?" when it changes a project's `.pi/mcp.json` (M7R133): `go` gets the answer. */
interface Pending {
  readonly go: (confirmed: boolean) => void;
}

/**
 * Settings › MCP (M7R98): servers grouped Global / Project with switches, the detail pane, exposure, Remove with a
 * minute to undo, Test, and the code mode pane. One write at a time (M7R100); the overview is read again after each.
 */
export function McpSection(props: { readonly stepUp: StepUpRunner; readonly cwd: string | undefined }) {
  // A folder change starts a fresh panel: selection, ask, undo offer and Test results belong to one folder (MC46 I2).
  return <McpPanel key={props.cwd ?? ""} {...props} />;
}

function McpPanel({ stepUp, cwd }: { readonly stepUp: StepUpRunner; readonly cwd: string | undefined }) {
  const t = useT();
  const phone = useIsPhone();
  const list = useMcpOverview(cwd);
  const overview = list.value;
  const writes = useMcpWrites(list.reload);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const lazyText = useLazyFailureText();
  const [undo, setUndo] = useState<UndoOffer | null>(null);
  const [results, setResults] = useState<Readonly<Record<string, McpTestResult>>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // After an Undo, focus goes to the restored row once the next overview shows it, else to the panel (M1).
  const focusAfter = useRef<{ key: string; since: unknown } | null>(null);
  useEffect(() => {
    const wanted = focusAfter.current;
    if (wanted === null || overview === wanted.since) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-server="${CSS.escape(wanted.key)}"]`);
    (row ?? root.current)?.focus();
    focusAfter.current = null;
  }, [overview]);
  const expire = useCallback(() => setUndo(null), []);
  const rpc = () => getRuntime().rpc;
  const where = cwd === undefined ? {} : { cwd };

  if (overview === null)
    return (
      <div data-mcp-section className="flex flex-col items-start gap-s2">
        {list.error ? (
          <>
            <InlineError announce="background">{list.error}</InlineError>
            <Button onClick={list.reload}>{t("settingsMcp.retry")}</Button>
          </>
        ) : (
          <p role="status" className="text-ui text-muted">
            {t("settingsMcp.loading")}
          </p>
        )}
      </div>
    );

  const guarded = (scope: "global" | "project", go: (confirmed: boolean) => void) => {
    if (scope === "project") setPending({ go });
    else go(false);
  };
  const withId = <T,>(call: (commandId: string) => Promise<T>) => call(rpc().newCommandId());

  const setEnabled = (scope: "global" | "project", servers: readonly McpServerView[], enabled: boolean) =>
    guarded(
      scope,
      (confirmed) =>
        void writes.run("write", async () => {
          const answer = await withId((commandId) =>
            rpc().call(
              "mcp.setEnabled",
              {
                servers: servers.map((server) => ({ scope: server.scope, name: server.name })),
                enabled,
                ...where,
                ...protect(confirmed),
              },
              { commandId },
            ),
          );
          const failed = answer.results.filter((row) => !row.ok);
          return failed.length === 0
            ? null
            : { tone: "error", text: failed.map((row) => rowFailureText(row.name, row.code)).join(" ") };
        }),
    );

  const setExposure = (server: McpServerView, exposure: McpServerView["exposure"]) =>
    guarded(
      server.scope,
      (confirmed) =>
        void writes.run("write", async () => {
          await withId((commandId) =>
            rpc().call(
              "mcp.setExposure",
              { scope: server.scope, name: server.name, exposure, ...where, ...protect(confirmed) },
              { commandId },
            ),
          );
          return null;
        }),
    );

  const setInProject = (server: McpServerView, enabled: boolean) => {
    if (cwd === undefined) return;
    guarded(
      "project",
      (confirmed) =>
        void writes.run("write", async () => {
          await withId((commandId) =>
            rpc().call(
              "mcp.setInProject",
              { name: server.name, enabled, cwd, ...protect(confirmed) },
              { commandId },
            ),
          );
          return null;
        }),
    );
  };

  const remove = (server: McpServerView) =>
    guarded(
      server.scope,
      (confirmed) =>
        void writes.run("remove", async () => {
          const removed = await withId((commandId) =>
            rpc().call(
              "mcp.remove",
              { scope: server.scope, name: server.name, ...where, ...protect(confirmed) },
              { commandId },
            ),
          );
          setUndo({
            token: removed.token,
            scope: server.scope,
            name: server.name,
            expiresInMs: removed.expiresInMs,
          });
          setSelected(null);
          return null;
        }),
    );

  const undoRemoval = (offer: UndoOffer) =>
    guarded(
      offer.scope,
      (confirmed) =>
        void writes.run("undo", async () => {
          const call = (commandId: string) =>
            rpc().call("mcp.undo", { token: offer.token, ...protect(confirmed) }, { commandId });
          // A global undo brings a command back into Pi's own config: it takes the password step-up (M7R133).
          if (offer.scope === "global") {
            if ((await stepUp(call)) === null) return null;
          } else await withId(call);
          setUndo(null);
          focusAfter.current = { key: serverKey(offer), since: overview };
          return { tone: "status", text: t("settingsMcp.undone", { name: offer.name }) };
        }),
    );

  const test = (server: McpServerView) =>
    void writes.run("test", async () => {
      const key = serverKey(server);
      setTesting(key);
      return stepUp((commandId) =>
        rpc().call("mcp.test", { scope: server.scope, name: server.name, ...where }, { commandId }),
      )
        .then((result) => {
          if (result !== null) setResults((all) => ({ ...all, [key]: result }));
          return null;
        })
        .finally(() => setTesting(null));
    });

  const setCodemode = (patch: CodemodePatch) =>
    void writes.run("codemode", async () => {
      await withId((commandId) => rpc().call("mcp.setCodemode", patch, { commandId }));
      return { tone: "status", text: t("settingsMcp.codemode.saved") };
    });

  const all = [...overview.global.servers, ...(overview.project?.servers ?? [])];
  const server = all.find((one) => serverKey(one) === selected) ?? null;
  const fileOf = (one: McpServerView) => (one.scope === "global" ? overview.global : overview.project);
  const override =
    server !== null &&
    server.scope === "global" &&
    overview.project !== null &&
    overview.project.trusted !== false
      ? (overview.project.servers.find((one) => one.name === server.name && one.kind === "override") ?? null)
      : null;
  const inProject =
    server !== null &&
    server.scope === "global" &&
    cwd !== undefined &&
    overview.project !== null &&
    overview.project.trusted !== false
      ? (override?.enabled ?? server.enabled)
      : null;

  return (
    <div ref={root} tabIndex={-1} data-mcp-section className="flex flex-col gap-s4 focus:outline-none">
      <div className="flex max-w-settings flex-col gap-s4">
        <p className="text-ui text-muted">{t("settingsMcp.intro")}</p>
        {list.error ? <InlineError announce="background">{list.error}</InlineError> : null}
        {writes.notice ? (
          writes.notice.tone === "error" ? (
            <InlineError announce="action">{writes.notice.text}</InlineError>
          ) : (
            <p role="status" className="text-ui text-muted">
              {writes.notice.text}
            </p>
          )
        ) : null}
        {pending !== null ? (
          <ProtectedAsk
            path={overview.project?.path ?? ""}
            disabled={writes.busy}
            onSave={() => {
              setPending(null);
              pending.go(true);
            }}
            onCancel={() => setPending(null)}
          />
        ) : null}
        {undo !== null ? (
          <UndoToast
            key={undo.token}
            offer={undo}
            disabled={writes.busy}
            onUndo={() => undoRemoval(undo)}
            onExpire={expire}
          />
        ) : null}
      </div>
      <div className={phone ? "flex flex-col gap-s4" : "flex items-start gap-s4"}>
        <div className={phone ? "" : "w-64 shrink-0"}>
          <ServerList
            global={overview.global}
            project={overview.project}
            selected={selected}
            busy={writes.busy}
            handlers={{
              onSelect: setSelected,
              onGroup: setEnabled,
              onRow: (row, enabled) => setEnabled(row.scope, [row], enabled),
              ...(cwd === undefined ? {} : { onReviewTrust: () => setReviewing(true) }),
            }}
          />
        </div>
        {server !== null ? (
          <ServerDetail
            key={serverKey(server)}
            server={server}
            busy={writes.busy}
            untrusted={fileOf(server)?.trusted === false}
            testing={testing === serverKey(server)}
            result={results[serverKey(server)] ?? null}
            inProject={inProject}
            handlers={{
              onExposure: (exposure) => setExposure(server, exposure),
              onRemove: () => remove(server),
              onTest: () => test(server),
              onInProject: (enabled) => setInProject(server, enabled),
            }}
          />
        ) : (
          <p className="text-ui text-muted">{t("settingsMcp.pick")}</p>
        )}
      </div>
      {cwd === undefined ? null : (
        <LazyPanel
          text={lazyText}
          load={loadTrustDialog}
          open={reviewing}
          props={{
            cwd,
            onClose: () => setReviewing(false),
            onDecided: () => {
              setReviewing(false);
              list.reload();
            },
          }}
          onFailed={() => setReviewing(false)}
        />
      )}
      <div className="flex max-w-settings flex-col gap-s4">
        <AddServer stepUp={stepUp} cwd={cwd} project={overview.project} writes={writes} />
        <CodemodePane
          settings={overview.settings}
          builtinOff={overview.codemodeBuiltinOff}
          busy={writes.busy}
          onChange={setCodemode}
        />
      </div>
    </div>
  );
}
