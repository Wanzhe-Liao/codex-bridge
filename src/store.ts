import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { SupervisorConfig } from "./config.js";

export interface StoredTask {
  taskId: string;
  projectId: string;
  profile: string;
  threadId: string | null;
  sessionId: string | null;
  currentTurnId: string | null;
  state: string;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  finalText: string | null;
  error: string | null;
}

export interface StoredEvent {
  taskId: string;
  sequence: number;
  method: string;
  itemId: string | null;
  eventType: string;
  normalizedJson: string;
  rawJsonRedacted: string;
  createdAt: string;
}

export interface StoredPendingRequest {
  taskId: string;
  requestId: string;
  kind: string;
  requestJsonRedacted: string;
  resolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

function statePath(): string {
  if (process.env.CODEX_SUPERVISOR_STATE) return path.resolve(process.env.CODEX_SUPERVISOR_STATE);
  return path.join(os.homedir(), ".local", "share", "codex-supervisor-mcp", "state.sqlite3");
}

export class StateStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(filePath?: string) {
    let selectedPath = filePath === ":memory:" ? ":memory:" : (filePath ? path.resolve(filePath) : statePath());
    if (selectedPath !== ":memory:") {
      try {
        fs.mkdirSync(path.dirname(selectedPath), { recursive: true, mode: 0o700 });
      } catch (error) {
        // Sandboxed desktop hosts may deny creating ~/.local. Keep the same
        // single SQLite store in an ignored project-local directory as a safe
        // fallback; an explicitly supplied path still fails loudly.
        if (filePath || process.env.CODEX_SUPERVISOR_STATE) throw error;
        selectedPath = path.join(process.cwd(), ".supervisor", "state.sqlite3");
        fs.mkdirSync(path.dirname(selectedPath), { recursive: true, mode: 0o700 });
      }
    }
    this.path = selectedPath;
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        thread_id TEXT,
        session_id TEXT,
        current_turn_id TEXT,
        state TEXT NOT NULL,
        terminal INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        last_activity_at TEXT,
        final_text TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        method TEXT NOT NULL,
        item_id TEXT,
        event_type TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        raw_json_redacted TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS events_task_created_idx ON events(task_id, created_at);
      CREATE TABLE IF NOT EXISTS pending_requests (
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        request_json_redacted TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        PRIMARY KEY (task_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS pending_task_open_idx ON pending_requests(task_id, resolved);
    `);
    if (this.path !== ":memory:") {
      try { fs.chmodSync(this.path, 0o600); } catch { /* Windows ACLs are managed by the user. */ }
    }
  }

  close(): void { this.db.close(); }

  writable(): boolean {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  createTask(task: StoredTask): void {
    this.db.prepare(`
      INSERT INTO tasks (task_id, project_id, profile, thread_id, session_id, current_turn_id, state, terminal,
        created_at, updated_at, started_at, last_activity_at, final_text, error)
      VALUES (@taskId, @projectId, @profile, @threadId, @sessionId, @currentTurnId, @state, @terminal,
        @createdAt, @updatedAt, @startedAt, @lastActivityAt, @finalText, @error)
    `).run({ ...task, terminal: task.terminal ? 1 : 0 });
  }

  updateTask(taskId: string, patch: Partial<Omit<StoredTask, "taskId">>): void {
    const fields = Object.entries(patch);
    if (fields.length === 0) return;
    const mapping: Record<string, string> = {
      projectId: "project_id", profile: "profile", threadId: "thread_id", sessionId: "session_id",
      currentTurnId: "current_turn_id", state: "state", terminal: "terminal", createdAt: "created_at",
      updatedAt: "updated_at", startedAt: "started_at", lastActivityAt: "last_activity_at", finalText: "final_text", error: "error",
    };
    const assignments: string[] = [];
    const values: Record<string, unknown> = { taskId };
    for (const [key, value] of fields) {
      const column = mapping[key];
      if (!column) continue;
      assignments.push(`${column} = @${key}`);
      values[key] = key === "terminal" ? (value ? 1 : 0) : value;
    }
    if (assignments.length) this.db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE task_id = @taskId`).run(values);
  }

  getTask(taskId: string): StoredTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapTask(row) : undefined;
  }

  listTasks(limit = 50): StoredTask[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map((row) => this.mapTask(row));
  }

