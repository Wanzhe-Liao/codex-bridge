import { boundedExcerpt, redactText, redactValue, type RedactionConfig } from "./redaction.js";

export interface NormalizedEvent {
  method: string;
  eventType: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  payload: Record<string, unknown>;
  meaningful: boolean;
  authoritative: boolean;
  finalText?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max = 4_000): string {
  return boundedExcerpt(redactText(typeof value === "string" ? value : String(value ?? "")), max).text;
}

function ids(params: Record<string, unknown>): { threadId: string | null; turnId: string | null; itemId: string | null } {
  const item = record(params.item);
  const turn = record(params.turn);
  return {
    threadId: typeof params.threadId === "string" ? params.threadId : (typeof record(params.thread).id === "string" ? String(record(params.thread).id) : null),
    turnId: typeof params.turnId === "string" ? params.turnId : (typeof turn.id === "string" ? String(turn.id) : null),
    itemId: typeof params.itemId === "string" ? params.itemId : (typeof item.id === "string" ? String(item.id) : null),
  };
}

function itemPayload(item: Record<string, unknown>, config: RedactionConfig): Record<string, unknown> {
  const itemType = typeof item.type === "string" ? item.type : "unknown";
  if (itemType === "agentMessage") {
    return { type: itemType, id: item.id, text: text(item.text), phase: item.phase ?? null };
  }
  if (itemType === "commandExecution") {
    const output = boundedExcerpt(typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "", 4_000);
    return {
      type: itemType, id: item.id, command: text(item.command, 2_000), cwd: text(item.cwd, 1_000), status: item.status,
      exit_code: typeof item.exitCode === "number" ? item.exitCode : null, duration_ms: item.durationMs ?? null,
      bounded_output_excerpt: output.text, output_truncated: output.truncated,
    };
  }
  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes.map((change) => {
      const c = record(change);
      const diff = boundedExcerpt(typeof c.diff === "string" ? c.diff : "", 800);
      return { path: text(c.path, 1_000), kind: c.kind ?? null, status: item.status, diff_summary: diff.text, diff_truncated: diff.truncated };
    }) : [];
    return { type: itemType, id: item.id, status: item.status, changes };
  }
  if (itemType === "mcpToolCall") {
    return { type: itemType, id: item.id, server: text(item.server, 500), tool: text(item.tool, 500), status: item.status, error: item.error ? text(record(item.error).message, 1_000) : null, duration_ms: item.durationMs ?? null };
  }
  if (itemType === "reasoning") {
    return { type: itemType, id: item.id, summary: Array.isArray(item.summary) ? item.summary.map((part) => text(part, 1_000)).slice(0, 20) : [] };
  }
  if (itemType === "plan") return { type: itemType, id: item.id, text: text(item.text) };
  return record(redactValue({ type: itemType, id: item.id, status: item.status }, config));
}

