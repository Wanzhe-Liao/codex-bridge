import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.js";
import { StateStore } from "../src/store.js";
import { TaskManager } from "../src/task-manager.js";
import { MockAppServerProcess, makeConfig } from "./helpers.js";

async function setupApproval(kind: "command" | "file" | "input" | "permission" | "elicitation") {
  const process = new MockAppServerProcess({ approval: kind });
  const client = new AppServerClient({ processFactory: () => process, requestTimeoutMs: 2_000 });
  const store = new StateStore(":memory:");
  const manager = new TaskManager(client, store, makeConfig());
  const started = await manager.startTask("default", "Perform the approved mock operation.");
  const pending = await manager.wait(started.task_id, undefined, 1);
  return { process, client, store, manager, started, pending };
}

describe("request approvals and user input", () => {
  it("exposes command approval context and sends the original JSON-RPC id", async () => {
    const { process, client, store, manager, started, pending } = await setupApproval("command");
    expect(pending.state).toBe("waiting_for_approval");
    expect(pending.pending_request).toMatchObject({ request_id: "server-1", kind: "command_approval" });
    await manager.respond(started.task_id, "server-1", "accept");
    const response = process.outbound.find((message) => message.id === "server-1");
    expect(response).toMatchObject({ id: "server-1", result: { decision: "accept" } });
    await client.stop();
    store.close();
  });

  it("validates file, permission, requestUserInput and MCP elicitation responses", async () => {
    for (const kind of ["file", "permission", "input", "elicitation"] as const) {
      const { client, store, manager, started, pending } = await setupApproval(kind);
      expect(pending.pending_request).toBeTruthy();
      if (kind === "input") await manager.respond(started.task_id, "server-1", "answer", { answers: { q1: { answers: ["yes"] } } });
      else if (kind === "permission") await manager.respond(started.task_id, "server-1", "decline");
      else if (kind === "elicitation") await manager.respond(started.task_id, "server-1", "decline");
      else await manager.respond(started.task_id, "server-1", "decline");
      await client.stop();
      store.close();
    }
  });

  it("rejects high-risk command acceptance", async () => {
    const mockProcess = new MockAppServerProcess({ approval: "command" });
    const client = new AppServerClient({ processFactory: () => mockProcess, requestTimeoutMs: 2_000 });
    const store = new StateStore(":memory:");
    const manager = new TaskManager(client, store, makeConfig());
    const started = await manager.startTask("default", "Approve if safe.");
    // Replace the request with a high-risk one on the same mapped task.
    mockProcess.emitServerRequest("high-risk", "item/commandExecution/requestApproval", { threadId: "thread-mock-1", turnId: started.turn_id, itemId: "risk", kind: "command", command: "git reset --hard HEAD", cwd: process.cwd(), startedAtMs: Date.now() });
    await expect(manager.respond(started.task_id, "high-risk", "accept")).rejects.toThrow(/not allowed|destructive/);
    await client.stop();
    store.close();
  });
});
