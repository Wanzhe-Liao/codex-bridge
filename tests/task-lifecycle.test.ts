import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.js";
import { StateStore } from "../src/store.js";
import { TaskManager } from "../src/task-manager.js";
import { MockAppServerProcess, makeConfig } from "./helpers.js";

function setup(scenario: ConstructorParameters<typeof MockAppServerProcess>[0] = {}) {
  const process = new MockAppServerProcess(scenario);
  const client = new AppServerClient({ processFactory: () => process, requestTimeoutMs: 2_000 });
  const store = new StateStore(":memory:");
  const manager = new TaskManager(client, store, makeConfig());
  return { process, client, store, manager };
}

async function drain(manager: TaskManager, taskId: string, first?: any): Promise<any> {
  let snapshot = first ?? await manager.wait(taskId, undefined, 1);
  while (!snapshot.terminal) snapshot = await manager.wait(taskId, snapshot.next_cursor, 1);
  return snapshot;
}

describe("task lifecycle and wait semantics", () => {
  it("creates thread + turn, structures plan/command events, and only turns terminal on turn/completed", async () => {
    const { manager, client, store } = setup({ autoComplete: true });
    const started = await manager.startTask("default", "Inspect this project and report findings.");
    expect(started.terminal).toBe(false);
    const snapshot = await drain(manager, started.task_id);
    expect(snapshot.terminal).toBe(true);
    expect(snapshot.state).toBe("completed");
    expect(snapshot.current_plan[0]).toMatchObject({ step: "Inspect project" });
    expect(snapshot.events.some((event: any) => event.event_type === "command_completed")).toBe(true);
    expect(snapshot.final_text).toBe("I inspected the project.\nAll checks passed in the mock.");
    expect((manager.inspect(started.task_id, "diff") as any).data[0]).toBeTruthy();
    expect((manager.inspect(started.task_id, "file_changes") as any).data.length).toBeGreaterThan(0);
    expect((manager.inspect(started.task_id, "mcp_calls") as any).data.length).toBeGreaterThan(0);
    const result = await manager.result(started.task_id);
    expect(result.final_text).toBe("I inspected the project.\nAll checks passed in the mock.");
    expect(result.objective_evidence).toHaveProperty("authoritative_turn_completed", true);
    expect(JSON.stringify(result)).not.toContain("recommended_next_action");
    await client.stop();
    store.close();
  });

  it("does not infer completion from timeout, empty progress, or agent commentary", async () => {
    const { manager, client, store } = setup({ autoComplete: false });
    const started = await manager.startTask("default", "Keep working until explicitly completed.");
    const first = await manager.wait(started.task_id, undefined, 1);
    expect(first.terminal).toBe(false);
    expect(first.state).toBe("running");
    const timeout = await manager.wait(started.task_id, first.next_cursor, 1);
    expect(timeout.terminal).toBe(false);
    expect(timeout.state).toBe("running");
    const result = await manager.result(started.task_id);
    expect(result.terminal).toBe(false);
    expect(result).not.toHaveProperty("final_text");
    await client.stop();
    store.close();
  });

  it("steers an active turn and starts a new turn after terminal", async () => {
    const { manager, process, client, store } = setup({ autoComplete: true });
    const started = await manager.startTask("default", "Do the first pass.");
    await drain(manager, started.task_id);
    await manager.send(started.task_id, "Continue in the same thread with a second pass.");
    expect(process.outbound.some((message) => message.method === "turn/start" && (message.params as any).input?.[0]?.text.includes("second pass"))).toBe(true);
    let second = await manager.wait(started.task_id, undefined, 1);
    while (!second.terminal) second = await manager.wait(started.task_id, second.next_cursor, 1);
    process.emitNotification("turn/completed", { threadId: started.thread_id, turn: { id: started.turn_id, status: "failed", error: { message: "late old turn" } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.status(started.task_id)).toMatchObject({ state: "completed", terminal: true, turn_id: "turn-mock-2" });
    const active = setup({ autoComplete: false });
    const activeStarted = await active.manager.startTask("default", "Do not complete yet.");
    await active.manager.send(activeStarted.task_id, "Please correct the approach.");
    expect(active.process.outbound.some((message) => message.method === "turn/steer")).toBe(true);
    await client.stop();
    store.close();
    await active.client.stop();
    active.store.close();
  });

  it("sends the original natural-language prompt and never sends outputSchema", async () => {
    const { manager, process, client, store } = setup({ autoComplete: false });
    const prompt = "Use academic language; do not convert this request to JSON.";
    await manager.startTask("default", prompt);
    const request: any = process.outbound.find((message) => message.method === "turn/start");
    const threadRequest: any = process.outbound.find((message) => message.method === "thread/start");
    expect(threadRequest.params.sandbox).toBe("workspace-write");
    expect(request.params.input).toEqual([{ type: "text", text: prompt, text_elements: [] }]);
    expect(request.params.sandboxPolicy).toMatchObject({ type: "workspaceWrite", writableRoots: [threadRequest.params.cwd], networkAccess: false });
    expect(request.params).not.toHaveProperty("outputSchema");
    await client.stop();
    store.close();
  });

  it("maps failed and interrupted turn/completed statuses authoritatively", async () => {
    const failed = setup({ autoComplete: true, failed: true });
    const failedStart = await failed.manager.startTask("default", "Fail in the mock.");
    const failedSnapshot = await drain(failed.manager, failedStart.task_id);
    expect(failedSnapshot).toMatchObject({ terminal: true, state: "failed" });
    await failed.client.stop();
    failed.store.close();

    const interrupted = setup({ autoComplete: false });
    const interruptedStart = await interrupted.manager.startTask("default", "Wait for interrupt.");
    const interruptedSnapshot = await interrupted.manager.cancel(interruptedStart.task_id, "test");
    expect(interruptedSnapshot).toMatchObject({ terminal: true, state: "interrupted" });
    await interrupted.client.stop();
    interrupted.store.close();
  });

  it("marks a crashed active turn connection_lost and preserves its thread", async () => {
    const first = new MockAppServerProcess({ autoComplete: false });
    const second = new MockAppServerProcess({ autoComplete: false });
    const processes = [first, second];
    const client = new AppServerClient({ processFactory: () => processes.shift()!, requestTimeoutMs: 2_000 });
    const store = new StateStore(":memory:");
    const manager = new TaskManager(client, store, makeConfig());
    const started = await manager.startTask("default", "Keep running during the crash.");
    first.emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.status(started.task_id)).toMatchObject({ terminal: false, state: "connection_lost", thread_id: started.thread_id });
    await client.stop();
    store.close();
  });
});
