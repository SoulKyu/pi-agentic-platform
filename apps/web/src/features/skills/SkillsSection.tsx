import "./register-skills-catalog.ts";
import type { PluginView, SkillView } from "@pap/contracts";
import { Button, Heading, InlineError } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { PluginInstall } from "./PluginInstall.tsx";
import { PluginList } from "./PluginList.tsx";
import { ProtectedAsk } from "./ProtectedAsk.tsx";
import { SkillList } from "./SkillList.tsx";
import { SkillSearch } from "./SkillSearch.tsx";
import { pluginKey, pluginRowText, skillRowText, type InstallScope, type ProjectRef } from "./skills.vm.ts";
import { useSkillWrites, type Notice } from "./use-skill-writes.ts";
import { useSkillsData } from "./use-skills-data.ts";

// Review opens the trust dialog of the trust feature, fetched on first use; it asks the shell's password prompt itself (MC49).
const loadTrustDialog = () =>
  import("../trust/TrustDialog.tsx").then((module) => ({ default: module.TrustDialog }));

const protect = (confirmed: boolean) => (confirmed ? { confirmProtected: true as const } : {});

/** A write that waits for "Save anyway?" when it changes a project's `.pi/` folder (M7R133): `go` gets the answer. */
interface Pending {
  readonly go: (confirmed: boolean) => void;
}

/**
 * Settings › Skills (M7R118): skills and Pi packages by scope, with group switches and per-item results, a search on
 * skills.sh and the install cards. One write at a time; the lists are read again after each. A project write asks
 * "Save anyway?", an install or update for all projects takes the shell's password step-up (M7R133, M7R140).
 */
export function SkillsSection({ project }: { readonly project: ProjectRef | null }) {
  // A folder change starts a fresh panel: the ask, the refusals and the typed sources belong to one folder.
  return <SkillsPanel key={project?.root ?? ""} project={project} />;
}

