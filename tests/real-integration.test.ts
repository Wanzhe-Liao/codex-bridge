import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AppServerClient } from "../src/app-server-client.js";
import { StateStore } from "../src/store.js";
import { TaskManager } from "../src/task-manager.js";
import { makeConfig } from "./helpers.js";

test("optional real codex app-server initialize/model/turn smoke", { skip: process.env.CODEX_SUPERVISOR_REAL_INTEGRATION !== "1", timeout: 180_000 }, async () => {
  const client = new AppServerClient({ requestTimeoutMs: 120_000 });
  const store = new StateStore(":memory:");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-supervisor-real-"));
  try {
    const git = spawnSync("git", ["init"], { cwd, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    await client.start();
    assert.equal(client.isInitialized, true);
    const models = await client.request("model/list", { includeHidden: false, limit: 20 });
    assert.ok(Array.isArray(models.data));
    const config = makeConfig(cwd);
    config.profiles.default.approvalPolicy = "never";
    const manager = new TaskManager(client, store, config);
    const started = await manager.startTask("default", "Reply briefly that the supervisor integration transport works. Do not modify files.");
    assert.ok(started.thread_id);
    assert.ok(started.turn_id);
    let snapshot = await manager.wait(started.task_id, undefined, 30);
    const deadline = Date.now() + 150_000;
    while (!snapshot.terminal && Date.now() < deadline) snapshot = await manager.wait(started.task_id, snapshot.next_cursor, 30);
    assert.equal(snapshot.terminal, true);
    assert.equal(snapshot.state, "completed");
    assert.ok(snapshot.codex_messages.length > 0);
    const result = await manager.result(started.task_id);
    assert.equal(result.turn_status, "completed");
    assert.ok(typeof result.final_text === "string" && result.final_text.length > 0);
    assert.equal((result.objective_evidence as any).authoritative_turn_completed, true);
  } finally {
    await client.stop().catch(() => undefined);
    store.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
