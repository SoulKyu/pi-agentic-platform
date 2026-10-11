import { Button, EmptyState } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { navigateTo } from "./navigate.ts";

export function NotFound() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <EmptyState
      title={t("shell.notFound.title")}
      purpose={t("shell.notFound.purpose")}
      action={
        <Button
          onClick={() =>
            navigateTo(navigate, { kind: "home" }).catch(() => reportClientIssue("command_failed"))
          }
        >
          {t("shell.notFound.home")}
        </Button>
      }
    />
  );
}
