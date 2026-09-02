import { EventEmitter } from "node:events";
import type { AppServerProcessLike } from "./app-server-process.js";
import { spawnAppServer } from "./app-server-process.js";

export type JsonRpcId = string | number;
export interface JsonRpcErrorShape { code: number; message: string; data?: unknown }
export interface JsonRpcResponse { jsonrpc?: "2.0"; id: JsonRpcId; result?: unknown; error?: JsonRpcErrorShape }
export interface JsonRpcNotification { jsonrpc?: "2.0"; method: string; params?: unknown }
export interface JsonRpcServerRequest { jsonrpc?: "2.0"; id: JsonRpcId; method: string; params?: unknown }

export interface AppServerClientOptions {
  processFactory?: () => AppServerProcessLike;
  version?: string;
  requestTimeoutMs?: number;
  logger?: (message: string) => void;
}

interface PendingOutbound {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const INITIALIZE_CAPABILITIES = {
  experimentalApi: true,
  requestAttestation: false,
  mcpServerOpenaiFormElicitation: true,
};

/**
 * A single-reader JSONL JSON-RPC client for the Codex app-server.
 * No caller reads stdout directly; every message is dispatched here.
 */
export class AppServerClient extends EventEmitter {
  private readonly processFactory: () => AppServerProcessLike;
  private readonly version: string;
  private readonly requestTimeoutMs: number;
  private readonly logger: (message: string) => void;
  private process?: AppServerProcessLike;
  private lineBuffer = "";
  private nextRequestId = 1;
  private readonly pendingOutbound = new Map<string, PendingOutbound>();
  private readonly pendingAppServerRequests = new Map<string, JsonRpcServerRequest>();
  private initialized = false;
  private startPromise?: Promise<void>;
  private readonly intentionalStops = new WeakSet<AppServerProcessLike>();
  private connectedAt?: string;

  constructor(options: AppServerClientOptions = {}) {
    super();
    this.processFactory = options.processFactory ?? (() => spawnAppServer());
    this.version = options.version ?? "0.1.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.logger = options.logger ?? ((message) => process.stderr.write(`[app-server] ${message}\n`));
  }

  get isInitialized(): boolean { return this.initialized; }
  get isRunning(): boolean { return Boolean(this.process); }
  get connectionTime(): string | undefined { return this.connectedAt; }
  get pendingServerRequests(): ReadonlyMap<string, JsonRpcServerRequest> { return this.pendingAppServerRequests; }

  async start(): Promise<void> {
    if (this.initialized && this.process) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const child = this.processFactory();
    this.process = child;
    this.lineBuffer = "";
    child.stdout.on("data", (chunk: Buffer | string) => this.consumeStdout(chunk.toString()));
    child.stdout.on("error", (error: Error) => this.emit("protocolError", error));
    child.once("error", (error: Error) => {
      if (this.process !== child) return;
      this.logger(`process error: ${error.message}`);
      this.emit("processError", error);
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => this.handleExit(child, code, signal));
    const result = await this.requestInternal("initialize", {
      clientInfo: {
        name: "chatgpt_web_codex_supervisor",
        title: "ChatGPT Web Codex Supervisor",
        version: this.version,
      },
      capabilities: INITIALIZE_CAPABILITIES,
    }, true);
    this.initialized = true;
    this.connectedAt = new Date().toISOString();
    this.write({ jsonrpc: "2.0", method: "initialized" });
    this.emit("initialized", result);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.initialized = false;
    this.connectedAt = undefined;
    this.process = undefined;
    for (const [id, pending] of this.pendingOutbound) {
      clearTimeout(pending.timer);
      pending.reject(new Error("app-server stopped"));
      this.pendingOutbound.delete(id);
    }
    if (child) {
      this.intentionalStops.add(child);
      try { child.kill(); } catch { /* already exited */ }
    }
  }

  async request(method: string, params?: unknown): Promise<any> {
    if (!this.initialized || !this.process) throw new Error("app-server is not initialized");
    return this.requestInternal(method, params, false);
  }

  notify(method: string, params?: unknown): void {
    if (!this.initialized || !this.process) throw new Error("app-server is not initialized");
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Send a response to a server-initiated request using its original JSON-RPC id. */
  respond(id: JsonRpcId, result?: unknown, error?: JsonRpcErrorShape): void {
    if (!this.process) throw new Error("app-server is not running");
    const key = String(id);
    this.pendingAppServerRequests.delete(key);
    this.write({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
    this.emit("serverRequestResponded", id, result, error);
  }

  private requestInternal(method: string, params: unknown, isInitialize: boolean): Promise<any> {
    if (!isInitialize && (!this.process || (!this.initialized && method !== "initialize"))) {
      return Promise.reject(new Error("app-server initialize must complete before other requests"));
    }
    const id = this.nextRequestId++;
    const key = String(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOutbound.delete(key);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pendingOutbound.set(key, { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingOutbound.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.process) throw new Error("app-server process is not running");
    const line = `${JSON.stringify(message)}\n`;
    this.process.stdin.write(line, "utf8");
    this.emit("outbound", message);
  }

  private consumeStdout(chunk: string): void {
    this.lineBuffer += chunk;
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.trim()) this.dispatchLine(line);
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      const error = new Error("Invalid JSONL received from app-server");
      this.logger(`${error.message}: ${line.slice(0, 200)}`);
      this.emit("protocolError", error, line);
      return;
    }
    if (!message || typeof message !== "object") {
      this.emit("protocolError", new Error("Invalid JSON-RPC message"), message);
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id") && message.id !== null;
    const hasMethod = typeof message.method === "string";
    if (hasId && !hasMethod && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      const key = String(message.id);
      const pending = this.pendingOutbound.get(key);
      if (!pending) {
        this.emit("protocolError", new Error(`Response for unknown request id ${key}`), message);
        return;
      }
      this.pendingOutbound.delete(key);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? `app-server request failed: ${pending.method}`);
        (error as Error & { code?: number; data?: unknown }).code = message.error.code;
        (error as Error & { code?: number; data?: unknown }).data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      this.emit("response", message, pending.method);
      return;
    }
    if (hasMethod && hasId) {
      const request = message as JsonRpcServerRequest;
      this.pendingAppServerRequests.set(String(request.id), request);
      this.emit("serverRequest", request);
      return;
    }
    if (hasMethod) {
      this.emit("notification", message as JsonRpcNotification);
      return;
    }
    this.emit("protocolError", new Error("Unclassifiable JSON-RPC message"), message);
  }

  private handleExit(child: AppServerProcessLike, code: number | null, signal: NodeJS.Signals | null): void {
    const intentional = this.intentionalStops.has(child);
    if (this.process && this.process !== child) {
      this.emit("processExit", { code, signal, intentional: true });
      return;
    }
    this.process = undefined;
    this.initialized = false;
    this.connectedAt = undefined;
    this.lineBuffer = "";
    for (const [id, pending] of this.pendingOutbound) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`app-server exited (code=${code ?? "null"}, signal=${signal ?? "none"})`));
      this.pendingOutbound.delete(id);
    }
    this.emit("processExit", { code, signal, intentional });
  }
}
