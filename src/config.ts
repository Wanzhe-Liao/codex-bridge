import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import type { RedactionConfig } from "./redaction.js";

export type ApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | { granular: { sandbox_approval: boolean; rules: boolean; skill_approval: boolean; request_permissions: boolean; mcp_elicitations: boolean } };

export type SandboxType = "workspace-write" | "read-only" | "danger-full-access";

export interface ProjectConfig {
  id: string;
  cwd: string;
}

export interface ProfileConfig {
  id: string;
  model: string;
  effort: string;
  serviceTier?: string;
  approvalPolicy: ApprovalPolicy;
  sandboxType: SandboxType;
  networkAccess: boolean;
  waitTimeoutSeconds: number;
}

export interface SupervisorConfig extends RedactionConfig {
  path: string;
  exists: boolean;
  projects: Record<string, ProjectConfig>;
  profiles: Record<string, ProfileConfig>;
  defaultWaitTimeoutSeconds: number;
  maxInputLength: number;
  maxPageSize: number;
  maxCommandOutput: number;
  maxArtifactBytes: number;
  restartAttempts: number;
}

const DEFAULT_MAX_INPUT = 100_000;
const DEFAULT_MAX_PAGE = 100;
const DEFAULT_MAX_OUTPUT = 4_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

export function defaultConfigPath(): string {
  const override = process.env.CODEX_SUPERVISOR_CONFIG;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".config", "codex-supervisor-mcp", "config.toml");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function normaliseApproval(value: unknown): ApprovalPolicy {
  if (value === "untrusted" || value === "never") return value;
  if (value === "on-request" || value === "onRequest" || value === undefined || value === null || value === "") return "on-request";
  const record = asRecord(value);
  const granular = asRecord(record.granular);
  return {
    granular: {
      sandbox_approval: Boolean(granular.sandbox_approval ?? granular.sandboxApproval ?? true),
      rules: Boolean(granular.rules ?? true),
      skill_approval: Boolean(granular.skill_approval ?? granular.skillApproval ?? true),
      request_permissions: Boolean(granular.request_permissions ?? granular.requestPermissions ?? true),
      mcp_elicitations: Boolean(granular.mcp_elicitations ?? granular.mcpElicitations ?? true),
    },
  };
}

function normaliseSandbox(value: unknown): SandboxType {
  const text = stringValue(value, "workspace-write");
  if (["read-only", "readOnly"].includes(text)) return "read-only";
  if (["danger-full-access", "dangerFullAccess"].includes(text)) return "danger-full-access";
  return "workspace-write";
}

function parseProjects(root: Record<string, unknown>): Record<string, ProjectConfig> {
  const source = asRecord(root.projects);
  const result: Record<string, ProjectConfig> = {};
  for (const [id, raw] of Object.entries(source)) {
    const cwd = stringValue(asRecord(raw).cwd);
    if (!cwd) continue;
    result[id] = { id, cwd: path.resolve(cwd) };
  }
  return result;
}

function parseProfiles(root: Record<string, unknown>): Record<string, ProfileConfig> {
  const source = asRecord(root.profiles);
  const result: Record<string, ProfileConfig> = {};
  for (const [id, raw] of Object.entries(source)) {
    const record = asRecord(raw);
    result[id] = {
      id,
      model: stringValue(record.model),
      effort: stringValue(record.effort),
      serviceTier: stringValue(record.service_tier ?? record.serviceTier) || undefined,
      approvalPolicy: normaliseApproval(record.approval_policy ?? record.approvalPolicy),
      sandboxType: normaliseSandbox(record.sandbox_type ?? record.sandboxType),
      networkAccess: Boolean(record.network_access ?? record.networkAccess ?? false),
      waitTimeoutSeconds: numberValue(record.wait_timeout_seconds ?? record.waitTimeoutSeconds, 40, 1, 300),
    };
  }
  return result;
}

