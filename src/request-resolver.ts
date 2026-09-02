import path from "node:path";
import type { JsonRpcId, JsonRpcServerRequest } from "./app-server-client.js";
import { redactValue, redactJson, type RedactionConfig } from "./redaction.js";

export interface PendingRequestDetail {
  requestId: JsonRpcId;
  taskId: string;
  method: string;
  kind: string;
  description: string;
  context: Record<string, unknown>;
  allowedActions: string[];
  responseContract: string;
  autoResolutionMs?: number | null;
  rawParams: unknown;
}

export interface ResponseContext {
  projectCwd?: string;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function within(root: string, candidate: string): boolean {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function commandIsHighRisk(command: string): boolean {
  return /(rm\s+-rf|rmdir\s+\/s|del\s+\/s|format\s+|git\s+reset\s+--hard|git\s+push\s+.*--force|force[- ]push|\.ssh|\.env|credential|private\s+key|chmod\s+777|curl[^\n|]*\|)/i.test(command);
}

function methodKind(method: string): string {
  switch (method) {
    case "item/commandExecution/requestApproval": return "command_approval";
    case "item/fileChange/requestApproval": return "file_change_approval";
    case "item/permissions/requestApproval": return "permission_request";
    case "item/tool/requestUserInput": return "user_input";
    case "mcpServer/elicitation/request": return "mcp_elicitation";
    case "item/tool/call": return "dynamic_tool_call";
    case "execCommandApproval": return "legacy_command_approval";
    case "applyPatchApproval": return "legacy_file_change_approval";
    case "account/chatgptAuthTokens/refresh": return "auth_token_request";
    case "attestation/generate": return "attestation_request";
    default: return "server_request";
  }
}

export function pendingRequestFor(taskId: string, request: JsonRpcServerRequest, redaction: RedactionConfig = {}): PendingRequestDetail {
  const params = rec(request.params);
  const kind = methodKind(request.method);
  const command = typeof params.command === "string" ? params.command : Array.isArray(params.command) ? params.command.join(" ") : "";
  const highRisk = commandIsHighRisk(command);
  const common = {
    request_id: request.id,
    method: request.method,
    thread_id: typeof params.threadId === "string" ? params.threadId : typeof params.conversationId === "string" ? params.conversationId : null,
    turn_id: params.turnId ?? null,
    item_id: params.itemId ?? params.callId ?? null,
  };
  if (kind.includes("auth_token") || kind.includes("attestation")) {
    return { requestId: request.id, taskId, method: request.method, kind, description: "Codex requested a credential-like response; only decline is exposed by this supervisor.", context: common, allowedActions: ["decline"], responseContract: "Decline only; credentials are never accepted or returned.", rawParams: redactValue(request.params, redaction) };
  }
  if (kind.includes("command_approval")) {
    const allowed = highRisk ? ["decline", "cancel"] : ["accept", "acceptForSession", "decline", "cancel"];
    return {
      requestId: request.id, taskId, method: request.method, kind,
      description: highRisk ? "Codex requests approval for a potentially destructive or credential-related command; decline unless the original user request explicitly authorized it." : "Codex requests approval to execute a command in the configured project.",
      context: { ...common, command: command.slice(0, 2_000), cwd: params.cwd ?? null, high_risk: highRisk, reason: params.reason ?? null },
      allowedActions: allowed, responseContract: "For the v2 endpoint send {decision: accept|acceptForSession|decline|cancel}; legacy endpoints use the mapped ReviewDecision.", rawParams: redactValue(request.params, redaction),
    };
  }
  if (kind.includes("file_change_approval")) {
    const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : null;
    return {
      requestId: request.id, taskId, method: request.method, kind,
      description: "Codex requests permission to apply a file change. Review paths and the diff before accepting.",
      context: { ...common, grant_root: grantRoot, reason: params.reason ?? null, file_changes: params.fileChanges ?? null },
      allowedActions: ["accept", "acceptForSession", "decline", "cancel"], responseContract: "For the v2 endpoint send {decision: accept|acceptForSession|decline|cancel}; legacy endpoints use ReviewDecision.", rawParams: redactValue(request.params, redaction),
    };
  }
  if (kind === "permission_request") {
    return {
      requestId: request.id, taskId, method: request.method, kind,
      description: "Codex requests additional filesystem or network permissions. Grant only the minimum required scope.",
      context: { ...common, cwd: params.cwd ?? null, reason: params.reason ?? null, permissions: params.permissions ?? null },
      allowedActions: ["accept", "decline"], responseContract: "Accept requires payload {permissions, scope:'turn'|'session'}; decline sends an empty turn-scoped profile.", rawParams: redactValue(request.params, redaction),
    };
  }
  if (kind === "user_input") {
    const questions = Array.isArray(params.questions) ? params.questions.map((question) => {
      const q = rec(question);
      return { id: q.id, header: q.header, question: q.isSecret ? "[secret input requested]" : q.question, isOther: Boolean(q.isOther), isSecret: Boolean(q.isSecret), options: q.options ?? null };
    }).slice(0, 50) : [];
    return { requestId: request.id, taskId, method: request.method, kind, description: "Codex is asking the user a blocking question.", context: { ...common, questions }, allowedActions: ["answer", "decline"], responseContract: "Answer requires payload {answers:{questionId:{answers:string[]}}}; do not put secrets in this channel.", autoResolutionMs: typeof params.autoResolutionMs === "number" ? params.autoResolutionMs : null, rawParams: redactValue(request.params, redaction) };
  }
  if (kind === "mcp_elicitation") {
    return { requestId: request.id, taskId, method: request.method, kind, description: "An MCP server is asking for user input (elicitation). Review the server, message and requested schema.", context: { ...common, server: params.serverName ?? null, mode: params.mode ?? null, message: params.message ?? null, url: params.url ?? null, requestedSchema: params.requestedSchema ?? null }, allowedActions: ["accept", "decline", "cancel"], responseContract: "Send {action:'accept'|'decline'|'cancel', content: object|null, _meta: object|null}.", rawParams: redactValue(request.params, redaction) };
  }
  if (kind === "dynamic_tool_call") {
    return { requestId: request.id, taskId, method: request.method, kind, description: "Codex requested a dynamic tool call. This supervisor does not execute arbitrary dynamic tools; decline unless an explicit safe integration is added.", context: { ...common, tool: params.tool ?? null, namespace: params.namespace ?? null, arguments: params.arguments ?? null }, allowedActions: ["decline"], responseContract: "Decline with a failed empty contentItems response.", rawParams: redactValue(request.params, redaction) };
  }
  return { requestId: request.id, taskId, method: request.method, kind, description: "Codex requested an interaction not recognized by this supervisor; decline by default.", context: common, allowedActions: ["decline"], responseContract: "Decline only.", rawParams: redactValue(request.params, redaction) };
}

function reviewDecision(action: string, legacy: boolean): unknown {
  if (!legacy) return { decision: action };
  if (action === "accept") return { decision: "approved" };
  if (action === "acceptForSession") return { decision: "approved_for_session" };
  if (action === "cancel") return { decision: "abort" };
  return { decision: { denied: { rejection: "Declined by supervisor" } } };
}

function validateAnswers(payload: unknown): { answers: Record<string, { answers: string[] }> } {
  const root = rec(payload);
  const raw = rec(root.answers);
  const answers: Record<string, { answers: string[] }> = {};
  for (const [id, value] of Object.entries(raw)) {
    const row = rec(value);
    if (!Array.isArray(row.answers) || row.answers.some((item) => typeof item !== "string" || item.length > 10_000)) throw new Error("Each answer must contain a bounded answers:string[] value");
    answers[id.slice(0, 128)] = { answers: row.answers.slice(0, 20) };
  }
  return { answers };
}

function validatePermissionPayload(payload: unknown, context: ResponseContext): { permissions: Record<string, unknown>; scope: "turn" | "session"; strictAutoReview?: boolean } {
  const root = rec(payload);
  const permissions = rec(root.permissions);
  const fsPerm = rec(permissions.fileSystem ?? permissions.filesystem);
  const paths = [...(Array.isArray(fsPerm.read) ? fsPerm.read : []), ...(Array.isArray(fsPerm.write) ? fsPerm.write : [])].filter((item): item is string => typeof item === "string");
  if (context.projectCwd && paths.some((candidate) => !within(context.projectCwd!, candidate))) throw new Error("Permission request path is outside the registered project allowlist");
  const scope = root.scope === "session" ? "session" : root.scope === "turn" ? "turn" : undefined;
  if (!scope) throw new Error("Permission payload requires scope 'turn' or 'session'");
  return { permissions: permissions as Record<string, unknown>, scope, ...(typeof root.strictAutoReview === "boolean" ? { strictAutoReview: root.strictAutoReview } : {}) };
}

export function responseForPending(detail: PendingRequestDetail, action: string, payload: unknown, context: ResponseContext = {}): unknown {
  if (!detail.allowedActions.includes(action)) throw new Error(`Action '${action}' is not allowed for ${detail.kind}`);
  const params = rec(detail.rawParams);
  if ((detail.kind === "command_approval" || detail.kind === "legacy_command_approval") && (action === "accept" || action === "acceptForSession")) {
    const command = typeof params.command === "string" ? params.command : Array.isArray(params.command) ? params.command.join(" ") : "";
    if (commandIsHighRisk(command)) throw new Error("Potentially destructive command cannot be accepted automatically; decline or obtain explicit authorization");
  }
  if ((detail.kind === "file_change_approval" || detail.kind === "legacy_file_change_approval") && (action === "accept" || action === "acceptForSession")) {
    const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : undefined;
    if (grantRoot && context.projectCwd && !within(context.projectCwd, grantRoot)) throw new Error("File approval grantRoot is outside the registered project allowlist");
  }
  if (detail.kind === "user_input") {
    if (action === "decline") return { answers: {} };
    return validateAnswers(payload);
  }
  if (detail.kind === "permission_request") {
    if (action === "decline") return { permissions: {}, scope: "turn" };
    return validatePermissionPayload(payload, context);
  }
  if (detail.kind === "mcp_elicitation") {
    if (action === "decline" || action === "cancel") return { action, content: null, _meta: null };
    const root = rec(payload);
    return { action: "accept", content: root.content ?? null, _meta: root._meta ?? null };
  }
  if (detail.kind === "dynamic_tool_call") return { contentItems: [], success: false };
  if (detail.kind === "auth_token_request" || detail.kind === "attestation_request") throw new Error("Credential-like app-server requests can only be declined");
  if (detail.kind === "command_approval" || detail.kind === "file_change_approval") return reviewDecision(action, false);
  if (detail.kind === "legacy_command_approval" || detail.kind === "legacy_file_change_approval") return reviewDecision(action, true);
  return reviewDecision("decline", false);
}

export function pendingRequestJson(detail: PendingRequestDetail, redaction: RedactionConfig = {}): string {
  return redactJson({ request_id: detail.requestId, method: detail.method, kind: detail.kind, description: detail.description, context: detail.context, allowed_actions: detail.allowedActions, response_contract: detail.responseContract, autoResolutionMs: detail.autoResolutionMs ?? null, raw_params: detail.rawParams }, redaction);
}
