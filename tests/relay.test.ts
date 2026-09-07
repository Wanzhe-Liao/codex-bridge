import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.js";
import { TaskManager } from "../src/task-manager.js";
import { StateStore } from "../src/store.js";
import { createMcpServer, SUPERVISOR_INSTRUCTIONS } from "../src/tools.js";
import { MockAppServerProcess, makeConfig } from "./helpers.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function setup(scenario: any = { autoComplete: false }, config = makeConfig(), db = ":memory:") {
  const child = new MockAppServerProcess(scenario);
  const client = new AppServerClient({ processFactory: () => child, requestTimeoutMs: 1000, logger: () => {} });
  const store = new StateStore(db);
  const manager = new TaskManager(client, store, config);
  cleanup.push(async () => { await client.stop(); await new Promise((r) => setImmediate(r)); store.close(); });
  return { child, client, store, manager };
}
function request(env: ReturnType<typeof setup>, started: any, rpcId: string | number = 11, args: any = {}, turnId = started.turn_id) {
  env.child.emitServerRequest(rpcId, "item/tool/call", { threadId: started.thread_id, turnId, callId: `call-${typeof rpcId}-${rpcId}`, namespace: null, tool: "bridge_web_tool",
    arguments: { capability: "arbitrary_connector", request: "Read relevant documents", operation: "read", ...args } });
  return (env.manager.status(started.task_id).tool_requests as any[]).at(-1)?.request_id;
}
const success = { status: "success", result: { text: "random-fixture", n: 1 }, sources: [{ doi: "10.1000/fixture", title: "fixture, not research" }], tool_used: "test fixture" };

