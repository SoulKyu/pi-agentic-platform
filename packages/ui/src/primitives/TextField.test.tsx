import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextField } from "./TextField.tsx";

const noop = () => {};

describe("TextField", () => {
  it("labels the input and keeps the label an uppercase mono HUD label", () => {
    const html = renderToStaticMarkup(<TextField label="Name" value="Ada" onChange={noop} />);
    const labelFor = /<label for="([^"]+)"/.exec(html)?.[1];
    expect(labelFor).toBeDefined();
    expect(html).toContain(`id="${labelFor}"`);
    expect(html).toContain("tracking-label");
    expect(html).toContain("uppercase");
    expect(html).toContain('value="Ada"');
  });

  it("flags an error as an alert and still describes the field by its hint", () => {
    const html = renderToStaticMarkup(
      <TextField label="Name" value="" onChange={noop} hint="Shown to others" error="Required" />,
    );
    expect(html).toContain('aria-invalid="true"');
    const hintId = /<p id="([^"]+)"[^>]*>Shown to others</.exec(html)?.[1];
    const errorId = /<p id="([^"]+)"[^>]*role="alert"[^>]*>Required</.exec(html)?.[1];
    expect(hintId).toBeDefined();
    expect(errorId).toBeDefined();
    expect(hintId).not.toBe(errorId);
    expect(/<input[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1]).toBe(`${hintId} ${errorId}`);
  });

  it("describes the field by its hint alone, with no alert", () => {
    const html = renderToStaticMarkup(
      <TextField label="Name" value="" onChange={noop} hint="Shown to others" />,
    );
    expect(html).toContain("Shown to others");
    expect(html).not.toContain("role=");
    expect(html).not.toContain("aria-invalid");
    expect(/<input[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1]).toBeDefined();
    expect(renderToStaticMarkup(<TextField label="Name" value="" onChange={noop} />)).not.toContain(
      "aria-describedby",
    );
  });

  it("dims a disabled field and shows it is not editable", () => {
    const html = renderToStaticMarkup(<TextField label="Name" value="" disabled onChange={noop} />);
    expect(html).toContain("disabled:opacity-50");
    expect(html).toContain("disabled:cursor-not-allowed");
    expect(html).toContain('disabled=""');
  });

  it("renders a password input and a multiline textarea", () => {
    expect(
      renderToStaticMarkup(<TextField label="Secret" type="password" value="" onChange={noop} />),
    ).toContain('type="password"');
    expect(renderToStaticMarkup(<TextField label="Notes" multiline value="a" onChange={noop} />)).toContain(
      "<textarea",
    );
  });

  it("shows the focus ring offset 2 px", () => {
    const html = renderToStaticMarkup(<TextField label="Name" value="" onChange={noop} />);
    expect(html).toContain("focus-visible:outline-offset-2");
    expect(html).toContain("focus-visible:outline-human-fill");
  });

  it("passes a placeholder to the input and the textarea, and none when absent", () => {
    const single = renderToStaticMarkup(
      <TextField label="Name" value="" onChange={noop} placeholder="Ada" />,
    );
    expect(/<input[^>]*placeholder="Ada"/.test(single)).toBe(true);
    const multi = renderToStaticMarkup(
      <TextField label="Name" value="" onChange={noop} multiline placeholder="Ada" />,
    );
    expect(/<textarea[^>]*placeholder="Ada"/.test(multi)).toBe(true);
    expect(renderToStaticMarkup(<TextField label="Name" value="" onChange={noop} />)).not.toContain(
      "placeholder",
    );
  });
});
