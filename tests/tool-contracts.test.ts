import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.js";
import { StateStore } from "../src/store.js";
import { TaskManager } from "../src/task-manager.js";
import { SUPERVISOR_INSTRUCTIONS, createMcpServer } from "../src/tools.js";
import { makeConfig } from "./helpers.js";

describe("MCP contracts", () => {
  it("publishes the wait rule in instructions and all critical tools", () => {
    const manager = new TaskManager(new AppServerClient({ processFactory: () => new (class { } as any)() }), new StateStore(":memory:"), makeConfig());
    const server: any = createMcpServer(manager);
    const registered = server._registeredTools ?? {};
    for (const name of ["codex_start", "codex_send", "codex_wait", "codex_result"]) {
      expect(registered[name]?.description).toContain("terminal: false");
      expect(registered[name]?.description).not.toContain("outputSchema");
    }
    expect(SUPERVISOR_INSTRUCTIONS).toContain("Only an authoritative app-server turn/completed event");
    expect(JSON.stringify(registered)).not.toContain("recommended_next_action");
  });

  it("marks mutating tools non-read-only and health/status read-only", () => {
    const manager = new TaskManager(new AppServerClient({ processFactory: () => new (class { } as any)() }), new StateStore(":memory:"), makeConfig());
    const registered: any = (createMcpServer(manager) as any)._registeredTools;
    expect(registered.codex_health.annotations.readOnlyHint).toBe(true);
    expect(registered.codex_start.annotations.readOnlyHint).toBe(false);
    expect(registered.codex_send.annotations.destructiveHint).toBe(true);
    expect(registered.codex_result.annotations.readOnlyHint).toBe(true);
  });
});
