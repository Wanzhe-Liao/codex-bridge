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
import { pendingRequestFor, responseForPending, type PendingRequestDetail } from "./request-resolver.js";
import { StateStore, type StoredEvent, type StoredTask } from "./store.js";
import { BRIDGE_WEB_TOOL, checkedSubmission, canonicalJson, publicToolRequest, relayArguments, type Interaction } from "./relay.js";

export type TaskState = "starting" | "running" | "waiting_for_tool" | "waiting_for_approval" | "waiting_for_input" | "completed" | "failed" | "interrupted" | "connection_lost";
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
  pending_requests: Record<string, unknown>[];
  tool_requests: Record<string, unknown>[];
  relay_enabled: boolean;
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
  cancelRequested?: boolean;
  threadConnectionId?: string;
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
  const allowed: TaskState[] = ["starting", "running", "waiting_for_tool", "waiting_for_approval", "waiting_for_input", "completed", "failed", "interrupted", "connection_lost"];
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
  private readonly interactions = new Map<string, Interaction>();

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
      ...(this.config.relay?.enabled !== false ? { dynamicTools: [BRIDGE_WEB_TOOL] } : {}),
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
      finalCandidates: [], revision: 0, relayEnabled: this.config.relay?.enabled !== false, threadConnectionId: this.client.connectionId,
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
      if (!task.terminal) { task.state = "running"; this.refreshPending(task); }
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
    if (task.threadConnectionId !== this.client.connectionId) {
      await this.client.request("thread/resume", { threadId: task.threadId });
      task.threadConnectionId = this.client.connectionId;
    }
    if (task.currentTurnId && !task.terminal && task.state !== "connection_lost") {
      await this.client.request("turn/steer", { threadId: task.threadId, expectedTurnId: task.currentTurnId, input: [{ type: "text", text: message, text_elements: [] }] });
      task.state = "running";
      this.refreshPending(task);
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
    task.cancelRequested = false;
    task.currentTurnId = null;
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
    if (!task.terminal) { task.state = "running"; this.refreshPending(task); }
    task.currentActivity = "New turn started on the existing thread";
    this.turnToTask.set(turnId, taskId);
    this.persistTask(task);
    this.signal(task);
    return { task_id: taskId, thread_id: task.threadId, turn_id: turnId, state: task.state, terminal: false, mode: "new_turn" };
  }

  async respond(taskId: string, requestId: string | number, action: string, payload?: unknown): Promise<Record<string, unknown>> {
    const task = this.requireTask(taskId);
    const interaction = [...this.interactions.values()].find((r) => r.taskId === taskId && r.kind === "approval" && r.rpcId === requestId && r.state === "pending");
    const detail = interaction?.detail;
    if (!detail || !interaction) throw new Error(`No pending request for task ${taskId}`);
    this.validateInteraction(task, interaction);
    const credentialDecline = (detail.kind === "auth_token_request" || detail.kind === "attestation_request") && action === "decline";
    const response = credentialDecline ? undefined : responseForPending(detail, action, payload, { projectCwd: task.project.cwd });
    interaction.submission = redactValue({ action, response }, this.config);
    interaction.state = "sending";
    this.saveInteraction(interaction);
    try {
      await this.client.respondChecked(detail.requestId, response, interaction.connectionId, credentialDecline ? { code: -32001, message: "Credential-like response declined" } : undefined);
      if ((interaction.state as string) === "sending") interaction.state = "submitted";
    } catch { interaction.state = "uncertain"; }
    this.saveInteraction(interaction);
    this.refreshPending(task);
    task.currentActivity = `Supervisor responded to ${detail.kind}`;
    task.error = null;
    this.appendSyntheticEvent(task, detail.method, detail.kind === "user_input" ? "user_input_responded" : "approval_responded", { request_id: detail.requestId, action });
    this.persistTask(task);
    this.signal(task);
    return { task_id: taskId, request_id: detail.requestId, state: task.state, terminal: task.terminal, resolved: interaction.state !== "uncertain", delivery_state: interaction.state };
  }

  async submitToolResult(taskId: string, requestId: string, input: unknown): Promise<Record<string, unknown>> {
    const task = this.requireTask(taskId);
    const r = this.interactions.get(requestId);
    if (!r || r.taskId !== taskId || r.kind !== "relay") throw new Error("Unknown tool request for this task");
    const { safe, canonical } = checkedSubmission(input, this.config);
    const fingerprint = crypto.createHash("sha256").update(canonical).digest("hex");
    if (r.fingerprint) {
      if (r.fingerprint !== fingerprint) throw new Error("Conflicting duplicate tool result");
      return { task_id: taskId, request_id: r.id, delivery_state: r.state, duplicate: true, terminal: task.terminal,
        warning: r.state === "uncertain" || r.state === "sending" ? "Delivery is uncertain; do not repeat the Web-side operation." : undefined };
    }
    this.validateInteraction(task, r);
    r.fingerprint = fingerprint;
    r.submission = safe;
    r.state = "sending";
    this.saveInteraction(r);
    try {
      await this.client.respondChecked(r.rpcId, { contentItems: [{ type: "inputText", text: JSON.stringify({ provenance: "web_host_submitted_not_independently_verified", ...safe }) }], success: safe.status === "success" }, r.connectionId);
      // A completion notification may have arrived before the pipe callback.
      if ((r.state as string) === "sending") r.state = "submitted";
    } catch {
      r.state = "uncertain";
    }
    this.saveInteraction(r);
    this.appendSyntheticEvent(task, "bridge/toolResult", "web_tool_result_submitted", { request_id: r.id, turn_id: r.turnId, status: safe.status, delivery_state: r.state, provenance: "web_host_report_not_independently_verified", tool_used: safe.tool_used ?? null });
    this.refreshPending(task);
    this.persistTask(task);
    this.signal(task);
    return { task_id: taskId, request_id: r.id, turn_id: r.turnId, delivery_state: r.state, terminal: task.terminal,
      ...(r.state === "uncertain" ? { warning: "Response delivery is uncertain. Do not repeat a Web-side write; inspect state or cancel/steer safely." } : {}) };
  }

  private validateInteraction(task: RuntimeTask, r: Interaction): void {
    if (task.terminal || task.cancelRequested || task.state === "connection_lost" || r.state !== "pending" || r.turnId !== task.currentTurnId || r.threadId !== task.threadId ||
        r.connectionId !== this.client.connectionId || !this.client.isInitialized || !this.client.pendingServerRequests.has(JSON.stringify(r.rpcId))) {
      throw new Error("Stale, cancelled, resolved or mismatched task/turn/connection request");
    }
  }

  private saveInteraction(r: Interaction): void {
    r.updatedAt = new Date().toISOString();
    this.interactions.set(r.id, r);
    this.store.saveInteraction(r.id, r.taskId, { ...r, detail: redactValue(r.detail, this.config), request: redactValue(r.request, this.config), submission: redactValue(r.submission, this.config) });
  }

  private openInteractions(task: RuntimeTask): Interaction[] {
    return [...this.interactions.values()].filter((r) => r.taskId === task.taskId && r.turnId === task.currentTurnId && r.state === "pending");
  }

  private refreshPending(task: RuntimeTask): void {
    const pending = this.openInteractions(task);
    task.pending = pending.find((r) => r.kind === "approval")?.detail;
    if (task.terminal || task.state === "connection_lost") return;
    task.state = task.pending ? (task.pending.kind === "user_input" ? "waiting_for_input" : "waiting_for_approval") : pending.some((r) => r.kind === "relay") ? "waiting_for_tool" : "running";
  }

  private invalidateInteractions(task: RuntimeTask): void {
    for (const r of this.interactions.values()) if (r.taskId === task.taskId && ["pending", "sending"].includes(r.state)) {
      r.state = r.state === "sending" ? "uncertain" : "stale";
      this.saveInteraction(r);
    }
    this.refreshPending(task);
  }

  async cancel(taskId: string, reason?: string): Promise<TaskSnapshot> {
    const task = this.requireTask(taskId);
    if (task.terminal || !task.currentTurnId || !task.threadId) return this.snapshot(task, String(this.store.latestSequence(taskId)), []);
    await this.ensureConnected();
    task.cancelRequested = true;
    this.invalidateInteractions(task);
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
      if (events.length > 0 || task.terminal || this.openInteractions(task).length) {
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
      case "tool_requests": rows = [...this.interactions.values()].filter((r) => r.taskId === taskId && r.kind === "relay" && (!itemId || r.id === itemId || r.callId === itemId)).flatMap((r) => {
        const content = JSON.stringify({ ...publicToolRequest(r), submission: r.submission ?? null, provenance: "web_host_report_not_independently_verified" });
        const chunks: Record<string, unknown>[] = [];
        for (let i = 0; i < content.length; i += 4000) chunks.push({ request_id: r.id, character_offset: i, text: content.slice(i, i + 4000), total_characters: content.length });
        return chunks;
      }); break;
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
    const page = rows.slice(safeOffset, safeOffset + (kind === "tool_requests" ? Math.min(safeLimit, 8) : safeLimit));
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
      task.terminal = stored.terminal;
      task.state = stored.terminal ? asTaskState(stored.state) : "connection_lost";
      task.currentTurnId = stored.currentTurnId;
      task.finalText = stored.finalText;
      task.updatedAt = stored.updatedAt;
      for (const row of this.store.interactions(task.taskId)) {
        const r = row as Interaction;
        if (r.state === "sending") r.state = "uncertain";
        else if (r.state === "pending") r.state = "stale";
        this.saveInteraction(r);
      }
      if (!task.relayEnabled) task.warnings.push("This legacy thread has no bridge_web_tool registration. Start a new task to enable Web-side relay; continuing this thread does not migrate it.");
      this.persistTask(task);
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
              task.threadConnectionId = this.client.connectionId;
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
    for (const task of this.tasks.values()) this.invalidateInteractions(task);
    if (info.intentional) return;
    for (const task of this.tasks.values()) {
      if (!task.terminal) {
        task.recoveryAttempted = false;
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
    if (task.terminal || task.cancelRequested || (task.currentTurnId && params.turnId && params.turnId !== task.currentTurnId)) {
      this.client.respond(request.id, undefined, { code: -32602, message: "No matching active turn" });
      return;
    }
    if (!task.currentTurnId && typeof params.turnId === "string") task.currentTurnId = params.turnId;
    if ([...this.interactions.values()].some((r) => r.connectionId === this.client.connectionId && r.rpcId === request.id && ["pending", "sending"].includes(r.state))) return;
    const now = new Date().toISOString();
    const interaction: Interaction = { id: crypto.randomUUID(), taskId, threadId: task.threadId!, turnId: stringId(params.turnId) ?? task.currentTurnId,
      callId: stringId(params.callId), rpcId: request.id, connectionId: this.client.connectionId, kind: "approval", state: "pending", createdAt: now, updatedAt: now };
    if (request.method === "item/tool/call" && params.tool === "bridge_web_tool" && params.namespace == null) {
      try {
        if (!task.relayEnabled || this.config.relay?.enabled === false) throw new Error("Web relay is disabled for this thread; start a new task if enabling it");
        if (!params.turnId || !params.callId) throw new Error("Relay request lacks turn/call identity");
        if (canonicalJson(params.arguments).length > 20_000) throw new Error("Relay arguments exceed 20000 characters including context");
        interaction.request = redactValue(relayArguments.parse(params.arguments), this.config) as Interaction["request"];
        interaction.kind = "relay";
        this.saveInteraction(interaction);
        this.appendSyntheticEvent(task, request.method, "external_tool_request", publicToolRequest(interaction));
        this.refreshPending(task);
        this.persistTask(task);
        this.signal(task);
        return;
      } catch (error) {
        this.client.respond(request.id, { contentItems: [{ type: "inputText", text: `Invalid relay request: ${redactText(String(error), this.config).slice(0, 2000)}` }], success: false });
        this.appendSyntheticEvent(task, request.method, "warning", { message: "Relay request rejected: disabled or invalid arguments" });
        this.signal(task);
        return;
      }
    }
    interaction.detail = detail;
    this.saveInteraction(interaction);
    this.refreshPending(task);
    task.currentActivity = detail.description;
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
    if (!task) return;
    this.orphanNotifications.delete(threadId);
    for (const notification of orphan ?? []) this.processNotification(task, notification);
    for (const request of this.client.pendingServerRequests.values()) if (rec(request.params).threadId === threadId) this.handleServerRequest(request);
  }

  private replayEvent(task: RuntimeTask, stored: StoredEvent, normalized?: NormalizedEvent): void {
    let payload: Record<string, unknown> = {};
    try { payload = rec(JSON.parse(stored.normalizedJson)); } catch { /* no-op */ }
    const eventType = normalized?.eventType ?? stored.eventType;
    if (eventType === "turn_started") {
      const id = stringId(payload.turn_id);
      if (id) { task.currentTurnId = id; this.turnToTask.set(id, task.taskId); }
      if (!task.terminal) { task.state = "running"; this.refreshPending(task); }
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
        this.invalidateInteractions(task);
      } else {
        task.warnings.push("Received turn/completed without a recognized terminal status");
      }
    } else if (eventType === "dynamic_tool_completed") {
      for (const r of this.interactions.values()) if (r.taskId === task.taskId && r.callId === stored.itemId && r.connectionId === this.client.connectionId && ["sending", "submitted"].includes(r.state)) {
        r.state = "resolved";
        this.saveInteraction(r);
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
      for (const r of this.interactions.values()) if (r.taskId === task.taskId && r.rpcId === payload.request_id && r.connectionId === this.client.connectionId && !["stale", "uncertain"].includes(r.state)) {
        r.state = "resolved";
        this.saveInteraction(r);
      }
      this.refreshPending(task);
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

  private snapshot(task: RuntimeTask, cursor: string, events: StoredEvent[], nextCursor = cursor): TaskSnapshot {
    const snapshot: TaskSnapshot = {
      task_id: task.taskId, thread_id: task.threadId, turn_id: task.currentTurnId, state: task.state, terminal: task.terminal,
      cursor, next_cursor: nextCursor, started_at: task.startedAt, last_activity_at: task.lastActivityAt, current_plan: task.currentPlan,
      current_activity: task.currentActivity, codex_messages: task.messages.slice(-50), events: events.map(eventPublic),
      pending_request: task.pending ? this.publicPending(task.pending) : null, warnings: task.warnings.slice(-50), error: task.error,
      pending_requests: this.openInteractions(task).filter((r) => r.detail).map((r) => this.publicPending(r.detail!)),
      tool_requests: this.openInteractions(task).filter((r) => r.kind === "relay").map(publicToolRequest),
      relay_enabled: task.relayEnabled ?? false,
    };
    if (task.terminal && task.finalText !== null) snapshot.final_text = task.finalText;
    return snapshot;
  }

  private publicPending(detail: PendingRequestDetail): Record<string, unknown> {
    return { request_id: detail.requestId, kind: detail.kind, description: detail.description, context: detail.context, allowed_actions: detail.allowedActions, response_contract: detail.responseContract, ...(detail.autoResolutionMs === undefined ? {} : { autoResolutionMs: detail.autoResolutionMs }) };
  }

  private taskSummary(task: RuntimeTask): Record<string, unknown> {
    return { task_id: task.taskId, project_id: task.projectId, profile: task.profile, thread_id: task.threadId, turn_id: task.currentTurnId, state: task.state, terminal: task.terminal, updated_at: task.updatedAt, last_activity_at: task.lastActivityAt, pending_request: task.pending ? this.publicPending(task.pending) : null, tool_requests: this.openInteractions(task).filter((r) => r.kind === "relay").map(publicToolRequest), relay_enabled: task.relayEnabled ?? false, error: task.error };
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
        if (item.type === "dynamicToolCall") {
          item.arguments_excerpt = boundedExcerpt(JSON.stringify(item.arguments ?? null), 4000);
          item.content_excerpt = boundedExcerpt(JSON.stringify(item.contentItems ?? null), 4000);
          delete item.arguments;
          delete item.contentItems;
        }
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
      web_tool_results: [...this.interactions.values()].filter((r) => r.taskId === task.taskId && r.kind === "relay").slice(-50).map((r) => ({ request_id: r.id, turn_id: r.turnId, delivery_state: r.state, submission_excerpt: boundedExcerpt(JSON.stringify(r.submission ?? null), 2000), inspect_kind: "tool_requests", provenance: "web_host_report_not_independently_verified" })),
      authoritative_dynamic_tool_events: events.filter((e) => e.eventType === "dynamic_tool_completed").map(eventPublic),
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