export function normalizeNotification(method: string, rawParams: unknown, config: RedactionConfig = {}): NormalizedEvent | null {
  const params = record(rawParams);
  const { threadId, turnId, itemId } = ids(params);
  if (method === "turn/started") {
    const turn = record(params.turn);
    return { method, eventType: "turn_started", threadId, turnId: turnId ?? null, itemId: null, payload: { turn_id: turn.id, status: turn.status ?? "inProgress", started_at: turn.startedAt ?? null }, meaningful: true, authoritative: false };
  }
  if (method === "turn/completed") {
    const turn = record(params.turn);
    const status = turn.status;
    const error = record(turn.error);
    return {
      method, eventType: "turn_completed", threadId, turnId, itemId: null,
      payload: { turn_id: turn.id, status, error: turn.error ? { message: text(error.message, 2_000), details: text(error.additionalDetails, 2_000) } : null, completed_at: turn.completedAt ?? null, duration_ms: turn.durationMs ?? null },
      meaningful: true, authoritative: true,
    };
  }
  if (method === "turn/plan/updated") {
    const plan = Array.isArray(params.plan) ? params.plan.map((step) => { const s = record(step); return { step: text(s.step, 2_000), status: s.status }; }).slice(0, 100) : [];
    return { method, eventType: "plan_updated", threadId, turnId, itemId: null, payload: { explanation: text(params.explanation, 2_000), plan }, meaningful: true, authoritative: true };
  }
  if (method === "turn/diff/updated") {
    const diff = boundedExcerpt(typeof params.diff === "string" ? params.diff : "", 20_000);
    return { method, eventType: "diff_updated", threadId, turnId, itemId: null, payload: { diff: diff.text, truncated: diff.truncated }, meaningful: true, authoritative: true };
  }
  if (method === "item/started") {
    const item = record(params.item);
    const itemType = String(item.type ?? "item");
    const eventType = itemType === "commandExecution" ? "command_started" : itemType === "fileChange" ? "file_change_started" : itemType === "mcpToolCall" ? "mcp_tool_started" : "item_started";
    return { method, eventType, threadId, turnId, itemId, payload: itemPayload(item, config), meaningful: true, authoritative: false };
  }
  if (method === "item/completed") {
    const item = record(params.item);
    const payload = itemPayload(item, config);
    const finalText = item.type === "agentMessage" && typeof item.text === "string" ? redactText(item.text, config) : undefined;
    const itemType = String(item.type ?? "item");
    const eventType = itemType === "commandExecution" ? "command_completed" : itemType === "fileChange" ? "file_change_completed" : itemType === "mcpToolCall" ? "mcp_tool_completed" : itemType === "agentMessage" ? "agent_message" : itemType === "reasoning" ? "reasoning_summary" : "item_completed";
    return { method, eventType, threadId, turnId, itemId, payload, meaningful: true, authoritative: true, ...(finalText === undefined ? {} : { finalText }) };
  }
  if (method === "item/agentMessage/delta") {
    return { method, eventType: "agent_message", threadId, turnId, itemId, payload: { text: text(params.delta, 4_000) }, meaningful: true, authoritative: false };
  }
  if (method === "item/plan/delta") {
    return { method, eventType: "plan_delta", threadId, turnId, itemId, payload: { delta: text(params.delta, 4_000) }, meaningful: true, authoritative: false };
  }
  if (method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta" || method === "process/outputDelta") {
    return { method, eventType: "command_output", threadId, turnId, itemId, payload: { delta: text(params.delta, 2_000) }, meaningful: true, authoritative: false };
  }
  if (method === "thread/diff/updated") return null;
  if (method === "thread/status/changed") {
    return { method, eventType: "thread_status_changed", threadId, turnId, itemId: null, payload: { status: redactValue(params.status, config) as unknown }, meaningful: true, authoritative: false };
  }
  if (method === "thread/started") {
    return { method, eventType: "thread_started", threadId, turnId: null, itemId: null, payload: { thread: redactValue(params.thread, config) as unknown }, meaningful: true, authoritative: true };
  }
  if (method === "serverRequest/resolved") {
    return { method, eventType: "server_request_resolved", threadId, turnId, itemId, payload: { request_id: redactValue(params.requestId, config) as unknown }, meaningful: true, authoritative: true };
  }
  if (method === "warning" || method === "configWarning" || method === "guardianWarning" || method === "error" || method === "deprecationNotice") {
    const message = record(params).message ?? params;
    return { method, eventType: method === "error" ? "error" : "warning", threadId, turnId, itemId, payload: { message: text(typeof message === "string" ? message : JSON.stringify(redactValue(message, config)), 4_000) }, meaningful: true, authoritative: false };
  }
  if (method === "item/fileChange/outputDelta" || method === "item/fileChange/patchUpdated") {
    return { method, eventType: "file_change_progress", threadId, turnId, itemId, payload: { delta: text(params.delta ?? params.patch, 2_000) }, meaningful: true, authoritative: false };
  }
  if (method === "item/mcpToolCall/progress") {
    return { method, eventType: "mcp_tool_progress", threadId, turnId, itemId, payload: record(redactValue(params, config)), meaningful: true, authoritative: false };
  }
  if (method === "mcpServer/startupStatus/updated" || method === "mcpServer/event/stream/notification") {
    return { method, eventType: "mcp_tool_progress", threadId, turnId, itemId, payload: record(redactValue(params, config)), meaningful: true, authoritative: false };
  }
  return null;
}
