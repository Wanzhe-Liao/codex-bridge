import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppServerClient } from "./app-server-client.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./tools.js";
import { codexVersion, TaskManager } from "./task-manager.js";
import { StateStore } from "./store.js";
import { VERSION } from "./version.js";

export interface SupervisorRuntime {
  client: AppServerClient;
  store: StateStore;
  manager: TaskManager;
  server: ReturnType<typeof createMcpServer>;
}

export function createRuntime(): SupervisorRuntime {
  const config = loadConfig();
  const store = new StateStore();
  const client = new AppServerClient({ version: VERSION });
  const manager = new TaskManager(client, store, config);
  const server = createMcpServer(manager);
  return { client, store, manager, server };
}

async function runDoctor(): Promise<void> {
  let runtime: SupervisorRuntime | undefined;
  const output: Record<string, unknown> = { codex_version: codexVersion() };
  try {
    runtime = createRuntime();
    const health = await runtime.manager.health();
    output.config = health.config;
    output.projects = health.available_project_ids;
    output.profiles = health.available_profiles;
    output.login = health.login;
    output.app_server = health.app_server;
    output.models = health.models;
    output.sqlite = health.sqlite;
    output.mcp_server = { can_construct: true, transport: "stdio" };
    output.warnings = health.warnings;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    output.mcp_server = { can_construct: Boolean(runtime), transport: "stdio" };
    output.error = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    if (runtime) {
      await runtime.client.stop().catch(() => undefined);
      runtime.store.close();
    }
  }
}

async function runServer(): Promise<void> {
  const runtime = createRuntime();
  // Connect in the background so MCP tools can still expose a useful health error
  // when Codex is logged out or unavailable. All diagnostics go to stderr.
  runtime.manager.ensureConnected().catch((error) => process.stderr.write(`[supervisor] app-server unavailable: ${error instanceof Error ? error.message : String(error)}\n`));
  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);
  const shutdown = async () => {
    await runtime.client.stop().catch(() => undefined);
    runtime.store.close();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
}

if (process.argv[2] === "doctor") {
  void runDoctor();
} else {
  void runServer().catch((error) => {
    process.stderr.write(`[supervisor] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
