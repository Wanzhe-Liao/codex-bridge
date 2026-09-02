import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

export interface AppServerProcessLike {
  stdin: Writable;
  stdout: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit" | "error", listener: (...args: any[]) => void): this;
  on?(event: "exit" | "error", listener: (...args: any[]) => void): this;
}

export interface AppServerProcessOptions {
  command?: string;
  spawnImpl?: typeof spawn;
}

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"];

/**
 * Resolve the locally installed Codex executable without asking a shell to
 * interpret the command. Windows npm installs often expose `codex.ps1` and
 * `codex.cmd`, while Node's spawn() needs the native `codex.exe` (or an
 * explicit cmd.exe fallback) when shell=false.
 */
export function resolveCodexInvocation(args: string[] = []): { command: string; args: string[] } {
  const configured = process.env.CODEX_BIN?.trim();
  const candidate = configured || (process.platform === "win32" ? findWindowsCodexBinary() : "codex");
  if (process.platform !== "win32") return { command: candidate, args };

  const extension = path.extname(candidate).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") return { command: candidate, args };

  const shell = process.env.ComSpec || "cmd.exe";
  const commandLine = [candidate, ...args].map(quoteCmdArg).join(" ");
  return { command: shell, args: ["/d", "/s", "/c", commandLine] };
}

function findWindowsCodexBinary(): string {
  const exe = findOnPath("codex.exe");
  if (exe) return exe;
  const cmd = findOnPath("codex.cmd");
  if (cmd) return cmd;
  // Keep a useful executable name in the error if Codex is not installed.
  return "codex.exe";
}

function findOnPath(name: string): string | undefined {
  try {
    const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return undefined;
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

function quoteCmdArg(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, "\\\"")}"`;
}

/** Starts the one long-lived `codex app-server --listen stdio://` child. */
export function spawnAppServer(options: AppServerProcessOptions = {}): ChildProcessWithoutNullStreams {
  const invocation = options.command
    ? { command: options.command, args: APP_SERVER_ARGS }
    : resolveCodexInvocation(APP_SERVER_ARGS);
  const spawnImpl = options.spawnImpl ?? spawn;
  return spawnImpl(invocation.command, invocation.args, {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
    env: { ...process.env },
  }) as unknown as ChildProcessWithoutNullStreams;
}
