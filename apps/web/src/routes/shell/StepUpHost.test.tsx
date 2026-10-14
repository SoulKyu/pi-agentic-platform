// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { settingsAccessEn, settingsAccessFr } from "../../i18n/catalog/settings-access.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { TrustDialog } from "../../features/trust/TrustDialog.tsx";
import { current, CWD, newBed } from "../../features/trust/trust-bed.tsx";
import { RpcError } from "../../runtime/rpc.ts";
import { button, click, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { StepUpHost } from "./StepUpHost.tsx";
import { ShellContext } from "./shell-context.ts";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
const auth = vi.hoisted(() => ({ confirmPassword: vi.fn() }));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  confirmPassword: auth.confirmPassword,
}));

registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });

const shell = { username: "me", passkeysAvailable: true, onSignedOut: vi.fn() };

describe("the shell's password prompt over the trust dialog (MC49)", () => {
  it("stacks the real prompt on the open dialog, and Trust goes through once the password is confirmed", async () => {
    auth.confirmPassword.mockResolvedValue({ ok: true });
    const bed = newBed();
    let first = true;
    bed.handlers["trust.set"] = () => {
      if (first) {
        first = false;
        return Promise.reject(new RpcError("step_up_required"));
      }
      return { ok: true };
    };
    const decided = vi.fn();
    await mount(
      <ShellContext.Provider value={shell}>
        <StepUpHost>
          <TrustDialog cwd={CWD} onDecided={decided} onClose={() => {}} />
        </StepUpHost>
      </ShellContext.Provider>,
    );
    await settle();
    await click(button(document.body, "Trust"));
    await settle();
    // Both dialogs are open: the dialog is still there under the prompt.
    expect(text(document.body)).toContain("Trust this project?");
    await vi.waitFor(() => expect(document.querySelector('input[type="password"]')).not.toBeNull(), {
      timeout: 4000,
    });
    await settle();
    const password = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(decided).not.toHaveBeenCalled();
    await typeInto(password, "hunter2");
    await click(button(document.body, "Confirm"));
    await settle();
    expect(auth.confirmPassword).toHaveBeenCalledWith("hunter2");
    expect(bed.called("trust.set")).toHaveLength(2);
    expect(decided).toHaveBeenCalledWith(true);
  });
});
