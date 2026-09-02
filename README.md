# Codex Bridge

Codex Bridge is a local stdio MCP server that lets ChatGPT supervise the real Codex runtime and receive project artifacts without exposing a second shell, Git, SSH, or model loop.

```text
ChatGPT GPT Pro
  -> Secure MCP Tunnel / stdio MCP
  -> Codex Bridge
  -> codex app-server --listen stdio://
  -> local Codex models, tools, projects, and configured MCP servers
```

The MCP layer manages Codex threads, turns, events, approvals, questions, recovery, and delivery evidence. A read-only artifact layer also lets ChatGPT browse and transfer files from configured projects for inspection, inline preview, and download. Codex remains responsible for project writes, commands, Git, SSH, MCP tools, research work, and its final natural-language answer.

## Requirements and setup

- Node.js 20 or newer
- A locally installed `codex` CLI
- A working Codex login for real turns (`model/list` and protocol smoke checks can still work when a turn login is unavailable)

```bash
git clone https://github.com/Wanzhe-Liao/codex-bridge.git
cd codex-bridge
npm ci
npm run build
```

Copy `config.example.toml` to `~/.config/codex-supervisor-mcp/config.toml`, then register only absolute project directories that ChatGPT may select. ChatGPT supplies `project_id` and an optional local `profile`; it cannot supply an arbitrary working directory, provider, or app-server command. The legacy `codex-supervisor-mcp` configuration and state directory names are intentionally retained for compatibility with existing installations.

```toml
max_artifact_bytes = 33554432 # 32 MiB; configurable up to 256 MiB

[projects.default]
cwd = "/absolute/path/to/project"

[profiles.default]
model = ""                    # inherit Codex default
effort = ""                   # inherit Codex default
approval_policy = "on-request"
sandbox_type = "workspace-write"
network_access = false
wait_timeout_seconds = 40
```

Profile model, effort, and service tier values are checked at task start against this machine's live `model/list`. Keep them empty to inherit local defaults. `workspace-write` supplies exactly the registered project as `writableRoots`.

Run the server:

```bash
npm start
```

The server's stdout is reserved for MCP protocol messages. Diagnostics and app-server stderr go to stderr. Task state uses one WAL-mode SQLite database at `~/.local/share/codex-supervisor-mcp/state.sqlite3`; if a sandboxed desktop host cannot create that directory, it falls back to the ignored `.supervisor/state.sqlite3` in the launch directory. Override paths only from the local environment with `CODEX_SUPERVISOR_CONFIG` and `CODEX_SUPERVISOR_STATE`.

On Windows, the supervisor resolves the native `codex.exe` on `PATH` so npm's
`codex.ps1`/`codex.cmd` shims do not cause a `spawn codex ENOENT` error. If a
machine has multiple Codex installations, set the local (never ChatGPT-provided)
`CODEX_BIN` environment variable to the desired executable path.

## MCP tools

- `codex_health`: configuration, SQLite, app-server, login and simplified live model status.
- `codex_start`: create a thread/task and start a natural-language turn.
- `codex_wait`: bounded long-poll returning real plans, activity, Codex messages, events, requests and terminal state.
- `codex_status`: immediate task status, or active/recent task recovery list.
- `codex_send`: `turn/steer` an active turn or start a new turn on the same completed/lost thread.
- `codex_respond`: validate and answer approvals, permissions, user input and MCP elicitations with the original JSON-RPC request ID.
- `codex_result`: return an authoritative terminal delivery, Codex's natural-language final message, and independent evidence.
- `codex_inspect`: paginate transcript, plan, diff, commands, bounded output, file changes, MCP calls, warnings, or redacted raw events.
- `codex_cancel`: send `turn/interrupt` and wait for authoritative `turn/completed`.
- `codex_files`: browse or search file metadata inside a configured project; recursive search and pagination are supported.
- `codex_artifact`: transfer the original file through MCP and render a ChatGPT preview/download component when supported.

The artifact interface has no extension allowlist. It handles text, source files, PDF, images, audio, video, spreadsheets, archives, and arbitrary binary files. Images and audio use native MCP content blocks; other files use embedded resources plus a dynamic `codex-artifact://` resource readable through `resources/read`. PDFs, images, audio, video, and text get an inline viewer; formats the browser cannot render still get the original-file download button.

