import fs from "node:fs";
import path from "node:path";
import { lookup as lookupMime } from "mime-types";
import { resolveProject, type SupervisorConfig } from "./config.js";

const MAX_SCANNED_ENTRIES = 50_000;

export interface ArtifactMetadata {
  project_id: string;
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  mime_type: string | null;
  modified_at: string;
  resource_uri: string | null;
  preview: "text" | "image" | "audio" | "video" | "pdf" | "download" | null;
}

export interface LoadedArtifact {
  metadata: ArtifactMetadata & { kind: "file"; size: number; mime_type: string; resource_uri: string };
  data: Buffer;
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isSensitive(relativePath: string, config: SupervisorConfig): boolean {
  const normalized = `/${portablePath(relativePath).toLowerCase()}/`;
  return (config.sensitivePaths ?? []).some((entry) => {
    const fragment = portablePath(entry).replace(/^\/+|\/+$/g, "").toLowerCase();
    return fragment.length > 0 && normalized.includes(fragment);
  });
}

export function resolveArtifactPath(config: SupervisorConfig, projectId: string, requestedPath = "", requireFile = false): { root: string; absolute: string; relative: string } {
  const project = resolveProject(config, projectId);
  if (requestedPath.includes("\0")) throw new Error("Artifact path contains a null byte");
  if (path.isAbsolute(requestedPath) || /^[A-Za-z]:/.test(requestedPath) || requestedPath.startsWith("\\\\")) {
    throw new Error("Artifact paths must be relative to the configured project");
  }
  const root = fs.realpathSync.native(project.cwd);
  const lexical = path.resolve(root, requestedPath || ".");
  if (!isWithin(root, lexical)) throw new Error("Artifact path escapes the configured project");
  let absolute: string;
  try {
    absolute = fs.realpathSync.native(lexical);
  } catch {
    throw new Error(`Artifact path does not exist: ${requestedPath || "."}`);
  }
  if (!isWithin(root, absolute)) throw new Error("Artifact path resolves outside the configured project");
  const relative = portablePath(path.relative(root, absolute));
  if (relative && isSensitive(relative, config)) throw new Error("Artifact path is excluded by sensitive_paths");
  const stat = fs.statSync(absolute);
  if (requireFile && !stat.isFile()) throw new Error("Artifact path must identify a file");
  return { root, absolute, relative };
}

export function mimeTypeFor(filePath: string): string {
  return lookupMime(filePath) || "application/octet-stream";
}

export function previewKind(mimeType: string): ArtifactMetadata["preview"] {
  if (isTextMime(mimeType)) return "text";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  return "download";
}

export function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/sql",
  ].includes(mimeType) || mimeType.endsWith("+json") || mimeType.endsWith("+xml");
}

function encodeToken(projectId: string, relativePath: string): string {
  return Buffer.from(JSON.stringify({ projectId, path: relativePath }), "utf8").toString("base64url");
}

export function artifactResourceUri(projectId: string, relativePath: string): string {
  return `codex-artifact://file/${encodeToken(projectId, relativePath)}`;
}

export function decodeArtifactResourceToken(token: string): { projectId: string; path: string } {
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.projectId !== "string" || typeof value.path !== "string") throw new Error("invalid fields");
    return { projectId: value.projectId, path: value.path };
  } catch {
    throw new Error("Invalid artifact resource URI");
  }
}

function metadataFor(projectId: string, root: string, absolute: string, stat: fs.Stats): ArtifactMetadata {
  const relative = portablePath(path.relative(root, absolute));
  const kind = stat.isDirectory() ? "directory" : "file";
  const mimeType = kind === "file" ? mimeTypeFor(absolute) : null;
  return {
    project_id: projectId,
    path: relative,
    name: path.basename(absolute),
    kind,
    size: kind === "file" ? stat.size : null,
    mime_type: mimeType,
    modified_at: stat.mtime.toISOString(),
    resource_uri: kind === "file" ? artifactResourceUri(projectId, relative) : null,
    preview: mimeType ? previewKind(mimeType) : null,
  };
}

export function listArtifacts(config: SupervisorConfig, projectId: string, requestedPath: string, recursive: boolean, query: string | undefined, offset: number, limit: number): Record<string, unknown> {
  const resolved = resolveArtifactPath(config, projectId, requestedPath);
  const startStat = fs.statSync(resolved.absolute);
  const all: ArtifactMetadata[] = [];
  let scanned = 0;
  let excluded = 0;
  const needle = query?.trim().toLowerCase() || "";

  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scanned >= MAX_SCANNED_ENTRIES) return;
      scanned += 1;
      const lexical = path.join(directory, entry.name);
      let absolute: string;
      let stat: fs.Stats;
      try {
        absolute = fs.realpathSync.native(lexical);
        if (!isWithin(resolved.root, absolute)) { excluded += 1; continue; }
        const relative = portablePath(path.relative(resolved.root, absolute));
        if (isSensitive(relative, config)) { excluded += 1; continue; }
        stat = fs.statSync(absolute);
      } catch {
        excluded += 1;
        continue;
      }
      const metadata = metadataFor(projectId, resolved.root, absolute, stat);
      if (!needle || metadata.path.toLowerCase().includes(needle)) all.push(metadata);
      if (recursive && stat.isDirectory()) visit(absolute);
    }
  };

  if (startStat.isFile()) {
    const metadata = metadataFor(projectId, resolved.root, resolved.absolute, startStat);
    if (!needle || metadata.path.toLowerCase().includes(needle)) all.push(metadata);
  } else {
    visit(resolved.absolute);
  }
  all.sort((a, b) => a.path.localeCompare(b.path));
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, Math.min(config.maxPageSize, limit));
  return {
    project_id: projectId,
    base_path: resolved.relative,
    recursive,
    query: needle || null,
    files: all.slice(safeOffset, safeOffset + safeLimit),
    offset: safeOffset,
    limit: safeLimit,
    next_offset: safeOffset + safeLimit < all.length ? safeOffset + safeLimit : null,
    matched: all.length,
    scanned,
    excluded,
    scan_truncated: scanned >= MAX_SCANNED_ENTRIES,
  };
}

export function loadArtifact(config: SupervisorConfig, projectId: string, requestedPath: string): LoadedArtifact {
  const resolved = resolveArtifactPath(config, projectId, requestedPath, true);
  const stat = fs.statSync(resolved.absolute);
  if (stat.size > config.maxArtifactBytes) {
    throw new Error(`Artifact is ${stat.size} bytes; max_artifact_bytes is ${config.maxArtifactBytes}`);
  }
  const mimeType = mimeTypeFor(resolved.absolute);
  const metadata = metadataFor(projectId, resolved.root, resolved.absolute, stat);
  return {
    metadata: {
      ...metadata,
      kind: "file",
      size: stat.size,
      mime_type: mimeType,
      resource_uri: artifactResourceUri(projectId, resolved.relative),
    },
    data: fs.readFileSync(resolved.absolute),
  };
}
