import { Button, EmptyState } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useT } from "../../i18n/index.ts";
import { go } from "./tab-actions.ts";

export function NotFound() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <EmptyState
      title={t("shell.notFound.title")}
      purpose={t("shell.notFound.purpose")}
      action={<Button onClick={() => go(navigate, "/")}>{t("shell.notFound.home")}</Button>}
    />
  );
}
