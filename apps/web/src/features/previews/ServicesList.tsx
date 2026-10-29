import "../../i18n/register-previews.ts";
import { boxKey, type BoxPhase, type BoxRef, type PreviewView } from "@pap/contracts";
import { Button, Chip, InlineError, usePendingAction, type ChipTone } from "@pap/ui";
import { useEffect, useMemo, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { formatAge } from "../../i18n/age.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { LogsButton } from "./LogsButton.tsx";
import { StartDeclared } from "./StartDeclared.tsx";

/** How often "up 5 min" is written again: a local clock, nothing is asked of the daemon. */
const MINUTE_MS = 60_000;
/** The name `previews.startProject` gives the service it starts from `.pi/project.yaml`. */
const PROJECT_SERVICE = "project";

const TONE: Readonly<Record<PreviewView["state"], ChipTone>> = {
  running: "run",
  failed: "err",
  exited: "mut",
  stopped: "mut",
};

function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

interface Props {
  readonly box: BoxRef;
  /** A project box's phase: START PREVIEW for the file's declaration reads the box again when it moves. Agents have none. */
  readonly phase?: BoxPhase;
}

/**
 * The services of one box on its page (UX2-R43): state in words, port, uptime, STOP, RESTART, LOGS and OPEN PREVIEW; for a
 * project box, the preview `.pi/project.yaml` declares with START PREVIEW, which starts only on the owner's click.
 * Nothing before the stream's first snapshot.
 */
export function ServicesList({ box, phase }: Props) {
  const t = useT();
  const services = usePreviewsStore((state) => state.services);
  const ready = usePreviewsStore((state) => state.ready);
  const now = useMinute();
  const key = boxKey(box);
  const rows = useMemo(
    () =>
      [...services.values()]
        .filter((one) => boxKey(one.box) === key)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    [services, key],
  );
  if (!ready) return null;
  const declaring =
    box.kind === "project" &&
    phase !== undefined &&
    !rows.some((one) => one.name === PROJECT_SERVICE && one.state === "running");
  return (
    <section data-services-list="" aria-label={t("previews.list.title")} className="flex flex-col gap-s2">
      <span className="label-hud text-muted">{t("previews.list.title")}</span>
      {rows.length === 0 ? <p className="text-ui text-muted">{t("previews.list.empty")}</p> : null}
      <ul className="flex flex-col gap-s2">
        {rows.map((one) => (
          <ServiceRow key={one.name} service={one} now={now} />
        ))}
      </ul>
      {declaring ? <StartDeclared projectId={box.id} phase={phase} /> : null}
    </section>
  );
}

function ServiceRow({ service, now }: { readonly service: PreviewView; readonly now: number }) {
  const t = useT();
  const stop = usePendingAction();
  const restart = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const { box, name } = service;
  const act = (method: "previews.stop" | "previews.restart", pending: typeof stop) =>
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        await rpc.call(method, { box, name }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  const running = service.state === "running";
  return (
    <li className="flex flex-col gap-s1">
      <div className="flex flex-wrap items-center gap-s2">
        <span className="min-w-0 break-words text-ui text-fg">
          {t("previews.strip", { name, port: service.port })}
        </span>
        <Chip tone={TONE[service.state]} dot label={t(`previews.state.${service.state}`)} />
        {running ? (
          <span className="text-label text-muted">
            {t("previews.uptime", { duration: formatAge(now, service.startedAt, t) })}
          </span>
        ) : null}
      </div>
      {service.state === "failed" && service.reason !== null ? (
        <InlineError announce="background">
          {t(`previews.reason.${service.reason}`, { port: service.port })}
        </InlineError>
      ) : null}
      <div className="flex flex-wrap items-center gap-s2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!running}
          onClick={() => usePreviewsStore.getState().request({ box: boxKey(box), name })}
        >
          {t("previews.open")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!running}
          pendingSince={stop.since}
          onClick={() => act("previews.stop", stop)}
        >
          {t("previews.stop")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          pendingSince={restart.since}
          onClick={() => act("previews.restart", restart)}
        >
          {t("previews.restart")}
        </Button>
        <LogsButton box={box} name={name} />
      </div>
      {problem === null ? null : <InlineError announce="action">{problem}</InlineError>}
    </li>
  );
}
