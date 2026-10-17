import { t } from "../../i18n/index.ts";
import { failureCode, failureText } from "./failure.ts";

/** What a failed default (model or level) says: the project's own file decides it, or the code's fixed text. */
export const defaultFailureText = (failure: unknown): string =>
  failureCode(failure) === "project_scope" ? t("sessionModels.menu.projectScope") : failureText(failure);
