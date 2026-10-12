// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "../register-session-catalog.ts";
import type { Dialog } from "@pap/contracts";
import type { InputRequestCardProps } from "@pap/ui/extensions";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../../../testing/dom.ts";
import { SelectDialog } from "./SelectDialog.tsx";

const seen = vi.hoisted(() => ({ props: undefined as InputRequestCardProps | undefined }));
vi.mock("@pap/ui/extensions", () => ({
  InputRequestCard: (props: InputRequestCardProps) => {
    seen.props = props;
    return null;
  },
}));

const dialog: Dialog = { id: "s1", method: "select", title: "Pick", options: ["a", "b"] };

describe("SelectDialog", () => {
  it("answers the option at the position, and answers nothing for a position it never offered", async () => {
    const onAnswer = vi.fn();
    await mount(<SelectDialog dialog={dialog} onAnswer={onAnswer} />);
    const props = seen.props;
    if (props?.kind !== "select") throw new Error("not a select card");
    props.onSelect(7);
    props.onSelect(-1);
    expect(onAnswer).not.toHaveBeenCalled();
    props.onSelect(1);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({ value: "b" });
  });
});
