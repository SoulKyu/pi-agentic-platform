import "../../i18n/register-github.ts";
import { GITHUB_WEB_ORIGIN, type GithubStatusView } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useState, type ReactNode } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { DeleteAppDialog } from "./DeleteAppDialog.tsx";
import { createPageUrl, githubUrl, urlRefused } from "./github-errors.ts";
import { useGithubAction } from "./use-github-action.ts";
import { useGithubStatus } from "./use-github-status.ts";

interface Props {
  /** The password prompt of the Settings host (M7R70): `null` means the person cancelled it. */
  readonly stepUp: StepUpRunner;
  /** A top-level navigation (the daemon's own pages link back into the app); tests give their own. */
  readonly go?: (url: string) => void;
}

const goTo = (url: string): void => window.location.assign(url);
const openTab = (url: string): void => void window.open(url, "_blank", "noopener,noreferrer");

/** The callback URL to paste on GitHub when pap is reached at another address than at the App's creation. */
const callbackUrl = (): string => `${window.location.origin}/github/app/authorized`;

function Row({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-s2">{children}</div>;
}

/**
 * Settings › GitHub (boxes lot B2): the App's state in words, then the one or two actions it allows. Neutral while no App
 * exists, attention when something waits for the owner (authorize, sign in again, a missing permission), red only when a
 * call failed. Delete asks the owner's password.
 */
export function GithubSettings({ stepUp, go }: Props) {
  const t = useT();
  const navigate = go ?? goTo;
  const { state, reload } = useGithubStatus();
  const [deleting, setDeleting] = useState(false);
  const create = useGithubAction();
  const authorize = useGithubAction();
  const disconnect = useGithubAction();

  if (state.kind === "loading")
    return (
      <p role="status" className="text-ui text-muted">
        {t("github.settings.loading")}
      </p>
    );
  if (state.kind === "failed")
    return (
      <p role="status" className="text-ui text-err">
        {t("github.settings.failed")}
      </p>
    );

  const status: GithubStatusView = state.status;
  // The App's settings (its permissions page) are under /settings/apps/<slug>, not at the public /apps/<slug> page.
  const appUrl =
    status.app === null || githubUrl(status.app.htmlUrl) === null
      ? null
      : `${GITHUB_WEB_ORIGIN}/settings/apps/${encodeURIComponent(status.app.slug)}/permissions`;
  const startCreate = () =>
    create.run(async () => {
      const { postUrl } = await getRuntime().rpc.call(
        "github.startCreate",
        {},
        { commandId: getRuntime().rpc.newCommandId() },
      );
      const page = createPageUrl(postUrl);
      if (page === null) return urlRefused();
      navigate(page);
    });
  const startAuthorize = () =>
    authorize.run(async () => {
      const { url } = await getRuntime().rpc.call(
        "github.authorizeUrl",
        {},
        { commandId: getRuntime().rpc.newCommandId() },
      );
      if (githubUrl(url) === null) return urlRefused();
      navigate(url);
    });
  const startDisconnect = () =>
    disconnect.run(async () => {
      const { rpc } = getRuntime();
      await rpc.call("github.disconnect", {}, { commandId: rpc.newCommandId() });
      reload();
    });
  const openGithub =
    appUrl === null ? null : <Button onClick={() => openTab(appUrl)}>{t("github.openGithub")}</Button>;
  const problem =
    create.problem ??
    authorize.problem ??
    disconnect.problem ??
    (status.app !== null && appUrl === null ? errorKey("github_unavailable") : null);

  return (
    <div data-github-settings="" className="flex max-w-prose flex-col gap-s3">
      {status.state === "absent" ? (
        <>
          <p className="text-ui text-muted">{t("github.absent")}</p>
          <Row>
            <Button variant="primary" pendingSince={create.since} onClick={startCreate}>
              {t("github.create")}
            </Button>
          </Row>
        </>
      ) : null}
      {status.state === "created" ? (
        <>
          <p role="status" className="text-ui text-attn">
            {t("github.created", { slug: status.app?.slug ?? "" })}
          </p>
          <Row>
            <Button variant="primary" pendingSince={authorize.since} onClick={startAuthorize}>
              {t("github.authorize")}
            </Button>
            {openGithub}
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t("github.delete")}
            </Button>
          </Row>
        </>
      ) : null}
      {status.state === "reconnect" ? (
        <>
          <p role="status" className="text-ui text-attn">
            {t("github.reconnectNeeded")}
          </p>
          <Row>
            <Button variant="primary" pendingSince={authorize.since} onClick={startAuthorize}>
              {t("github.reconnect")}
            </Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t("github.delete")}
            </Button>
          </Row>
        </>
      ) : null}
      {status.state === "connected" ? (
        <>
          <p role="status" className="text-ui text-fg">
            {t("github.connected", { login: status.login ?? "" })}
          </p>
          {status.permissionMissing ? (
            <>
              <p role="status" className="text-ui text-attn">
                {t("github.permissionMissing")}
              </p>
              <Row>
                {openGithub}
                <Button variant="primary" pendingSince={authorize.since} onClick={startAuthorize}>
                  {t("github.reconnect")}
                </Button>
              </Row>
            </>
          ) : null}
          <Row>
            <Button pendingSince={disconnect.since} onClick={startDisconnect}>
              {t("github.disconnect")}
            </Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t("github.delete")}
            </Button>
          </Row>
        </>
      ) : null}
      {status.app !== null && !status.app.originMatches ? (
        <p role="status" className="break-words text-ui text-attn">
          {t("github.mismatch", { url: callbackUrl() })}
        </p>
      ) : null}
      {problem === null ? null : (
        <p role="status" className="text-ui text-err">
          {t(problem)}
        </p>
      )}
      {deleting ? (
        <DeleteAppDialog
          stepUp={stepUp}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