export function loadConfig(filePath = defaultConfigPath()): SupervisorConfig {
  const resolvedPath = path.resolve(filePath);
  let parsed: Record<string, unknown> = {};
  let exists = false;
  try {
    if (fs.existsSync(resolvedPath)) {
      parsed = asRecord(parse(fs.readFileSync(resolvedPath, "utf8")));
      exists = true;
      try { fs.chmodSync(resolvedPath, 0o600); } catch { /* Windows ACLs are managed by the user. */ }
    }
  } catch (error) {
    throw new Error(`Unable to read TOML configuration ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const redaction = asRecord(parsed.redaction);
  const patternValues = redaction.redaction_patterns ?? redaction.redactionPatterns;
  const sensitiveValues = redaction.sensitive_paths ?? redaction.sensitivePaths;
  return {
    path: resolvedPath,
    exists,
    projects: parseProjects(parsed),
    profiles: parseProfiles(parsed),
    defaultWaitTimeoutSeconds: numberValue(parsed.default_wait_timeout_seconds, 40, 1, 300),
    maxInputLength: numberValue(parsed.max_input_length, DEFAULT_MAX_INPUT, 100, 1_000_000),
    maxPageSize: numberValue(parsed.max_page_size, DEFAULT_MAX_PAGE, 1, 500),
    maxCommandOutput: numberValue(parsed.max_command_output, DEFAULT_MAX_OUTPUT, 256, 20_000),
    maxArtifactBytes: numberValue(parsed.max_artifact_bytes, DEFAULT_MAX_ARTIFACT_BYTES, 1_024, 256 * 1024 * 1024),
    restartAttempts: numberValue(parsed.restart_attempts, 2, 0, 5),
    redactionPatterns: Array.isArray(patternValues)
      ? patternValues.filter((v: unknown): v is string => typeof v === "string").slice(0, 50)
      : [],
    sensitivePaths: Array.isArray(sensitiveValues)
      ? sensitiveValues.filter((v: unknown): v is string => typeof v === "string").slice(0, 100)
      : [".env", ".ssh", "id_rsa", "id_ed25519"],
  };
}

export function builtinProfile(id = "default"): ProfileConfig {
  return {
    id,
    model: "",
    effort: "",
    approvalPolicy: "on-request",
    sandboxType: "workspace-write",
    networkAccess: false,
    waitTimeoutSeconds: 40,
  };
}

export function resolveProject(config: SupervisorConfig, projectId: string): ProjectConfig {
  if (!projectId || projectId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
    throw new Error("Unknown or invalid project_id; use a project registered in local config");
  }
  const project = config.projects[projectId];
  if (!project) throw new Error(`Unknown project_id: ${projectId}`);
  const cwd = path.resolve(project.cwd);
  if (!path.isAbsolute(cwd)) throw new Error("Configured project cwd must be absolute");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new Error(`Configured project cwd does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new Error(`Configured project cwd is not a directory: ${cwd}`);
  return { ...project, cwd };
}

export function resolveProfile(config: SupervisorConfig, profileId?: string): ProfileConfig {
  if (profileId !== undefined && (!profileId || profileId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(profileId))) {
    throw new Error("Unknown or invalid profile; use a profile registered in local config");
  }
  if (profileId) {
    const profile = config.profiles[profileId];
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    return profile;
  }
  return config.profiles.default ?? Object.values(config.profiles)[0] ?? builtinProfile();
}

export function sandboxPolicy(profile: ProfileConfig, project: ProjectConfig): Record<string, unknown> {
  if (profile.sandboxType === "read-only") return { type: "readOnly", networkAccess: profile.networkAccess };
  if (profile.sandboxType === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    writableRoots: [project.cwd],
    networkAccess: profile.networkAccess,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

export function publicConfig(config: SupervisorConfig): Record<string, unknown> {
  return {
    path: config.path,
    exists: config.exists,
    projects: Object.values(config.projects).map(({ id, cwd }) => ({ id, cwd })),
    profiles: Object.values(config.profiles).map((profile) => ({
      id: profile.id,
      model: profile.model || null,
      effort: profile.effort || null,
      serviceTier: profile.serviceTier ?? null,
      approvalPolicy: profile.approvalPolicy,
      sandboxType: profile.sandboxType,
      networkAccess: profile.networkAccess,
    })),
    artifactTransfer: {
      maxBytes: config.maxArtifactBytes,
      extensionAllowlist: null,
      sensitivePathsExcluded: (config.sensitivePaths ?? []).length,
    },
  };
}
