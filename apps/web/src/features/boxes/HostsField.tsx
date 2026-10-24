import "../../i18n/register-boxes.ts";
import { TextField } from "@pap/ui";
import { useT } from "../../i18n/index.ts";

interface Props {
  /** One host per line. */
  readonly value: string;
  /** What these hosts are for: an agent's list and a project's list differ in what they add to. */
  readonly hint: string;
  readonly error: string | null;
  onChange(value: string): void;
}

/** The host list text field the agent form and the project settings share (entries: `host`, `host:port`, `*.name`, IPs). */
export function HostsField({ value, hint, error, onChange }: Props) {
  const t = useT();
  return (
    <TextField
      label={t("boxes.hosts.field")}
      hint={hint}
      multiline
      mono
      rows={3}
      value={value}
      error={error}
      onChange={onChange}
    />
  );
}
