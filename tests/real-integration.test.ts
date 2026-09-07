import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("optional real relay fixture: random marker returns to the original turn", { skip: process.env.CODEX_SUPERVISOR_RELAY_INTEGRATION !== "1", timeout: 240_000 }, async () => {
  const client = new AppServerClient({ requestTimeoutMs: 120_000 });
  const store = new StateStore(":memory:");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-relay-real-"));
  let manager: TaskManager | undefined;
  let taskId: string | undefined;
  try {
    assert.equal(spawnSync("git", ["init"], { cwd, encoding: "utf8", windowsHide: true }).status, 0);
    await client.start();
    const models = await client.request("model/list", { includeHidden: false, limit: 20 });
    assert.ok(models.data.length > 0);
    const config = makeConfig(cwd);
    config.profiles.default.approvalPolicy = "never";
    manager = new TaskManager(client, store, config);
    const started = await manager.startTask("default", "This is a transport integration FIXTURE, not research. Call the provided bridge_web_tool exactly once with capability fixture_random_marker, operation read, request 'Return the fixture marker'. You cannot know the marker before the tool returns. Do not use shell, network, files or any other tools. Once the tool returns, include the exact marker in a brief natural-language final answer, explicitly labeling it a test fixture.");
    taskId = started.task_id;
    const deadline = Date.now() + 210_000;
    let cursor: string | undefined;
    let marker = "";
    let completed = false;
    let sent = 0;
    while (Date.now() < deadline) {
      const snapshot = await manager.wait(taskId, cursor, 20);
      cursor = snapshot.next_cursor;
      assert.equal(snapshot.turn_id, started.turn_id);
      for (const r of snapshot.tool_requests) {
        assert.equal(sent, 0, "Fixture expects one request");
        marker = `fixture-${randomUUID()}`;
        const submitted = await manager.submitToolResult(taskId, String(r.request_id), { status: "success", result: { marker, fixture: true }, tool_used: "local test fixture (not Web search)" });
        assert.notEqual(submitted.delivery_state, "uncertain");
        sent++;
      }
      if (snapshot.terminal) { completed = true; break; }
    }
    assert.ok(completed, "No authoritative turn/completed received before fixture deadline");
    assert.equal(sent, 1);
    const result: any = await manager.result(taskId);
    assert.equal(result.turn_status, "completed");
    assert.ok(result.final_text.includes(marker), "Codex must use the marker returned through the original native tool call");
    assert.ok(result.objective_evidence.authoritative_dynamic_tool_events.length > 0);
    process.stdout.write("Real app-server relay FIXTURE passed: initialize, model/list, dynamic tool, same-turn marker, agentMessage, turn/completed. Not a ChatGPT Web search test.\n");
  } finally {
    if (manager && taskId && !manager.status(taskId).terminal) await manager.cancel(taskId, "Integration fixture cleanup").catch(() => undefined);
    await client.stop().catch(() => undefined);
    store.close();
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
