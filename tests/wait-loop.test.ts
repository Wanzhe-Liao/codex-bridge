import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.js";
import { StateStore } from "../src/store.js";
import { TaskManager } from "../src/task-manager.js";
import { MockAppServerProcess, makeConfig } from "./helpers.js";

describe("wait long-poll", () => {
  it("returns a bounded event page and a cursor, then eventually terminal", async () => {
    const process = new MockAppServerProcess({ autoComplete: true });
    const client = new AppServerClient({ processFactory: () => process, requestTimeoutMs: 2_000 });
    const store = new StateStore(":memory:");
    const manager = new TaskManager(client, store, makeConfig());
    const started = await manager.startTask("default", "Run the mock long task.");
    const page = await manager.wait(started.task_id, undefined, 1);
    expect(page.next_cursor).toMatch(/^\d+$/);
    expect(page.events.length).toBeGreaterThan(0);
    let current = page;
    while (!current.terminal) current = await manager.wait(started.task_id, current.next_cursor, 1);
    expect(current.state).toBe("completed");
    await client.stop();
    store.close();
  });

  it("bounds command output and paginates inspection", async () => {
    const process = new MockAppServerProcess({ autoComplete: false });
    const client = new AppServerClient({ processFactory: () => process, requestTimeoutMs: 2_000 });
    const store = new StateStore(":memory:");
    const manager = new TaskManager(client, store, makeConfig());
    const started = await manager.startTask("default", "Emit bounded logs.");
    process.emitNotification("item/commandExecution/outputDelta", { threadId: started.thread_id, turnId: started.turn_id, itemId: "large", delta: "x".repeat(10_000) });
    process.emitNotification("item/commandExecution/outputDelta", { threadId: started.thread_id, turnId: started.turn_id, itemId: "large", delta: "tail" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const page: any = manager.inspect(started.task_id, "command_output", "large", 0, 1);
    expect(page.data).toHaveLength(1);
    expect(page.next_offset).toBe(1);
    expect(JSON.stringify(page.data[0]).length).toBeLessThan(3_000);
    await client.stop();
    store.close();
  });
});
