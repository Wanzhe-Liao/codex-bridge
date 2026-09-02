import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.js";
import { StateStore } from "../src/store.js";
import { TaskManager } from "../src/task-manager.js";
import { MockAppServerProcess, makeConfig } from "./helpers.js";

describe("SQLite persistence and recovery", () => {
  it("reopens tasks and keeps completed result data", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-supervisor-test-"));
    const dbPath = path.join(dir, "state.sqlite3");
    const process = new MockAppServerProcess({ autoComplete: true });
    const client = new AppServerClient({ processFactory: () => process, requestTimeoutMs: 2_000 });
    const store = new StateStore(dbPath);
    const manager = new TaskManager(client, store, makeConfig());
    const started = await manager.startTask("default", "Persist this task.");
    let snapshot = await manager.wait(started.task_id, undefined, 1);
    while (!snapshot.terminal) snapshot = await manager.wait(started.task_id, snapshot.next_cursor, 1);
    await client.stop();
    store.close();
    const reopened = new StateStore(dbPath);
    const resumedClient = new AppServerClient({ processFactory: () => new MockAppServerProcess(), requestTimeoutMs: 2_000 });
    const resumed = new TaskManager(resumedClient, reopened, makeConfig());
    expect((resumed.status(started.task_id) as any).terminal).toBe(true);
    expect((await resumed.result(started.task_id)).final_text).toContain("All checks passed");
    await resumedClient.stop();
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
