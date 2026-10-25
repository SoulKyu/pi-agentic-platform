import { Button, EmptyState } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useT } from "../../i18n/index.ts";
import { runCommand } from "../../lib/command-registry.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { useEffectiveProject } from "../../stores/current-project.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";

/** A session this pap does not hold (deleted, or a link from another pap): what happened, and where to go next. */
export function SessionMissing() {
  const t = useT();
  const navigate = useNavigate();
  const projectId = useEffectiveProject()?.id ?? null;
  const search = () => {
    usePaletteRequest.getState().askSearch(projectId);
    if (!runCommand("palette.toggle")) usePaletteRequest.getState().take();
  };
  return (
    <section data-session-missing className="mx-auto flex w-full max-w-chat flex-col p-s4">
      <EmptyState
        title={t("sessions.missing.title")}
        purpose={t("sessions.missing.purpose")}
        action={
          <div className="flex flex-wrap gap-s2">
            <Button
              variant="primary"
              onClick={() => void navigate({ to: "/" }).catch(() => reportClientIssue("command_failed"))}
            >
              {t("sessions.missing.back")}
            </Button>
            <Button variant="secondary" onClick={search}>
              {t("sessions.missing.search")}
            </Button>
          </div>
        }
      />
    </section>
  );
}
