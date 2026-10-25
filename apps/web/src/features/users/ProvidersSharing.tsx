import type { ProviderSharingView } from "@pap/contracts";
import { InlineError, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useUserAction } from "./use-users.ts";

interface Props {
  readonly providers: readonly ProviderSharingView[];
  onChanged(): void;
}

/** Which providers a member's box may use. A subscription login is never served to boxes: its switch is off and disabled. */
export function ProvidersSharing({ providers, onChanged }: Props) {
  const t = useT();
  const action = useUserAction();
  const share = (provider: string, shared: boolean) =>
    action.run(async () => {
      await getRuntime().rpc.call("users.setProviderShared", { provider, shared });
      onChanged();
    });
  return (
    <section className="flex flex-col gap-s2">
      <h3 className="text-ui font-semibold text-fg">{t("users.providers.title")}</h3>
      {providers.length === 0 ? (
        <p className="text-ui text-muted">{t("users.providers.none")}</p>
      ) : (
        <ul className="flex flex-col">
          {providers.map((one) => (
            <li
              key={one.provider}
              data-provider={one.provider}
              className="flex flex-col gap-s1 border-b border-border py-s2"
            >
              <Switch
                label={t("users.providers.sharedOf", { provider: one.label || one.provider })}
                checked={one.servable && one.shared}
                disabled={!one.servable}
                hint={one.servable ? undefined : t("users.providers.subscription")}
                onChange={(next) => share(one.provider, next)}
              />
            </li>
          ))}
        </ul>
      )}
      {action.problem === null ? null : <InlineError announce="action">{t(action.problem)}</InlineError>}
    </section>
  );
}
