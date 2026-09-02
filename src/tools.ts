import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TaskManager } from "./task-manager.js";

export const SUPERVISOR_INSTRUCTIONS = `You supervise a local Codex agent on behalf of the user.

The Codex agent performs the actual project work. Your role is to compose
high-quality instructions, start or continue Codex turns, observe progress,
resolve safe requests, steer the agent when necessary, and verify delivery.

NON-NEGOTIABLE WAIT RULE:

After codex_start or codex_send begins work, you must not finish the current
assistant response while the task has terminal: false.

Call codex_wait repeatedly in the same assistant response until the task
reports terminal: true.

A wait timeout, an empty event batch, lack of recent activity, a commentary
message, a completed command, a completed plan, or text saying that work is
done does not mean the task is complete.

Only an authoritative app-server turn/completed event makes the current turn terminal.

When codex_wait returns a pending approval or input request, resolve it with
codex_respond, or decline unsafe actions and steer Codex toward a safe
alternative. Then continue calling codex_wait.

Do not tell the user to come back later, check the result later, wait for a
background task, or manually monitor Codex merely because the work is taking
a long time.

Once terminal: true, call codex_result, inspect its objective evidence, and
only then provide the user-facing answer.

Do not claim success solely from the Codex agent's self-report.

If the ChatGPT host forcibly interrupts the tool workflow, never represent
the unfinished task as complete. Preserve and return the task identifier so
the same task can be resumed.`;

const WAIT_RULE = `\n\nNON-NEGOTIABLE WAIT RULE: after this tool begins or continues work, if the returned task has terminal: false, continue calling codex_wait in the same assistant response until an authoritative app-server turn/completed event reports terminal: true. Timeouts, empty events, commentary, completed commands or plans, and Codex saying it is done are not completion. Resolve pending requests with codex_respond, steer with codex_send when needed, then call codex_result only after terminal: true.`;

function jsonResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const taskId = z.string().min(1).max(128);
const annotation = {
  health: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  start: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  wait: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  send: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  respond: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  result: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cancel: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
} as const;

export function createMcpServer(manager: TaskManager): McpServer {
  const server = new McpServer({ name: "codex-bridge", version: "0.1.0" }, { instructions: SUPERVISOR_INSTRUCTIONS });
  server.registerTool("codex_health", {
    title: "Codex health",
    description: "Read-only health and capability check for the local Codex supervisor, app-server, SQLite, configured projects and local profiles.",
    inputSchema: {},
    annotations: annotation.health,
  }, async () => jsonResult(await manager.health()));

  server.registerTool("codex_start", {
    title: "Start Codex task",
    description: `Start one Codex thread and turn using a project_id and a locally mapped profile. The prompt is sent as ordinary natural-language text; this tool does not request JSON, a fixed table, or an output schema. It may cause file changes, commands, MCP calls or network activity through Codex, and returns immediately with terminal: false. ${WAIT_RULE}`,
    inputSchema: {
      project_id: z.string().min(1).max(128),
      prompt: z.string().min(1).max(100_000),
      profile: z.string().min(1).max(128).optional(),
    },
    annotations: annotation.start,
  }, async ({ project_id, prompt, profile }) => jsonResult(await manager.startTask(project_id, prompt, profile)));

  server.registerTool("codex_wait", {
    title: "Wait for Codex progress",
    description: `Long-poll a Codex task and return real events, natural-language Codex messages, plans, activity, approvals, warnings and terminal state. Never infer completion from silence, timeout, commentary, a completed command or plan, or a self-report; only turn/completed is authoritative. ${WAIT_RULE}`,
    inputSchema: {
      task_id: taskId,
      cursor: z.string().regex(/^\d+$/).optional(),
      timeout_seconds: z.number().int().min(1).max(300).optional(),
    },
    annotations: annotation.wait,
  }, async ({ task_id, cursor, timeout_seconds }) => jsonResult(await manager.wait(task_id, cursor, timeout_seconds)));

  server.registerTool("codex_status", {
    title: "Codex status",
    description: "Read current task or supervisor status without waiting. Use this to recover task identifiers after a reconnect; it never implies completion.",
    inputSchema: { task_id: taskId.optional() },
    annotations: annotation.status,
  }, async ({ task_id }) => jsonResult(manager.status(task_id)));

  server.registerTool("codex_send", {
    title: "Send or steer Codex",
    description: `Send a natural-language correction or continuation. An active turn receives turn/steer; a terminal turn starts a new turn on the same thread. This can cause project changes, commands, MCP calls or network activity. It returns terminal: false; after calling it, keep waiting for authoritative turn/completed and then inspect codex_result. ${WAIT_RULE}`,
    inputSchema: { task_id: taskId, message: z.string().min(1).max(100_000) },
    annotations: annotation.send,
  }, async ({ task_id, message }) => jsonResult(await manager.send(task_id, message)));

  server.registerTool("codex_respond", {
    title: "Respond to Codex request",
    description: "Resolve a pending command approval, file-change approval, permission request, requestUserInput, MCP elicitation, or supported server request. Payloads are validated against the actual app-server request; unsafe or credential-like requests are not auto-accepted. Continue codex_wait after responding.",
    inputSchema: { task_id: taskId, request_id: z.union([z.string().min(1).max(128), z.number().int()]), action: z.string().min(1).max(64), payload: z.object({}).passthrough().optional() },
    annotations: annotation.respond,
  }, async ({ task_id, request_id, action, payload }) => jsonResult(await manager.respond(task_id, request_id, action, payload)));

  server.registerTool("codex_result", {
    title: "Get verified Codex result",
    description: `Return the final natural-language Codex delivery together with Supervisor-collected objective evidence. If terminal is false this tool refuses to fabricate a result; continue codex_wait. Only an authoritative app-server turn/completed event permits delivery. ${WAIT_RULE}`,
    inputSchema: { task_id: taskId },
    annotations: annotation.result,
  }, async ({ task_id }) => jsonResult(await manager.result(task_id)));

  server.registerTool("codex_inspect", {
    title: "Inspect Codex evidence",
    description: "Read-only paginated inspection of transcript, plan, diff, commands, bounded command output, file changes, MCP calls, warnings or redacted raw events. Hidden chain-of-thought and credentials are never returned.",
    inputSchema: {
      task_id: taskId,
      kind: z.enum(["transcript", "plan", "diff", "commands", "command_output", "file_changes", "mcp_calls", "warnings", "raw_event"]),
      item_id: z.string().max(128).optional(),
      offset: z.number().int().min(0).max(1_000_000).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: annotation.inspect,
  }, async ({ task_id, kind, item_id, offset, limit }) => jsonResult(manager.inspect(task_id, kind, item_id, offset, limit)));

  server.registerTool("codex_cancel", {
    title: "Cancel Codex turn",
    description: "Interrupt the active Codex turn and wait for the authoritative turn/completed status. A request to interrupt is not itself completion; the returned state reflects only observed app-server status.",
    inputSchema: { task_id: taskId, reason: z.string().max(4_000).optional() },
    annotations: annotation.cancel,
  }, async ({ task_id, reason }) => jsonResult(await manager.cancel(task_id, reason)));
  return server;
}