describe("Web-side tool relay", () => {
  it("runs a native JSONL relay loop in the same turn and preserves natural-language delivery", async () => {
    const e = setup({ relay: true });
    const started = await e.manager.startTask("default", "Use the fixture tool");
    const waiting = await e.manager.wait(started.task_id, undefined, 1);
    expect(waiting).toMatchObject({ terminal: false, state: "waiting_for_tool" });
    const tool = waiting.tool_requests[0];
    const sent = await e.manager.submitToolResult(started.task_id, String(tool.request_id), success);
    let snapshot = await e.manager.wait(started.task_id, waiting.next_cursor, 1);
    while (!snapshot.terminal) snapshot = await e.manager.wait(started.task_id, snapshot.next_cursor, 1);
    expect(snapshot.turn_id).toBe(started.turn_id);
    const result: any = await e.manager.result(started.task_id);
    expect(result.final_text).toContain("random-fixture");
    expect(result.objective_evidence.authoritative_dynamic_tool_events).toHaveLength(1);
    expect(result.objective_evidence.web_tool_results[0].provenance).toContain("not_independently_verified");
    expect(e.child.outbound.filter((m) => m.method === "turn/start")).toHaveLength(1);
    expect(e.child.outbound.some((m) => ["turn/steer", "thread/resume"].includes(String(m.method)))).toBe(false);
    const start: any = e.child.outbound.find((m) => m.method === "thread/start");
    expect(start.params.dynamicTools[0].name).toBe("bridge_web_tool");
    expect(JSON.stringify(e.child.outbound)).not.toContain("outputSchema");
    expect(JSON.stringify(result)).not.toContain("recommended_next_action");
    expect(sent.delivery_state).not.toBe("uncertain");
  });

  it("wakes a long poll and never makes an outstanding relay terminal", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Wait");
    const before: any = e.manager.status(s.task_id);
    const waiting = e.manager.wait(s.task_id, before.next_cursor, 1);
    request(e, s);
    expect(await waiting).toMatchObject({ state: "waiting_for_tool", terminal: false });
    expect(await e.manager.result(s.task_id)).toMatchObject({ terminal: false });
    expect(await e.manager.wait(s.task_id, String(e.store.latestSequence(s.task_id)), 1)).toMatchObject({ state: "waiting_for_tool", terminal: false });
  });

  it("supports concurrent tasks, approval interleaving, out-of-order replies and numeric/string RPC IDs", async () => {
    const e = setup(); const a = await e.manager.startTask("default", "A"); const b = await e.manager.startTask("default", "B");
    const one = request(e, a, 11); const two = request(e, b, "11");
    e.child.emitServerRequest(12, "item/commandExecution/requestApproval", { threadId: a.thread_id, turnId: a.turn_id, command: "git status --short", cwd: process.cwd(), itemId: "cmd" });
    e.child.emitServerRequest("12", "item/tool/requestUserInput", { threadId: a.thread_id, turnId: a.turn_id, questions: [{ id: "q", header: "Q", question: "Go?", isSecret: false, options: [{ label: "yes", description: "go" }] }] });
    expect((e.manager.status(a.task_id).pending_requests as any[])).toHaveLength(2);
    await expect(e.manager.submitToolResult(a.task_id, two, success)).rejects.toThrow("Unknown");
    await e.manager.submitToolResult(b.task_id, two, success);
    await e.manager.respond(a.task_id, 12, "decline");
    expect(e.manager.status(a.task_id).state).toBe("waiting_for_input");
    await e.manager.respond(a.task_id, "12", "answer", { answers: { q: { answers: ["yes"] } } });
    expect(e.manager.status(a.task_id).state).toBe("waiting_for_tool");
    await e.manager.submitToolResult(a.task_id, one, { status: "success", result: "plain text" });
    const replies = e.child.outbound.filter((m) => !m.method && m.result);
    expect(replies.map((m) => m.id)).toEqual(["11", 12, "12", 11]);
    expect(e.manager.status(a.task_id).state).toBe("running");
  });

  it.each(["error", "unavailable", "declined"])("returns truthful %s with success false", async (status) => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup"); const id = request(e, s);
    await e.manager.submitToolResult(s.task_id, id, { status, result: "Host did not execute the operation" });
    expect((e.child.outbound.at(-1) as any).result.success).toBe(false);
    expect(e.manager.status(s.task_id).terminal).toBe(false);
  });

  it("deduplicates identical concurrent submissions and rejects conflicts", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup"); const id = request(e, s);
    await Promise.all([e.manager.submitToolResult(s.task_id, id, success), e.manager.submitToolResult(s.task_id, id, success)]);
    expect(e.child.outbound.filter((m) => m.id === 11 && !m.method)).toHaveLength(1);
    await expect(e.manager.submitToolResult(s.task_id, id, { ...success, result: "different" })).rejects.toThrow("Conflicting");
    expect(await e.manager.submitToolResult(s.task_id, id, success)).toMatchObject({ duplicate: true });
  });

  it("allows a reused RPC ID only for a fresh call after the prior response", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup");
    const old = request(e, s, 11);
    await e.manager.submitToolResult(s.task_id, old, success);
    const fresh = request(e, s, 11);
    expect(fresh).not.toBe(old);
    expect(await e.manager.submitToolResult(s.task_id, old, success)).toMatchObject({ duplicate: true });
    expect((e.manager.status(s.task_id).tool_requests as any[])[0].request_id).toBe(fresh);
    await e.manager.submitToolResult(s.task_id, fresh, { status: "success", result: "fresh data" });
    expect(e.child.outbound.filter((m) => m.id === 11 && !m.method)).toHaveLength(2);
  });

  it("preserves the original write request but grants no implicit authorization", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Only inspect");
    const id = request(e, s, 11, { operation: "write", capability: "send_email", request: "Send a message" });
    expect((e.manager.status(s.task_id).tool_requests as any[])[0].operation).toBe("write");
    expect(e.child.outbound.some((m) => !m.method)).toBe(false);
    await e.manager.submitToolResult(s.task_id, id, { status: "declined", result: "User authorized inspection only" });
    expect((e.child.outbound.at(-1) as any).result.success).toBe(false);
  });

  it("rejects wrong turns and cleared requests without writing to stale IDs", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup");
    expect(request(e, s, 90, {}, "wrong-turn")).toBeUndefined();
    const id = request(e, s);
    e.child.emitNotification("serverRequest/resolved", { threadId: s.thread_id, requestId: 11 });
    await expect(e.manager.submitToolResult(s.task_id, id, success)).rejects.toThrow("Stale");
    expect(e.manager.status(s.task_id).tool_requests).toEqual([]);
  });

  it("invalidates pending requests on cancel and trusts real interrupted status", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup"); const id = request(e, s);
    const cancelled = await e.manager.cancel(s.task_id);
    expect(cancelled).toMatchObject({ terminal: true, state: "interrupted" });
    await expect(e.manager.submitToolResult(s.task_id, id, success)).rejects.toThrow("Stale");
    const continued = await e.manager.send(s.task_id, "Continue safely");
    expect(continued).toMatchObject({ mode: "new_turn", thread_id: s.thread_id });
  });

  it("rejects oversize requests/results explicitly and redacts both persistence and response", async () => {
    const config = makeConfig(); config.relay = { enabled: true, maxResultBytes: 1024 };
    const e = setup(undefined, config); const s = await e.manager.startTask("default", "Lookup");
    expect(request(e, s, 90, { request: "x".repeat(16001) })).toBeUndefined();
    expect((e.child.outbound.at(-1) as any).result.success).toBe(false);
    const id = request(e, s, 11, { context: { password: "private-value" } });
    expect(JSON.stringify(e.manager.status(s.task_id))).not.toContain("private-value");
    await expect(e.manager.submitToolResult(s.task_id, id, { status: "success", result: "汉".repeat(600) })).rejects.toThrow("exceeds");
    await e.manager.submitToolResult(s.task_id, id, { status: "success", result: { password: "private-value", text: "sk-abcdefghijklmnopqrstuvwx" } });
    expect(JSON.stringify(e.store.interactions(s.task_id))).not.toContain("private-value");
    expect(JSON.stringify(e.child.outbound.at(-1))).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("pages complete stored results without silently truncating their content", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup"); const id = request(e, s);
    const value = "文".repeat(20000) + "END";
    await e.manager.submitToolResult(s.task_id, id, { status: "success", result: value });
    let offset = 0; let text = "";
    do {
      const page: any = e.manager.inspect(s.task_id, "tool_requests", id, offset, 2);
      text += page.data.map((r: any) => r.text).join(""); offset = page.next_offset;
    } while (offset !== null);
    expect(JSON.parse(text).submission.result).toBe(value);
  });

  it("keeps uncertain pipe delivery and never resends a duplicate", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup"); const id = request(e, s);
    e.child.stdin.destroy(new Error("fixture broken pipe"));
    const result = await e.manager.submitToolResult(s.task_id, id, success);
    expect(result.delivery_state).toBe("uncertain");
    expect(await e.manager.submitToolResult(s.task_id, id, success)).toMatchObject({ duplicate: true, delivery_state: "uncertain" });
    expect(e.manager.status(s.task_id).terminal).toBe(false);
  });

  it("invalidates requests on app-server crash even if RPC IDs are reused", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup"); const id = request(e, s);
    const epoch = e.client.connectionId;
    e.child.emit("exit", 1, null);
    await new Promise((r) => setImmediate(r));
    expect(e.client.connectionId).not.toBe(epoch);
    await expect(e.manager.submitToolResult(s.task_id, id, success)).rejects.toThrow("Stale");
    expect(e.manager.status(s.task_id).terminal).toBe(false);
  });

  it("recovers SQLite history, submitted dedupe and legacy threads without silently registering tools", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-relay-test-"));
    const db = path.join(dir, "state.sqlite3");
    const first = setup(undefined, makeConfig(), db); const s = await first.manager.startTask("default", "Lookup");
    const sent = request(first, s, 11); await first.manager.submitToolResult(s.task_id, sent, success);
    const pending = request(first, s, 22);
    // A second connection represents an MCP restart: prior pending RPC IDs cannot survive it.
    const second = setup(undefined, makeConfig(), db);
    await expect(second.manager.submitToolResult(s.task_id, pending, success)).rejects.toThrow("Stale");
    expect(await second.manager.submitToolResult(s.task_id, sent, success)).toMatchObject({ duplicate: true });
    expect(second.manager.status(s.task_id)).toMatchObject({ terminal: false, state: "connection_lost", relay_enabled: true });
    await second.manager.send(s.task_id, "Resume");
    expect(second.child.outbound.some((m) => m.method === "thread/resume")).toBe(true);
    expect(second.child.outbound.some((m) => m.method === "thread/start")).toBe(false);
    const disabled = makeConfig(); disabled.relay = { enabled: false, maxResultBytes: 262144 };
    const legacy = setup(undefined, disabled); const old = await legacy.manager.startTask("default", "Old task");
    expect((legacy.child.outbound.find((m) => m.method === "thread/start")?.params as any).dynamicTools).toBeUndefined();
    expect(request(legacy, old)).toBeUndefined();
    cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it("migrates a 0.2 tasks table without losing its natural-language result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migration-test-"));
    const dbPath = path.join(dir, "state.sqlite3");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, profile TEXT NOT NULL, thread_id TEXT,
      session_id TEXT, current_turn_id TEXT, state TEXT NOT NULL, terminal INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, last_activity_at TEXT,
      final_text TEXT, error TEXT
    ); INSERT INTO tasks VALUES ('legacy', 'default', 'default', 'thread-old', null, 'turn-old',
      'completed', 1, '2026-09-01', '2026-09-01', null, null, 'Original scientific limitations remain unchanged.', null);`);
    db.close();
    const e = setup(undefined, makeConfig(), dbPath);
    const result: any = await e.manager.result("legacy");
    expect(result.final_text).toBe("Original scientific limitations remain unchanged.");
    expect(e.manager.status("legacy")).toMatchObject({ terminal: true, relay_enabled: false });
    expect((e.manager.status("legacy").warnings as string[]).join(" ")).toContain("Start a new task");
    await e.manager.send("legacy", "Continue this saved thread");
    expect(e.child.outbound.find((m) => m.method === "thread/resume")?.params).toMatchObject({ threadId: "thread-old" });
    expect(e.child.outbound.some((m) => m.method === "thread/start")).toBe(false);
    cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it("bounds raw dynamic-tool events and never surfaces hidden reasoning", async () => {
    const e = setup(); const s = await e.manager.startTask("default", "Lookup");
    e.child.emitNotification("item/reasoning/textDelta", { threadId: s.thread_id, turnId: s.turn_id, itemId: "thought", delta: "hidden-chain-fixture" });
    e.child.emitNotification("item/completed", { threadId: s.thread_id, turnId: s.turn_id, item: { type: "dynamicToolCall", id: "fixture", tool: "bridge_web_tool", arguments: {}, contentItems: [{ type: "inputText", text: "x".repeat(100000) }], success: true, status: "completed" } });
    const raw = JSON.stringify(e.manager.inspect(s.task_id, "raw_event"));
    expect(raw).not.toContain("hidden-chain-fixture");
    expect(raw).toContain("content_excerpt");
    expect(raw.length).toBeLessThan(15000);
  });

  it("discovers and calls the new tool over official MCP transport with truthful annotations", async () => {
    const e = setup({ relay: true }); const server = createMcpServer(e.manager);
    const client = new Client({ name: "relay-inspection-fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    cleanup.unshift(async () => { await client.close(); await server.close(); });
    const listed = await client.listTools();
    const relay = listed.tools.find((t) => t.name === "codex_submit_tool_result")!;
    expect(relay.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    for (const name of ["codex_start", "codex_send", "codex_wait", "codex_result"]) expect(listed.tools.find((t) => t.name === name)?.description).toContain("codex_submit_tool_result");
    expect(SUPERVISOR_INSTRUCTIONS).toContain("WEB-SIDE TOOL RELAY");
    const started: any = await client.callTool({ name: "codex_start", arguments: { project_id: "default", prompt: "Fixture lookup" } });
    const task = JSON.parse(started.content[0].text);
    const waiting: any = await client.callTool({ name: "codex_wait", arguments: { task_id: task.task_id, timeout_seconds: 1 } });
    const id = JSON.parse(waiting.content[0].text).tool_requests[0].request_id;
    const reply: any = await client.callTool({ name: "codex_submit_tool_result", arguments: { task_id: task.task_id, request_id: id, ...success } });
    expect(reply.isError).not.toBe(true);
  });
});
