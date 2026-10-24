import { describe, expect, it } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { addProjectFailure, projectNameOf } from "./add-project.vm.ts";

describe("new project, before and after the call", () => {
  it("trims the name and refuses an empty one before any call", () => {
    expect(projectNameOf("  api  ")).toBe("api");
    for (const text of ["", "   "]) expect(projectNameOf(text), text).toBeNull();
  });

  it("maps each daemon code to its own words, anything else to the shared error words", () => {
    expect(addProjectFailure(new RpcError("bad_request"))).toBe("addProject.error.bad_request");
    expect(addProjectFailure(new RpcError("capacity"))).toBe("addProject.error.capacity");
    expect(addProjectFailure(new RpcError("read_only"))).toBe("addProject.error.read_only");
    expect(addProjectFailure(new RpcError("timeout"))).toBe("error.timeout");
    expect(addProjectFailure(new Error("boom"))).toBe("error.internal");
  });
});
