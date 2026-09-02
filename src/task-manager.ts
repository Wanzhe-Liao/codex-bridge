import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import type { AppServerClient, JsonRpcNotification, JsonRpcServerRequest } from "./app-server-client.js";
import { resolveCodexInvocation } from "./app-server-process.js";
import { normalizeNotification, type NormalizedEvent } from "./event-normalizer.js";
import {
  loadConfig,
  publicConfig,
  resolveProfile,
  resolveProject,
  sandboxPolicy,
  type ProfileConfig,
  type ProjectConfig,
  type SupervisorConfig,
} from "./config.js";
import { boundedExcerpt, redactJson, redactText, redactValue } from "./redaction.js";
import { pendingRequestFor, pendingRequestJson, responseForPending, type PendingRequestDetail } from "./request-resolver.js";
import { StateStore, type StoredEvent, type StoredTask } from "./store.js";

export type TaskState = "starting" | "running" | "waiting_for_approval" | "waiting_for_input" | "completed" | "failed" | "interrupted" | "connection_lost";
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "interrupted"]);

export interface TaskStartResult {
  task_id: string;
  thread_id: string;
  turn_id: string;
  state: TaskState;
  terminal: false;
}

export interface TaskSnapshot {
  task_id: string;
  thread_id: string | null;
  turn_id: string | null;
  state: TaskState;
  terminal: boolean;
  cursor: string;
  next_cursor: string;
  started_at: string | null;
  last_activity_at: string | null;
  current_plan: Array<{ step: string; status: unknown }>;
  current_activity: string | null;
  codex_messages: string[];
  events: Array<Record<string, unknown>>;
  pending_request: Record<string, unknown> | null;
  warnings: string[];
  error: string | null;
  final_text?: string;
}