Example instructions to GPT Pro:

```text
Use Codex Bridge project default. List PDFs under papers recursively, open the
latest manuscript, show it to me, and make the original file downloadable.
```

```text
Browse project default for results/summary.csv, open it, inspect the contents,
and attach the original CSV for download. Do not start a Codex task.
```

`turn/start` never contains `outputSchema`; prompts and final answers remain ordinary natural language. No tool response invents percentage progress. Only `turn/completed` makes the current turn terminal.

## Doctor, tests, and protocol verification

```bash
npm run doctor
npm test
```

`doctor` prints the Codex version, login availability without identity or credentials, app-server initialize status, live models, project/profile mappings, SQLite writability, and MCP construction status.

This implementation was verified against schemas generated by the locally installed CLI using:

```bash
codex --version
codex app-server generate-ts --out <temporary-directory>
codex app-server generate-json-schema --out <temporary-directory>
```

Generated schemas are not copied into the project. Unit tests use a JSONL mock app-server for initialization ordering, IDs, long tasks, plans, commands, diffs, file changes, MCP calls, approvals, questions, persistence, interruption, failure, crash recovery, redaction, tool annotations, wait semantics, artifact MIME handling, PDF byte transfer, viewer registration, size bounds, traversal, and symlink escape.

The optional real integration test is disabled by default because it can consume Codex quota:

```bash
CODEX_SUPERVISOR_REAL_INTEGRATION=1 npm run integration
```

On PowerShell:

```powershell
$env:CODEX_SUPERVISOR_REAL_INTEGRATION = "1"
npm run integration
```

Test tool discovery with MCP Inspector from the project directory:

```bash
npx @modelcontextprotocol/inspector node /absolute/path/to/codex-bridge/dist/index.js
```

For a non-UI tool-list smoke check:

```bash
npx @modelcontextprotocol/inspector --cli node /absolute/path/to/codex-bridge/dist/index.js --method tools/list
```

## Secure MCP Tunnel and ChatGPT

Use absolute paths for both Node and the built script. Keep the control-plane key in the process environment, never in TOML or this repository.

```bash
export CONTROL_PLANE_API_KEY="..."

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile codex-bridge \
  --tunnel-id <TUNNEL_ID> \
  --mcp-command "/absolute/path/to/node /absolute/path/to/codex-bridge/dist/index.js"

tunnel-client doctor \
  --profile codex-bridge \
  --explain

tunnel-client run \
  --profile codex-bridge
```

In ChatGPT on the web, enable Developer mode, create a developer App, select the configured Tunnel, refresh both tools and server instructions, and enable the App in the GPT Pro conversation. The embedded server instructions require GPT Pro to stay in the same response and repeatedly call `codex_wait`, resolve safe requests, wait for authoritative `turn/completed`, then call `codex_result` and inspect objective evidence before replying to the user. After upgrading Codex Bridge, restart `tunnel-client run` and refresh the App's tools/resources so ChatGPT sees the new artifact tools and viewer.

## Security boundaries

- Project paths and profiles are local allowlists; MCP inputs cannot provide arbitrary absolute paths, providers, or process commands.
- Artifact paths are relative to an allowlisted project. Lexical traversal and symlinks/junctions that resolve outside the project are rejected. Configured `sensitive_paths` remain unavailable for transfer.
- Artifact transfer is read-only, has no extension whitelist, and uses the locally configurable `max_artifact_bytes` transport bound to prevent unbounded JSONL/base64 messages.
- Start/send/respond/cancel are accurately marked mutating and potentially destructive; health/status/wait/result/inspect are read-only.
- Approval is never globally automatic. High-risk commands, project-external grants, credential-like requests, and arbitrary dynamic tool execution are declined or restricted.
- Built-in and configurable redaction removes common tokens, private keys, passwords, sensitive paths, and credential fields. Raw reasoning text deltas are not persisted or returned.
- Command output, artifact size, and pages are bounded. Completed command exit codes, file-change status, MCP status, aggregated diff, and fixed read-only Git checks form the evidence returned by `codex_result`.

Known operational limitation: a supervisor process cannot prove that an in-flight turn survived an app-server crash when `thread/resume` no longer reports an active turn. In that case it preserves all IDs/events and reports nonterminal `connection_lost`; `codex_send` starts a recovery turn on the same thread rather than claiming completion.
