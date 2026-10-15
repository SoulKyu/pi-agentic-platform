import { describe, expect, it } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { addProjectFailure, isAbsolutePath } from "./add-project.vm.ts";

describe("add project, before and after the call", () => {
  it("knows an absolute path before any call", () => {
    expect(isAbsolutePath(" /w/api ")).toBe(true);
    for (const text of ["", "   ", "w/api", "~/api", "/a\u0000b"])
      expect(isAbsolutePath(text), text).toBe(false);
  });

  it("maps each daemon code to its own words, anything else to the shared error words", () => {
    expect(addProjectFailure(new RpcError("invalid_cwd"))).toBe("addProject.error.invalid_cwd");
    expect(addProjectFailure(new RpcError("bad_request"))).toBe("addProject.error.bad_request");
    expect(addProjectFailure(new RpcError("capacity"))).toBe("addProject.error.capacity");
    expect(addProjectFailure(new RpcError("read_only"))).toBe("addProject.error.read_only");
    expect(addProjectFailure(new RpcError("timeout"))).toBe("error.timeout");
    expect(addProjectFailure(new Error("boom"))).toBe("error.internal");
  });
});
