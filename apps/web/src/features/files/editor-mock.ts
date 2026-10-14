import { createElement } from "react";

interface MockProps {
  readonly value: string;
  readonly readOnly?: boolean;
  readonly onChange?: (text: string) => void;
  readonly onSave?: (text: string) => void;
}

/** The props of the last render, for a test that must call `onChange` and `onSave` in one tick as CodeMirror does. */
export const mockEditor: { latest: MockProps | undefined } = { latest: undefined };

/** A stand-in for `@pap/ui/code` in tests: a textarea that hands the pane what the real editor would (CodeMirror has its own tests). */
export function mockCodeModule() {
  return {
    CodeEditor: (props: MockProps) => {
      mockEditor.latest = props;
      return createElement("textarea", {
        "data-slot": "code-editor",
        "data-readonly": String(props.readOnly ?? false),
        readOnly: props.readOnly ?? false,
        value: props.value,
        onChange: (event: { target: { value: string } }) => props.onChange?.(event.target.value),
        onKeyDown: (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "s") {
            event.preventDefault();
            props.onSave?.(event.currentTarget.value);
          }
        },
      });
    },
    languageFor: () => null,
  };
}
