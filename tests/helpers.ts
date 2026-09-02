import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AppServerProcessLike } from "../src/app-server-process.js";

export interface MockScenario {
  autoComplete?: boolean;
  approval?: "command" | "file" | "input" | "permission" | "elicitation";
  failed?: boolean;
  interrupt?: boolean;
}

function turn(id: string, status: string = "inProgress"): Record<string, unknown> {
  return { id, items: [], itemsView: "all", status, error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null };
}

export class MockAppServerProcess extends EventEmitter implements AppServerProcessLike {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  readonly outbound: Record<string, unknown>[] = [];
  readonly scenario: MockScenario;
  private readonly threadId = "thread-mock-1";
  private readonly sessionId = "session-mock-1";
  private turnNumber = 0;
  private stopped = false;

  constructor(scenario: MockScenario = {}) {
    super();
    this.scenario = scenario;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          const lines = chunk.toString().split("\n").filter(Boolean);
          for (const line of lines) this.receive(JSON.parse(line));
          callback();
        } catch (error) { callback(error as Error); }
      },
    });
  }

  kill(): boolean {
    if (!this.stopped) {
      this.stopped = true;
      queueMicrotask(() => this.emit("exit", 0, null));
    }
    return true;
  }

  emitNotification(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  emitServerRequest(id: string | number, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  private respond(id: string | number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private receive(message: Record<string, unknown>): void {
    this.outbound.push(message);
    const method = message.method;
    const id = message.id as string | number;
    if (method === "initialize") {
      this.respond(id, { userAgent: "mock", codexHome: "/tmp/mock", platformFamily: "unix", platformOs: "linux" });
      return;
    }
    if (method === "model/list") {
      this.respond(id, { data: [{ id: "mock-model", model: "mock-model", displayName: "Mock", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Mock" }] }], nextCursor: null });
      return;
    }
    if (method === "account/read") {
      this.respond(id, { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: false });
      return;
    }
    if (method === "thread/start") {
      this.respond(id, { thread: { id: this.threadId, sessionId: this.sessionId, turns: [], status: { type: "idle" }, cwd: process.cwd() } });
      queueMicrotask(() => this.emitNotification("thread/started", { thread: { id: this.threadId, sessionId: this.sessionId } }));
      return;
    }
    if (method === "thread/resume") {
      this.respond(id, { thread: { id: this.threadId, sessionId: this.sessionId, turns: [], status: { type: "idle" }, cwd: process.cwd() }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      return;
    }
    if (method === "turn/start") {
      this.turnNumber += 1;
      const turnId = `turn-mock-${this.turnNumber}`;
      this.respond(id, { turn: turn(turnId) });
      queueMicrotask(() => this.emitTurn(turnId));
      return;
    }
    if (method === "turn/steer") {
      this.respond(id, {});
      return;
    }
    if (method === "turn/interrupt") {
      this.respond(id, {});
      const params = message.params as Record<string, unknown>;
      const turnId = String(params.turnId);
      queueMicrotask(() => this.emitNotification("turn/completed", { threadId: this.threadId, turn: turn(turnId, "interrupted") }));
      return;
    }
    if (method === "command/exec") {
      this.respond(id, { exitCode: 0, stdout: "", stderr: "" });
      return;
    }
  }

  private emitTurn(turnId: string): void {
    this.emitNotification("turn/started", { threadId: this.threadId, turn: turn(turnId) });
    this.emitNotification("turn/plan/updated", { threadId: this.threadId, turnId, explanation: null, plan: [{ step: "Inspect project", status: "inProgress" }, { step: "Deliver", status: "pending" }] });
    if (this.scenario.approval) {
      const common = { threadId: this.threadId, turnId, itemId: "item-request-1", startedAtMs: Date.now() };
      if (this.scenario.approval === "command") this.emitServerRequest("server-1", "item/commandExecution/requestApproval", { ...common, kind: "command", environmentId: null, command: "git status --short", cwd: process.cwd(), reason: "mock approval" });
      if (this.scenario.approval === "file") this.emitServerRequest("server-1", "item/fileChange/requestApproval", { ...common, reason: "mock file approval", grantRoot: process.cwd() });
      if (this.scenario.approval === "input") this.emitServerRequest("server-1", "item/tool/requestUserInput", { ...common, questions: [{ id: "q1", header: "Choice", question: "Continue?", isOther: false, isSecret: false, options: [{ label: "yes", description: "Yes" }] }], isBlocking: true, autoResolutionMs: null });
      if (this.scenario.approval === "permission") this.emitServerRequest("server-1", "item/permissions/requestApproval", { ...common, environmentId: null, cwd: process.cwd(), reason: "mock permission", permissions: { network: null, fileSystem: null } });
      if (this.scenario.approval === "elicitation") this.emitServerRequest("server-1", "mcpServer/elicitation/request", { threadId: this.threadId, turnId, serverName: "mock", mode: "form", _meta: null, message: "mock", requestedSchema: { type: "object" } });
      return;
    }
    if (this.scenario.autoComplete !== false) {
      this.emitNotification("turn/diff/updated", { threadId: this.threadId, turnId, diff: "diff --git a/mock.txt b/mock.txt\n+mock\n" });
      this.emitNotification("item/started", { threadId: this.threadId, turnId, startedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd-1", command: "git status --short", cwd: process.cwd(), status: "inProgress", aggregatedOutput: null } });
      this.emitNotification("item/commandExecution/outputDelta", { threadId: this.threadId, turnId, itemId: "cmd-1", delta: "clean\n" });
      this.emitNotification("item/completed", { threadId: this.threadId, turnId, completedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd-1", command: "git status --short", cwd: process.cwd(), status: "completed", exitCode: 0, durationMs: 2, aggregatedOutput: "clean\n" } });
      this.emitNotification("item/started", { threadId: this.threadId, turnId, startedAtMs: Date.now(), item: { type: "fileChange", id: "file-1", status: "inProgress", changes: [{ path: "mock.txt", kind: "add", diff: "+mock" }] } });
      this.emitNotification("item/completed", { threadId: this.threadId, turnId, completedAtMs: Date.now(), item: { type: "fileChange", id: "file-1", status: "completed", changes: [{ path: "mock.txt", kind: "add", diff: "+mock" }] } });
      this.emitNotification("item/started", { threadId: this.threadId, turnId, startedAtMs: Date.now(), item: { type: "mcpToolCall", id: "mcp-1", server: "research", tool: "lookup", status: "inProgress", arguments: {}, error: null, result: null, durationMs: null } });
      this.emitNotification("item/completed", { threadId: this.threadId, turnId, completedAtMs: Date.now(), item: { type: "mcpToolCall", id: "mcp-1", server: "research", tool: "lookup", status: "completed", arguments: {}, error: null, result: {}, durationMs: 3 } });
      this.emitNotification("item/agentMessage/delta", { threadId: this.threadId, turnId, itemId: "msg-1", delta: "I inspected the project. " });
      this.emitNotification("item/completed", { threadId: this.threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "I inspected the project.\nAll checks passed in the mock.", phase: "final_answer", memoryCitation: null, delivery: null } });
      this.emitNotification("turn/completed", { threadId: this.threadId, turn: { ...turn(turnId, this.scenario.failed ? "failed" : "completed"), error: this.scenario.failed ? { message: "mock failure", additionalDetails: null } : null } });
    }
  }
}

export function makeConfig(cwd = process.cwd()): any {
  return {
    path: "mock-config.toml", exists: true,
    projects: { default: { id: "default", cwd } },
    profiles: { default: { id: "default", model: "", effort: "", approvalPolicy: "on-request", sandboxType: "workspace-write", networkAccess: false, waitTimeoutSeconds: 1 } },
    defaultWaitTimeoutSeconds: 1, maxInputLength: 100_000, maxPageSize: 100, maxCommandOutput: 4_000, maxArtifactBytes: 32 * 1024 * 1024, restartAttempts: 0,
    redactionPatterns: [], sensitivePaths: [".env", ".ssh"],
  };
}
