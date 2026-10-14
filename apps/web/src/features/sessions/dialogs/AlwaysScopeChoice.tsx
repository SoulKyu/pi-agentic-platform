import type { AlwaysScope, Dialog } from "@pap/contracts";
import { FOCUS_RING } from "@pap/ui";
import { useId } from "react";
import { useT } from "../../../i18n/index.ts";
import "../register-policy-catalog.ts";
import { plain } from "./untrusted.ts";

/** The scopes the card offers for "always", the exact call first (M7R26). Empty when the card offers only that. */
export function scopesOffered(dialog: Dialog): readonly AlwaysScope[] {
  if (!dialog.answers?.includes("always")) return [];
  const { prefix, tool, toolSource } = dialog.alwaysScopes ?? {};
  const offered: AlwaysScope[] = ["exact"];
  if (prefix) offered.push("prefix");
  if (tool && toolSource && dialog.tool) offered.push("tool");
  return offered.length > 1 ? offered : [];
}

/** What "Always" would cover, as a choice: it is sent with the answer only when it is not the exact call. */
export function AlwaysScopeChoice(props: {
  readonly dialog: Dialog;
  readonly scopes: readonly AlwaysScope[];
  readonly value: AlwaysScope;
  onChange(scope: AlwaysScope): void;
}) {
  const t = useT();
  const name = useId();
  const { dialog } = props;
  const label = (scope: AlwaysScope): string =>
    scope === "prefix"
      ? t("sessionPolicy.always.prefix", { prefix: (dialog.alwaysScopes?.prefix ?? []).map(plain).join(" ") })
      : scope === "tool"
        ? t("sessionPolicy.always.tool", { tool: plain(dialog.tool ?? "") })
        : t(
            dialog.category === "exec"
              ? "sessionPolicy.always.exactCommand"
              : "sessionPolicy.always.exactCall",
          );
  return (
    <div
      role="radiogroup"
      aria-label={t("sessionPolicy.always.legend")}
      data-always-scope
      className="flex w-full flex-col gap-s1"
    >
      {props.scopes.map((scope) => (
        <label key={scope} className="flex items-center gap-s2 text-ui text-fg pointer-coarse:min-h-11">
          <input
            type="radio"
            name={name}
            checked={props.value === scope}
            onChange={() => props.onChange(scope)}
            className={`accent-agent ${FOCUS_RING}`}
          />
          <span className="min-w-0 break-words">{label(scope)}</span>
        </label>
      ))}
    </div>
  );
}