interface RuntimeTask extends Omit<StoredTask, "state"> {
  state: TaskState;
  project: ProjectConfig;
  profileConfig: ProfileConfig;
  currentPlan: Array<{ step: string; status: unknown }>;
  currentActivity: string | null;
  messages: string[];
  warnings: string[];
  latestDiff: string | null;
  pending?: PendingRequestDetail;
  finalCandidates: Array<{ text: string; phase: unknown }>;
  revision: number;
  recoveryAttempted?: boolean;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringId(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function notificationThreadId(notification: JsonRpcNotification): string | null {
  const params = rec(notification.params);
  const thread = rec(params.thread);
  return stringId(params.threadId) ?? stringId(thread.id) ?? stringId(params.conversationId);
}

function notificationTurnId(notification: JsonRpcNotification): string | null {
  const params = rec(notification.params);
  return stringId(params.turnId) ?? stringId(rec(params.turn).id);
}

function notificationItemId(notification: JsonRpcNotification): string | null {
  const params = rec(notification.params);
  return stringId(params.itemId) ?? stringId(rec(params.item).id) ?? stringId(params.callId);
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function boundedMessage(text: string): string {
  return text.length <= 100_000 ? text : `${text.slice(0, 60_000)}\n...[message truncated by supervisor]...\n${text.slice(-40_000)}`;
}

function asTaskState(value: string): TaskState {
  const allowed: TaskState[] = ["starting", "running", "waiting_for_approval", "waiting_for_input", "completed", "failed", "interrupted", "connection_lost"];
  return (allowed as string[]).includes(value) ? value as TaskState : "connection_lost";
}

function eventPublic(event: StoredEvent): Record<string, unknown> {
  let payload: unknown;
  try { payload = JSON.parse(event.normalizedJson); } catch { payload = { malformed: true }; }
  return {
    sequence: event.sequence,
    method: event.method,
    event_type: event.eventType,
    item_id: event.itemId,
    payload,
    created_at: event.createdAt,
  };
}

/** Coordinates Codex threads/turns and persists every safe, normalized event. */
export class TaskManager extends EventEmitter {
  private readonly client: AppServerClient;
  private readonly store: StateStore;
  private readonly config: SupervisorConfig;
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly threadToTask = new Map<string, string>();
  private readonly turnToTask = new Map<string, string>();
  private readonly itemToTask = new Map<string, string>();
  private readonly commandOutputChars = new Map<string, number>();
  private readonly orphanNotifications = new Map<string, JsonRpcNotification[]>();
  private connecting?: Promise<void>;
  private recovering = false;
  private modelCatalog?: Array<Record<string, unknown>>;

  constructor(client: AppServerClient, store: StateStore, config: SupervisorConfig = loadConfig()) {
    super();
    this.client = client;
    this.store = store;
    this.config = config;
    this.hydrateTasks();
    this.client.on("notification", (notification: JsonRpcNotification) => this.handleNotification(notification));
    this.client.on("serverRequest", (request: JsonRpcServerRequest) => this.handleServerRequest(request));
    this.client.on("processExit", (info: { code: number | null; signal: NodeJS.Signals | null; intentional: boolean }) => this.handleProcessExit(info));
    this.client.on("processError", (error: Error) => this.handleProcessError(error));
    this.client.on("protocolError", (error: Error) => this.emit("protocolError", error));
  }

  get stateStore(): StateStore { return this.store; }
  get supervisorConfig(): SupervisorConfig { return this.config; }

  async ensureConnected(): Promise<void> {
    if (this.client.isInitialized) return;
    if (!this.connecting) this.connecting = this.client.start().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async startTask(projectId: string, prompt: string, profileId?: string): Promise<TaskStartResult> {
    if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error("prompt must be a non-empty natural-language string");
    if (prompt.length > this.config.maxInputLength) throw new Error(`prompt exceeds ${this.config.maxInputLength} characters`);
    const project = resolveProject(this.config, projectId);
    const profile = resolveProfile(this.config, profileId);
    await this.ensureConnected();
    await this.validateProfile(profile);
    const threadResponse = rec(await this.client.request("thread/start", {
      cwd: project.cwd,
      ...(profile.model ? { model: profile.model } : {}),
      approvalPolicy: profile.approvalPolicy,
      sandbox: profile.sandboxType,
      serviceName: "chatgpt_web_codex_supervisor",
      sessionStartSource: "startup",
      threadSource: "chatgpt_web_codex_supervisor",
    }));
    const thread = rec(threadResponse.thread);
    const threadId = stringId(thread.id);
    if (!threadId) throw new Error("app-server thread/start response did not contain thread.id");
    const now = new Date().toISOString();
    const taskId = crypto.randomUUID();
    const task: RuntimeTask = {
      taskId, projectId, profile: profile.id, threadId, sessionId: stringId(thread.sessionId), currentTurnId: null,
      state: "starting", terminal: false, createdAt: now, updatedAt: now, startedAt: now, lastActivityAt: now, finalText: null, error: null,
      project, profileConfig: profile, currentPlan: [], currentActivity: "Thread started", messages: [], warnings: [], latestDiff: null,
      finalCandidates: [], revision: 0,
    };
    this.tasks.set(taskId, task);
    this.threadToTask.set(threadId, taskId);
    this.store.createTask(task);
    this.adoptOrphans(threadId);
    let turnId: string | null = null;
    try {
      const turnResponse = rec(await this.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        turnTrigger: "user",
        cwd: project.cwd,
        approvalPolicy: profile.approvalPolicy,
        sandboxPolicy: sandboxPolicy(profile, project),
        ...(profile.effort ? { effort: profile.effort } : {}),
        ...(profile.serviceTier ? { serviceTierForTurn: profile.serviceTier } : {}),
        // Deliberately no outputSchema: Codex returns its natural-language answer.
      }));
      turnId = stringId(rec(turnResponse.turn).id);
      if (!turnId) throw new Error("app-server turn/start response did not contain turn.id");
      task.currentTurnId = turnId;
      // A very fast turn/completed or approval request can arrive while the
      // turn/start response is resolving. Never overwrite authoritative state.
      if (!task.terminal && !task.pending) task.state = "running";
      this.turnToTask.set(turnId, taskId);
      this.persistTask(task);
      this.signal(task);
    } catch (error) {
      task.error = redactText(error instanceof Error ? error.message : String(error), this.config);
      task.state = "connection_lost";
      task.terminal = false;
      this.persistTask(task);
      throw error;
    }
    return { task_id: taskId, thread_id: threadId, turn_id: turnId!, state: task.state, terminal: false };
  }

  async send(taskId: string, message: string): Promise<Record<string, unknown>> {
    const task = this.requireTask(taskId);
    if (typeof message !== "string" || message.trim().length === 0) throw new Error("message must be a non-empty natural-language string");
    if (message.length > this.config.maxInputLength) throw new Error(`message exceeds ${this.config.maxInputLength} characters`);
    await this.ensureConnected();
    if (!task.threadId) throw new Error("task has no thread_id");
    if (task.currentTurnId && !task.terminal && task.state !== "connection_lost") {
      await this.client.request("turn/steer", { threadId: task.threadId, expectedTurnId: task.currentTurnId, input: [{ type: "text", text: message, text_elements: [] }] });
      task.state = "running";
      task.error = null;
      task.currentActivity = "Supervisor steered the active turn";
      this.persistTask(task);
      this.signal(task);
      return { task_id: taskId, thread_id: task.threadId, turn_id: task.currentTurnId, state: task.state, terminal: false, mode: "steer" };
    }
    const project = task.project;
    const profile = task.profileConfig;
    await this.validateProfile(profile);
    task.state = "running";
    task.terminal = false;
    task.error = null;
    task.finalText = null;
    task.finalCandidates = [];
    this.persistTask(task);
    let response: Record<string, unknown>;
    try {
      response = rec(await this.client.request("turn/start", {
        threadId: task.threadId,
        input: [{ type: "text", text: message, text_elements: [] }],
        turnTrigger: "user",
        ...(profile.effort ? { effort: profile.effort } : {}),
        ...(profile.serviceTier ? { serviceTierForTurn: profile.serviceTier } : {}),
        cwd: project.cwd,
        approvalPolicy: profile.approvalPolicy,
        sandboxPolicy: sandboxPolicy(profile, project),
      }));
    } catch (error) {
      task.state = "connection_lost";
      task.terminal = false;
      task.error = redactText(error instanceof Error ? error.message : String(error), this.config);
      this.persistTask(task);
      throw error;
    }
    const turnId = stringId(rec(response.turn).id);
    if (!turnId) throw new Error("app-server turn/start response did not contain turn.id");
    task.currentTurnId = turnId;
    if (!task.terminal && !task.pending) task.state = "running";
    task.currentActivity = "New turn started on the existing thread";
    this.turnToTask.set(turnId, taskId);
    this.persistTask(task);
    this.signal(task);
    return { task_id: taskId, thread_id: task.threadId, turn_id: turnId, state: task.state, terminal: false, mode: "new_turn" };
  }

  async respond(taskId: string, requestId: string | number, action: string, payload?: unknown): Promise<Record<string, unknown>> {
    const task = this.requireTask(taskId);
    const requestKey = String(requestId);
    const detail = task.pending && String(task.pending.requestId) === requestKey ? task.pending : this.loadPendingDetail(task, requestKey);
    if (!detail) throw new Error(`No pending request ${requestKey} for task ${taskId}`);
    await this.ensureConnected();
    if ((detail.kind === "auth_token_request" || detail.kind === "attestation_request") && action === "decline") {
      this.client.respond(detail.requestId, undefined, { code: -32_001, message: "Declined by Codex supervisor: credential-like client response is not available" });
    } else {
      const response = responseForPending(detail, action, payload, { projectCwd: task.project.cwd });
      this.client.respond(detail.requestId, response);
    }
    this.store.resolvePendingRequest(taskId, requestKey);
    task.pending = undefined;
    if (!task.terminal) task.state = "running";
    task.currentActivity = `Supervisor responded to ${detail.kind}`;
    task.error = null;
    this.appendSyntheticEvent(task, detail.method, detail.kind === "user_input" ? "user_input_responded" : "approval_responded", { request_id: detail.requestId, action });
    this.persistTask(task);
    this.signal(task);
    return { task_id: taskId, request_id: detail.requestId, state: task.state, terminal: task.terminal, resolved: true };
  }

  async cancel(taskId: string, reason?: string): Promise<TaskSnapshot> {
    const task = this.requireTask(taskId);
    if (task.terminal || !task.currentTurnId || !task.threadId) return this.snapshot(task, String(this.store.latestSequence(taskId)), []);
    await this.ensureConnected();
    try {
      await this.client.request("turn/interrupt", { threadId: task.threadId, turnId: task.currentTurnId });
    } catch (error) {
      task.error = redactText(error instanceof Error ? error.message : String(error), this.config);
      this.persistTask(task);
    }
    const deadline = Date.now() + 30_000;
    while (!task.terminal && Date.now() < deadline) {
      await Promise.race([this.waitForSignal(task, 500), sleep(500)]);
    }
    if (!task.terminal && reason) {
      task.warnings.push(`Cancel requested: ${boundedMessage(reason).slice(0, 2_000)}`);
      this.persistTask(task);
    }
    return this.snapshot(task, String(this.store.latestSequence(taskId)), []);
  }

  async wait(taskId: string, cursor?: string, timeoutSeconds?: number): Promise<TaskSnapshot> {
    const task = this.requireTask(taskId);
    const parsedCursor = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    let currentCursor = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
    const timeout = Math.max(1, Math.min(300, timeoutSeconds ?? task.profileConfig.waitTimeoutSeconds ?? this.config.defaultWaitTimeoutSeconds)) * 1_000;
    const deadline = Date.now() + timeout;
    while (true) {
      const events = this.store.eventsAfter(taskId, currentCursor, this.config.maxPageSize);
      if (events.length > 0 || task.terminal || task.pending) {
        const next = events.length ? events[events.length - 1].sequence : currentCursor;
        return this.snapshot(task, String(currentCursor), events, String(next));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.snapshot(task, String(currentCursor), [], String(currentCursor));
      await this.waitForSignal(task, Math.min(remaining, 1_000));
      currentCursor = Number.parseInt(cursor ?? String(currentCursor), 10);
    }
  }

  status(taskId?: string): Record<string, unknown> {
    if (taskId) {
      const task = this.requireTask(taskId);
      return this.snapshot(task, String(this.store.latestSequence(taskId)), []) as unknown as Record<string, unknown>;
    }
    const tasks = [...this.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50);
    return {
      app_server: { running: this.client.isRunning, initialized: this.client.isInitialized, connected_at: this.client.connectionTime ?? null },
      active_tasks: tasks.filter((task) => !task.terminal).map((task) => this.taskSummary(task)),
      recent_tasks: tasks.map((task) => this.taskSummary(task)),
    };
  }

  async result(taskId: string): Promise<Record<string, unknown>> {
    const task = this.requireTask(taskId);
    if (!task.terminal) {
      return { task_id: taskId, terminal: false, state: task.state, message: "Task is not terminal. Continue calling codex_wait; no final delivery is available." };
    }
    const objectiveEvidence = await this.collectEvidence(task);
    return {
      task_id: taskId,
      thread_id: task.threadId,
      turn_id: task.currentTurnId,
      turn_status: task.state === "completed" ? "completed" : task.state,
      final_text: task.finalText ?? "",
      current_plan: task.currentPlan,
      objective_evidence: objectiveEvidence,
      warnings: task.warnings,
      protocol_error: null,
      turn_error: task.error,
      timestamps: { started_at: task.startedAt, completed_at: task.updatedAt },
      model: task.profileConfig.model || null,
      profile: task.profile,
    };
  }

  inspect(taskId: string, kind: string, itemId?: string, offset = 0, limit = this.config.maxPageSize): Record<string, unknown> {
    const task = this.requireTask(taskId);
    const safeOffset = Math.max(0, Math.min(1_000_000, Number.isFinite(offset) ? offset : 0));
    const safeLimit = Math.max(1, Math.min(this.config.maxPageSize, Number.isFinite(limit) ? limit : this.config.maxPageSize));
    const stored = this.store.recentEvents(taskId, 5_000);
    let rows: Array<Record<string, unknown>>;
    switch (kind) {
      case "transcript": rows = stored.filter((e) => ["agent_message", "reasoning_summary"].includes(e.eventType)).map(eventPublic); break;
      case "plan": rows = stored.filter((e) => e.eventType === "plan_updated" || e.eventType === "plan_delta").map(eventPublic); break;
      case "diff": rows = stored.filter((e) => e.eventType === "diff_updated").map(eventPublic); break;
      case "commands": rows = stored.filter((e) => e.eventType === "command_started" || e.eventType === "command_completed").map(eventPublic); break;
      case "command_output": rows = stored.filter((e) => e.eventType === "command_output" && (!itemId || e.itemId === itemId)).map(eventPublic); break;
      case "file_changes": rows = stored.filter((e) => e.eventType === "file_change_started" || e.eventType === "file_change_completed").map(eventPublic); break;
      case "mcp_calls": rows = stored.filter((e) => e.eventType.includes("mcp_tool")).map(eventPublic); break;
      case "warnings": rows = stored.filter((e) => e.eventType === "warning" || e.eventType === "error").map(eventPublic); break;
      case "raw_event": rows = stored.slice().map((e) => ({ sequence: e.sequence, method: e.method, item_id: e.itemId, event_type: e.eventType, raw_event: e.rawJsonRedacted, created_at: e.createdAt })); break;
      default: throw new Error(`Unknown inspect kind: ${kind}`);
    }
    const page = rows.slice(safeOffset, safeOffset + safeLimit);
    return { task_id: taskId, kind, item_id: itemId ?? null, offset: safeOffset, limit: safeLimit, total: rows.length, next_offset: safeOffset + page.length < rows.length ? safeOffset + page.length : null, data: page };
  }

  async health(): Promise<Record<string, unknown>> {
    const warnings: string[] = [];
    let models: unknown[] = [];
    let account: Record<string, unknown> | null = null;
    try {
      await this.ensureConnected();
      const response = rec(await this.client.request("model/list", { includeHidden: false, limit: 100 }));
      models = Array.isArray(response.data) ? response.data.map((model) => {
        const m = rec(model);
        return { id: m.id ?? null, model: m.model ?? null, displayName: m.displayName ?? null, hidden: Boolean(m.hidden), default: Boolean(m.isDefault), supportedReasoningEfforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((item) => rec(item).reasoningEffort).filter((item) => typeof item === "string") : [] };
      }) : [];
      try { account = rec(await this.client.request("account/read", {})); } catch (error) { warnings.push(`account status unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    } catch (error) {
      warnings.push(`app-server unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      config: publicConfig(this.config),
      available_project_ids: Object.keys(this.config.projects),
      available_profiles: Object.keys(this.config.profiles),
      app_server: { running: this.client.isRunning, initialized: this.client.isInitialized, connected_at: this.client.connectionTime ?? null },
      models,
      login: account ? { available: Boolean(account.account), requiresOpenaiAuth: Boolean(account.requiresOpenaiAuth), accountType: rec(account.account).type ?? null } : { available: false },
      sqlite: { path: this.store.path, writable: this.store.writable() },
      warnings,
    };
  }

  private hydrateTasks(): void {
    for (const stored of this.store.listTasks(500)) {
      let project: ProjectConfig;
      let profile: ProfileConfig;
      try {
        project = this.config.projects[stored.projectId] ?? { id: stored.projectId, cwd: process.cwd() };
        profile = resolveProfile(this.config, stored.profile);
      } catch {
        project = { id: stored.projectId, cwd: process.cwd() };
        profile = resolveProfile(this.config);
      }
      const task: RuntimeTask = { ...stored, state: asTaskState(stored.state), project, profileConfig: profile, currentPlan: [], currentActivity: null, messages: [], warnings: [], latestDiff: null, finalCandidates: [], revision: 0 };
      this.tasks.set(task.taskId, task);
      if (task.threadId) this.threadToTask.set(task.threadId, task.taskId);
      if (task.currentTurnId) this.turnToTask.set(task.currentTurnId, task.taskId);
      for (const event of this.store.recentEvents(task.taskId, 5_000)) this.replayEvent(task, event);
      const pending = this.store.getPendingRequest(task.taskId);
      if (pending) {
        try { task.pending = JSON.parse(pending.requestJsonRedacted) as PendingRequestDetail; } catch { /* no-op */ }
      }
    }
  }

  private async recoverAfterCrash(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      for (let attempt = 0; attempt <= this.config.restartAttempts; attempt += 1) {
        try {
          await this.ensureConnected();
          for (const task of this.tasks.values()) {
            if (task.terminal || !task.threadId || task.recoveryAttempted) continue;
            task.recoveryAttempted = true;
            try {
              const response = rec(await this.client.request("thread/resume", { threadId: task.threadId, excludeTurns: true }));
              const thread = rec(response.thread);
              const turns = Array.isArray(thread.turns) ? thread.turns : [];
              const latest = turns.length ? rec(turns[turns.length - 1]) : {};
              const resumedTurn = stringId(latest.id);
              if (latest.status === "inProgress" && resumedTurn) {
                task.currentTurnId = resumedTurn;
                this.turnToTask.set(resumedTurn, task.taskId);
                task.state = "running";
                task.error = null;
                this.persistTask(task);
                this.appendSyntheticEvent(task, "thread/resume", "connection_recovered", { thread_id: task.threadId, turn_id: resumedTurn });
              }
            } catch (error) {
              task.error = redactText(`thread/resume failed: ${error instanceof Error ? error.message : String(error)}`, this.config);
              this.persistTask(task);
            }
          }
          return;
        } catch (error) {
          if (attempt >= this.config.restartAttempts) {
            for (const task of this.tasks.values()) if (!task.terminal) { task.state = "connection_lost"; task.error = redactText(error instanceof Error ? error.message : String(error), this.config); this.persistTask(task); }
            return;
          }
          await sleep(250 * (attempt + 1));
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  private handleProcessExit(info: { code: number | null; signal: NodeJS.Signals | null; intentional: boolean }): void {
    if (info.intentional) return;
    for (const task of this.tasks.values()) {
      if (!task.terminal) {
        task.state = "connection_lost";
        task.error = `app-server exited (code=${info.code ?? "null"}, signal=${info.signal ?? "none"})`;
        this.appendSyntheticEvent(task, "process/exited", "connection_lost", { code: info.code, signal: info.signal });
        this.persistTask(task);
      }
    }
    void this.recoverAfterCrash();
  }

  private handleProcessError(error: Error): void {
    for (const task of this.tasks.values()) if (!task.terminal) { task.state = "connection_lost"; task.error = redactText(error.message, this.config); this.persistTask(task); }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const threadId = notificationThreadId(notification);
    const turnId = notificationTurnId(notification);
    const itemId = notificationItemId(notification);
    const taskId = (threadId && this.threadToTask.get(threadId)) || (turnId && this.turnToTask.get(turnId)) || (itemId && this.itemToTask.get(itemId));
    if (!taskId) {
      if (threadId) {
        const orphan = this.orphanNotifications.get(threadId) ?? [];
        orphan.push(notification);
        if (orphan.length > 100) orphan.shift();
        this.orphanNotifications.set(threadId, orphan);
      }
      return;
    }
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.processNotification(task, notification);
  }

  private processNotification(task: RuntimeTask, notification: JsonRpcNotification): void {
    const normalized = normalizeNotification(notification.method, notification.params, this.config);
    if (!normalized) return;
    if (normalized.eventType === "command_output") {
      const outputKey = `${task.taskId}:${normalized.itemId ?? "unknown"}`;
      const seen = this.commandOutputChars.get(outputKey) ?? 0;
      const cap = this.config.maxCommandOutput * 20;
      if (seen >= cap) return;
      const delta = typeof normalized.payload.delta === "string" ? normalized.payload.delta : "";
      const remaining = cap - seen;
      if (delta.length > remaining) normalized.payload.delta = `${delta.slice(0, Math.max(0, remaining))}\n...[command output storage cap reached]...`;
      this.commandOutputChars.set(outputKey, seen + delta.length);
    }
    const raw = this.safeRawNotification(notification);
    const stored = this.store.appendEvent({ taskId: task.taskId, method: normalized.method, itemId: normalized.itemId, eventType: normalized.eventType, normalizedJson: JSON.stringify(normalized.payload), rawJsonRedacted: raw });
    this.replayEvent(task, stored, normalized);
    this.persistTask(task);
    this.signal(task);
    this.emit("event", task.taskId, stored);
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const params = rec(request.params);
    const threadId = stringId(params.threadId) ?? stringId(params.conversationId);
    const taskId = (threadId && this.threadToTask.get(threadId)) || (stringId(params.turnId) && this.turnToTask.get(stringId(params.turnId)!));
    if (!taskId) return;
    const task = this.tasks.get(taskId);
    if (!task) return;
    const detail = pendingRequestFor(taskId, request, this.config);
    task.pending = detail;
    task.state = detail.kind === "user_input" ? "waiting_for_input" : "waiting_for_approval";
    task.currentActivity = detail.description;
    this.store.savePendingRequest({ taskId, requestId: String(request.id), kind: detail.kind, requestJsonRedacted: pendingRequestJson(detail, this.config), resolved: false, createdAt: new Date().toISOString(), resolvedAt: null });
    this.appendSyntheticEvent(task, request.method, detail.kind === "user_input" ? "user_input_requested" : "approval_requested", {
      request_id: request.id, kind: detail.kind, description: detail.description, context: detail.context, allowed_actions: detail.allowedActions, response_contract: detail.responseContract, autoResolutionMs: detail.autoResolutionMs ?? null,
    });
    this.persistTask(task);
    this.signal(task);
    this.emit("pendingRequest", task.taskId, detail);
  }

  private adoptOrphans(threadId: string): void {
    const taskId = this.threadToTask.get(threadId);
    const task = taskId ? this.tasks.get(taskId) : undefined;
    const orphan = this.orphanNotifications.get(threadId);
    if (!task || !orphan) return;
    this.orphanNotifications.delete(threadId);
    for (const notification of orphan) this.processNotification(task, notification);
  }

  private replayEvent(task: RuntimeTask, stored: StoredEvent, normalized?: NormalizedEvent): void {
    let payload: Record<string, unknown> = {};
    try { payload = rec(JSON.parse(stored.normalizedJson)); } catch { /* no-op */ }
    const eventType = normalized?.eventType ?? stored.eventType;
    if (eventType === "turn_started") {
      const id = stringId(payload.turn_id);
      if (id) { task.currentTurnId = id; this.turnToTask.set(id, task.taskId); }
      if (!task.terminal) task.state = "running";
      task.currentActivity = "Turn started";
      const started = stringId(payload.started_at);
      if (started) task.startedAt = new Date(Number(started) * 1_000).toISOString();
    } else if (eventType === "turn_completed") {
      const status = payload.status;
      const completedTurnId = stringId(payload.turn_id);
      if (completedTurnId && task.currentTurnId && completedTurnId !== task.currentTurnId) {
        task.currentActivity = `Historical turn ${completedTurnId} completed`;
      } else if (status === "completed" || status === "failed" || status === "interrupted") {
        task.terminal = true;
        task.state = status === "completed" ? "completed" : status;
        task.currentActivity = `Turn ${status}`;
        if (payload.error && rec(payload.error).message) task.error = String(rec(payload.error).message);
        if (task.finalText === null) task.finalText = this.selectFinalText(task);
      } else {
        task.warnings.push("Received turn/completed without a recognized terminal status");
      }
    } else if (eventType === "plan_updated") {
      task.currentPlan = Array.isArray(payload.plan) ? payload.plan.map((step) => { const s = rec(step); return { step: String(s.step ?? ""), status: s.status }; }) : [];
      task.currentActivity = "Plan updated";
    } else if (eventType === "diff_updated") {
      task.latestDiff = typeof payload.diff === "string" ? payload.diff : task.latestDiff;
      task.currentActivity = "Diff updated";
    } else if (eventType === "agent_message") {
      const message = typeof payload.text === "string" ? payload.text : "";
      if (message) {
        const candidate = boundedMessage(normalized?.finalText ?? message);
        task.messages.push(candidate);
        if (payload.type === "agentMessage") task.finalCandidates.push({ text: candidate, phase: payload.phase ?? null });
      }
      task.currentActivity = "Codex message received";
    } else if (["command_completed", "file_change_completed", "mcp_tool_completed", "item_completed"].includes(eventType)) {
      const itemType = String(payload.type ?? "");
      if (itemType === "commandExecution") task.currentActivity = `Command ${String(payload.status ?? "updated")}`;
      else if (itemType === "fileChange") task.currentActivity = `File change ${String(payload.status ?? "updated")}`;
      else if (itemType === "mcpToolCall") task.currentActivity = `MCP tool ${String(payload.status ?? "updated")}`;
    } else if (["command_started", "file_change_started", "mcp_tool_started", "item_started"].includes(eventType)) {
      const itemType = String(payload.type ?? "item");
      if (stored.itemId) this.itemToTask.set(stored.itemId, task.taskId);
      task.currentActivity = `${itemType} started`;
    } else if (eventType === "warning" || eventType === "error") {
      if (typeof payload.message === "string") task.warnings.push(payload.message);
      task.currentActivity = eventType === "error" ? "Codex reported an error" : "Warning received";
    } else if (eventType === "server_request_resolved") {
      const requestId = stringId(payload.request_id);
      if (requestId) this.store.resolvePendingRequest(task.taskId, requestId);
      if (task.pending && (!requestId || String(task.pending.requestId) === requestId)) task.pending = undefined;
      if (!task.terminal) task.state = "running";
    } else if (eventType === "connection_lost") {
      task.state = "connection_lost";
      task.terminal = false;
    }
    task.updatedAt = new Date().toISOString();
    task.lastActivityAt = task.updatedAt;
    task.revision += 1;
    if (task.messages.length > 200) task.messages.splice(0, task.messages.length - 200);
    if (task.warnings.length > 100) task.warnings.splice(0, task.warnings.length - 100);
  }

  private selectFinalText(task: RuntimeTask): string | null {
    const finalAnswer = [...task.finalCandidates].reverse().find((candidate) => candidate.phase === "final_answer");
    const candidate = finalAnswer ?? task.finalCandidates.at(-1);
    return candidate?.text ?? task.finalText ?? null;
  }

  private appendSyntheticEvent(task: RuntimeTask, method: string, eventType: string, payload: Record<string, unknown>): void {
    const event = this.store.appendEvent({ taskId: task.taskId, method, itemId: null, eventType, normalizedJson: JSON.stringify(redactValue(payload, this.config)), rawJsonRedacted: redactJson({ method, params: payload }, this.config) });
    this.replayEvent(task, event);
    this.emit("event", task.taskId, event);
  }

  private persistTask(task: RuntimeTask): void {
    this.store.updateTask(task.taskId, {
      threadId: task.threadId, sessionId: task.sessionId, currentTurnId: task.currentTurnId, state: task.state, terminal: task.terminal,
      updatedAt: task.updatedAt, startedAt: task.startedAt, lastActivityAt: task.lastActivityAt, finalText: task.finalText, error: task.error,
    });
  }

  private signal(task: RuntimeTask): void { this.emit(`task:${task.taskId}`, task.revision); }
  private waitForSignal(task: RuntimeTask, timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const eventName = `task:${task.taskId}`;
      const listener = () => { clearTimeout(timer); this.off(eventName, listener); resolve(); };
      const timer = setTimeout(() => { this.off(eventName, listener); resolve(); }, timeout);
      this.once(eventName, listener);
    });
  }

  private requireTask(taskId: string): RuntimeTask {
    if (!taskId || taskId.length > 128) throw new Error("Invalid task_id");
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task_id: ${taskId}`);
    return task;
  }

  private loadPendingDetail(task: RuntimeTask, requestId: string): PendingRequestDetail | undefined {
    const stored = this.store.getPendingRequest(task.taskId, requestId);
    if (!stored) return undefined;
    try {
      const json = JSON.parse(stored.requestJsonRedacted) as Record<string, unknown>;
      // A restarted process retains a safe description but not unredacted parameters.
      return {
        requestId: requestId, taskId: task.taskId, method: String(json.method ?? ""), kind: String(json.kind ?? stored.kind), description: String(json.description ?? ""),
        context: rec(json.context), allowedActions: Array.isArray(json.allowed_actions) ? json.allowed_actions.filter((v): v is string => typeof v === "string") : ["decline"], responseContract: String(json.response_contract ?? "Decline only."), rawParams: rec(json.raw_params ?? json.context),
      };
    } catch { return undefined; }
  }

  private snapshot(task: RuntimeTask, cursor: string, events: StoredEvent[], nextCursor = cursor): TaskSnapshot {
    const snapshot: TaskSnapshot = {
      task_id: task.taskId, thread_id: task.threadId, turn_id: task.currentTurnId, state: task.state, terminal: task.terminal,
      cursor, next_cursor: nextCursor, started_at: task.startedAt, last_activity_at: task.lastActivityAt, current_plan: task.currentPlan,
      current_activity: task.currentActivity, codex_messages: task.messages.slice(-50), events: events.map(eventPublic),
      pending_request: task.pending ? this.publicPending(task.pending) : null, warnings: task.warnings.slice(-50), error: task.error,
    };
    if (task.terminal && task.finalText !== null) snapshot.final_text = task.finalText;
    return snapshot;
  }

  private publicPending(detail: PendingRequestDetail): Record<string, unknown> {
    return { request_id: detail.requestId, kind: detail.kind, description: detail.description, context: detail.context, allowed_actions: detail.allowedActions, response_contract: detail.responseContract, ...(detail.autoResolutionMs === undefined ? {} : { autoResolutionMs: detail.autoResolutionMs }) };
  }

  private taskSummary(task: RuntimeTask): Record<string, unknown> {
    return { task_id: task.taskId, project_id: task.projectId, profile: task.profile, thread_id: task.threadId, turn_id: task.currentTurnId, state: task.state, terminal: task.terminal, updated_at: task.updatedAt, last_activity_at: task.lastActivityAt, pending_request: task.pending ? this.publicPending(task.pending) : null, error: task.error };
  }

  private itemEventType(event: StoredEvent): string | null {
    try { return stringId(rec(JSON.parse(event.normalizedJson)).type); } catch { return null; }
  }

  private safeRawNotification(notification: JsonRpcNotification): string {
    const params = rec(notification.params);
    if (notification.method === "item/reasoning/textDelta" || notification.method === "item/reasoning/summaryTextDelta") {
      return redactJson({ method: notification.method, params: { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: "[REDACTED_REASONING]" } }, this.config);
    }
    if (notification.method === "item/completed" && rec(params.item).type === "reasoning") {
      const item = rec(params.item);
      return redactJson({ method: notification.method, params: { threadId: params.threadId, turnId: params.turnId, item: { type: "reasoning", id: item.id, summary: item.summary } } }, this.config);
    }
    const safe = redactValue(notification, this.config) as Record<string, unknown>;
    if (safe.params && typeof safe.params === "object") {
      const p = safe.params as Record<string, unknown>;
      if (typeof p.delta === "string") p.delta = boundedExcerpt(p.delta, this.config.maxCommandOutput).text;
      if (p.item && typeof p.item === "object") {
        const item = p.item as Record<string, unknown>;
        if (typeof item.aggregatedOutput === "string") item.aggregatedOutput = boundedExcerpt(item.aggregatedOutput, this.config.maxCommandOutput).text;
        if (Array.isArray(item.changes)) item.changes = item.changes.slice(0, 100).map((change) => { const c = rec(change); return { path: c.path, kind: c.kind, diff: boundedExcerpt(typeof c.diff === "string" ? c.diff : "", 800).text }; });
      }
    }
    return JSON.stringify(safe);
  }

  private async collectEvidence(task: RuntimeTask): Promise<Record<string, unknown>> {
    const events = this.store.recentEvents(task.taskId, 5_000);
    const commands: unknown[] = [];
    const fileChanges: unknown[] = [];
    const mcpCalls: unknown[] = [];
    const warnings: string[] = [];
    for (const event of events) {
      let payload: Record<string, unknown> = {};
      try { payload = rec(JSON.parse(event.normalizedJson)); } catch { /* no-op */ }
      if (payload.type === "commandExecution") commands.push(payload);
      if (payload.type === "fileChange") fileChanges.push(payload);
      if (payload.type === "mcpToolCall") mcpCalls.push(payload);
      if (event.eventType === "warning" || event.eventType === "error") if (typeof payload.message === "string") warnings.push(payload.message);
    }
    const gitEvidence: Record<string, unknown> = {};
    for (const command of [["git", "status", "--short"], ["git", "diff", "--stat"], ["git", "diff", "--name-only"]]) {
      const key = command.slice(1).join("_").replaceAll("-", "_");
      try {
        await this.ensureConnected();
        const response = rec(await this.client.request("command/exec", { command, cwd: task.project.cwd, outputBytesCap: 8_000 }));
        gitEvidence[key] = { exit_code: response.exitCode ?? null, stdout: boundedExcerpt(redactText(String(response.stdout ?? ""), this.config), 4_000).text, stderr: boundedExcerpt(redactText(String(response.stderr ?? ""), this.config), 2_000).text };
      } catch (error) {
        gitEvidence[key] = { unavailable: redactText(error instanceof Error ? error.message : String(error), this.config) };
      }
    }
    return {
      authoritative_turn_completed: task.terminal,
      turn_state: task.state,
      command_executions: commands,
      file_changes: fileChanges,
      mcp_tool_calls: mcpCalls,
      latest_diff: task.latestDiff,
      git_readonly_checks: gitEvidence,
      warnings,
      started_at: task.startedAt,
      completed_at: task.terminal ? task.updatedAt : null,
    };
  }

  private async validateProfile(profile: ProfileConfig): Promise<void> {
    if (!profile.model && !profile.effort && !profile.serviceTier) return;
    if (!this.modelCatalog) {
      const response = rec(await this.client.request("model/list", { includeHidden: false, limit: 200 }));
      this.modelCatalog = Array.isArray(response.data) ? response.data.map(rec) : [];
    }
    const model = profile.model
      ? this.modelCatalog.find((candidate) => candidate.id === profile.model || candidate.model === profile.model)
      : this.modelCatalog.find((candidate) => candidate.isDefault === true);
    if (!model) throw new Error(`Configured model '${profile.model}' is not present in app-server model/list`);
    if (profile.effort) {
      const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((value) => rec(value).reasoningEffort).filter((value): value is string => typeof value === "string") : [];
      if (!efforts.includes(profile.effort)) throw new Error(`Configured effort '${profile.effort}' is not supported by model '${String(model.model ?? model.id)}'`);
    }
    if (profile.serviceTier) {
      const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers.map((value) => rec(value).id).filter((value): value is string => typeof value === "string") : [];
      if (!tiers.includes(profile.serviceTier)) throw new Error(`Configured service tier '${profile.serviceTier}' is not supported by model '${String(model.model ?? model.id)}'`);
    }
  }
}

export function codexVersion(): string | null {
  try {
    const invocation = resolveCodexInvocation(["--version"]);
    const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const output = `${result.stdout ?? ""}`.trim();
    return output || null;
  } catch { return null; }
}

export function configFileReadable(config: SupervisorConfig): boolean {
  try { return fs.existsSync(config.path) && fs.statSync(config.path).isFile(); } catch { return false; }
}