  appendEvent(event: Omit<StoredEvent, "sequence" | "createdAt"> & { sequence?: number; createdAt?: string }): StoredEvent {
    const createdAt = event.createdAt ?? new Date().toISOString();
    const sequence = event.sequence ?? ((this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM events WHERE task_id = ?").get(event.taskId) as { n: number }).n + 1);
    this.db.prepare(`
      INSERT INTO events (task_id, sequence, method, item_id, event_type, normalized_json, raw_json_redacted, created_at)
      VALUES (@taskId, @sequence, @method, @itemId, @eventType, @normalizedJson, @rawJsonRedacted, @createdAt)
    `).run({ ...event, sequence, createdAt });
    return { ...event, sequence, createdAt };
  }

  eventsAfter(taskId: string, cursor = 0, limit = 100): StoredEvent[] {
    const rows = this.db.prepare(`
      SELECT task_id, sequence, method, item_id, event_type, normalized_json, raw_json_redacted, created_at
      FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(taskId, Math.max(0, cursor), Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map((row) => this.mapEvent(row));
  }

  recentEvents(taskId: string, limit = 5_000): StoredEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT task_id, sequence, method, item_id, event_type, normalized_json, raw_json_redacted, created_at
        FROM events WHERE task_id = ? ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence ASC
    `).all(taskId, Math.max(1, Math.min(10_000, limit))) as Record<string, unknown>[];
    return rows.map((row) => this.mapEvent(row));
  }

  latestSequence(taskId: string): number {
    return Number((this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM events WHERE task_id = ?").get(taskId) as { n: number }).n);
  }

  savePendingRequest(request: StoredPendingRequest): void {
    this.db.prepare(`
      INSERT INTO pending_requests (task_id, request_id, kind, request_json_redacted, resolved, created_at, resolved_at)
      VALUES (@taskId, @requestId, @kind, @requestJsonRedacted, @resolved, @createdAt, @resolvedAt)
      ON CONFLICT(task_id, request_id) DO UPDATE SET kind=excluded.kind, request_json_redacted=excluded.request_json_redacted,
        resolved=excluded.resolved, resolved_at=excluded.resolved_at
    `).run({ ...request, resolved: request.resolved ? 1 : 0 });
  }

  resolvePendingRequest(taskId: string, requestId: string): void {
    this.db.prepare("UPDATE pending_requests SET resolved = 1, resolved_at = ? WHERE task_id = ? AND request_id = ?").run(new Date().toISOString(), taskId, requestId);
  }

  getPendingRequest(taskId: string, requestId?: string): StoredPendingRequest | undefined {
    const row = requestId
      ? this.db.prepare("SELECT * FROM pending_requests WHERE task_id = ? AND request_id = ? AND resolved = 0").get(taskId, requestId)
      : this.db.prepare("SELECT * FROM pending_requests WHERE task_id = ? AND resolved = 0 ORDER BY created_at ASC LIMIT 1").get(taskId);
    return row ? this.mapPending(row as Record<string, unknown>) : undefined;
  }

  hasPendingRequest(taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM pending_requests WHERE task_id = ? AND resolved = 0 LIMIT 1").get(taskId));
  }

  private mapTask(row: Record<string, unknown>): StoredTask {
    return {
      taskId: String(row.task_id), projectId: String(row.project_id), profile: String(row.profile),
      threadId: row.thread_id == null ? null : String(row.thread_id), sessionId: row.session_id == null ? null : String(row.session_id),
      currentTurnId: row.current_turn_id == null ? null : String(row.current_turn_id), state: String(row.state), terminal: Boolean(row.terminal),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), startedAt: row.started_at == null ? null : String(row.started_at),
      lastActivityAt: row.last_activity_at == null ? null : String(row.last_activity_at), finalText: row.final_text == null ? null : String(row.final_text),
      error: row.error == null ? null : String(row.error),
    };
  }

  private mapPending(row: Record<string, unknown>): StoredPendingRequest {
    return {
      taskId: String(row.task_id), requestId: String(row.request_id), kind: String(row.kind), requestJsonRedacted: String(row.request_json_redacted),
      resolved: Boolean(row.resolved), createdAt: String(row.created_at), resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    };
  }

  private mapEvent(row: Record<string, unknown>): StoredEvent {
    return {
      taskId: String(row.task_id), sequence: Number(row.sequence), method: String(row.method), itemId: row.item_id ? String(row.item_id) : null,
      eventType: String(row.event_type), normalizedJson: String(row.normalized_json), rawJsonRedacted: String(row.raw_json_redacted), createdAt: String(row.created_at),
    };
  }
}

export function defaultStatePath(): string { return statePath(); }