function SkillsPanel({ project }: { readonly project: ProjectRef | null }) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const lazyText = useLazyFailureText();
  const cwd = project?.root;
  const data = useSkillsData(cwd);
  const writes = useSkillWrites(data.reload);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map());
  const rpc = () => getRuntime().rpc;
  const where = cwd === undefined ? {} : { cwd };

  const guarded = (isProject: boolean, go: (confirmed: boolean) => void) => {
    if (isProject) setPending({ go });
    else go(false);
  };
  const withId = <T,>(call: (commandId: string) => Promise<T>) => call(rpc().newCommandId());
  const write = (action: "write" | "install" | "update", job: () => Promise<Notice | null>) =>
    void writes.run(action, async () => {
      setRefused(new Map());
      return job();
    });

  const setInvocation = (rows: readonly SkillView[], on: boolean) =>
    guarded(
      rows.some((row) => row.scope === "project"),
      (confirmed) =>
        write("write", async () => {
          const answer = await withId((commandId) =>
            rpc().call(
              "skills.setInvocation",
              {
                items: rows.map((row) => ({ path: row.path, disabled: !on })),
                ...where,
                ...protect(confirmed),
              },
              { commandId },
            ),
          );
          const names = new Map(rows.map((row) => [row.path, row.name]));
          setRefused(
            new Map(
              answer.results
                .filter((row) => !row.ok)
                .map((row) => [row.path, skillRowText(names.get(row.path) ?? row.path, row.code)]),
            ),
          );
          return null;
        }),
    );

  const setEnabled = (rows: readonly PluginView[], enabled: boolean) =>
    guarded(
      rows.some((row) => row.scope === "project"),
      (confirmed) =>
        write("write", async () => {
          const answer = await withId((commandId) =>
            rpc().call(
              "plugins.setEnabled",
              {
                items: rows.map((row) => ({ source: row.source, scope: row.scope })),
                enabled,
                ...where,
                ...protect(confirmed),
              },
              { commandId },
            ),
          );
          setRefused(
            new Map(
              answer.results
                .filter((row) => !row.ok)
                .map((row) => [pluginKey(row), pluginRowText(row.source, row.code)]),
            ),
          );
          return null;
        }),
    );

  const remove = (row: PluginView) =>
    guarded(row.scope === "project", (confirmed) =>
      write("write", async () => {
        await withId((commandId) =>
          rpc().call(
            "plugins.remove",
            { source: row.source, scope: row.scope, ...where, ...protect(confirmed) },
            { commandId },
          ),
        );
        return { tone: "status", text: t("settingsSkills.plugin.removed", { source: row.source }) };
      }),
    );

  const update = (scope: PluginView["scope"]) =>
    guarded(scope === "project", (confirmed) =>
      write("update", async () => {
        const call = (commandId: string) =>
          rpc().call("plugins.update", { scope, ...where, ...protect(confirmed) }, { commandId });
        // An update of the owner's packages runs their code's installer: it takes the password step-up (M7R133).
        const answer = scope === "user" ? await stepUp(call) : await withId(call);
        if (answer === null) return null;
        return {
          tone: "status",
          text:
            answer.updated.length === 0
              ? t("settingsSkills.plugin.noUpdate")
              : t("settingsSkills.plugin.updated", { count: answer.updated.length }),
        };
      }),
    );

  const installSkill = (source: string, scope: InstallScope) =>
    guarded(scope === "project", (confirmed) =>
      write("install", async () => {
        const call = (commandId: string) =>
          rpc().call(
            "skills.install",
            scope === "global" ? { source, scope } : { source, scope, ...where, ...protect(confirmed) },
            { commandId },
          );
        const done = scope === "global" ? await stepUp(call) : await withId(call);
        return done === null ? null : { tone: "status", text: t("settingsSkills.install.done", { source }) };
      }),
    );

  const installPlugin = (source: string, scope: InstallScope) =>
    guarded(scope === "project", (confirmed) =>
      write("install", async () => {
        const target = scope === "global" ? "user" : "project";
        const call = (commandId: string) =>
          rpc().call(
            "plugins.install",
            target === "user"
              ? { source, scope: target }
              : { source, scope: target, ...where, ...protect(confirmed) },
            { commandId },
          );
        const done = target === "user" ? await stepUp(call) : await withId(call);
        return done === null
          ? null
          : { tone: "status", text: t("settingsSkills.plugin.install.done", { source }) };
      }),
    );

  if (data.skills === null || data.plugins === null)
    return (
      <div data-skills-section className="flex flex-col items-start gap-s2">
        {data.error ? (
          <>
            <InlineError announce="background">{data.error}</InlineError>
            <Button onClick={data.reload}>{t("settingsSkills.retry")}</Button>
          </>
        ) : (
          <p role="status" className="text-ui text-muted">
            {t("settingsSkills.loading")}
          </p>
        )}
      </div>
    );

  return (
    <div data-skills-section className="flex flex-col gap-s4">
      <p className="text-ui text-muted">{t("settingsSkills.intro")}</p>
      {data.error ? <InlineError announce="background">{data.error}</InlineError> : null}
      {writes.notice ? (
        writes.notice.tone === "error" ? (
          <InlineError announce="action">{writes.notice.text}</InlineError>
        ) : (
          <p role="status" className="text-ui text-muted">
            {writes.notice.text}
          </p>
        )
      ) : null}
      {pending !== null && project !== null ? (
        <ProtectedAsk
          path={`${project.root}/.pi`}
          disabled={writes.busy}
          onSave={() => {
            setPending(null);
            pending.go(true);
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {project === null ? <p className="text-ui text-muted">{t("settingsSkills.project.none")}</p> : null}
      {data.needsTrust ? (
        <div className="flex flex-col items-start gap-s2">
          <p className="text-ui text-attn">{t("settingsSkills.project.untrusted")}</p>
          <Button onClick={() => setReviewing(true)}>{t("settingsSkills.project.review")}</Button>
        </div>
      ) : null}
      <section className="flex flex-col gap-s2">
        <Heading level={3} variant="group">
          {t("settingsSkills.skills.title")}
        </Heading>
        <SkillList
          skills={data.skills.skills}
          busy={writes.busy}
          refused={refused}
          hideProject={project === null}
          handlers={{
            onGroup: (_id, rows, on) => setInvocation(rows, on),
            onRow: (row, on) => setInvocation([row], on),
          }}
        />
      </section>
      <SkillSearch
        project={project}
        needsTrust={data.needsTrust}
        busy={writes.busy}
        onInstall={installSkill}
      />
      <section className="flex flex-col gap-s2">
        <Heading level={3} variant="group">
          {t("settingsSkills.plugins.title")}
        </Heading>
        <PluginList
          plugins={data.plugins.plugins}
          busy={writes.busy}
          refused={refused}
          hideProject={project === null}
          handlers={{
            onGroup: (_scope, rows, enabled) => setEnabled(rows, enabled),
            onRow: (row, enabled) => setEnabled([row], enabled),
            onRemove: remove,
            onUpdate: update,
          }}
        />
      </section>
      <PluginInstall
        project={project}
        needsTrust={data.needsTrust}
        busy={writes.busy}
        onInstall={installPlugin}
      />
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
              data.reload();
            },
          }}
          onFailed={() => setReviewing(false)}
        />
      )}
    </div>
  );
}
