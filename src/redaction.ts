import path from "node:path";

export interface RedactionConfig {
  sensitivePaths?: string[];
  redactionPatterns?: string[];
}

const BUILTIN_PATTERNS: RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:xox[baprs]-)[A-Za-z0-9-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:MRN|patient[_ -]?id|medical[_ -]?record[_ -]?number|SSN)\s*[:=]\s*[A-Za-z0-9._-]+/gi,
];

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "gi");
  } catch {
    return undefined;
  }
}

export function redactText(value: string, config: RedactionConfig = {}): string {
  let result = value;
  for (const pattern of BUILTIN_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  for (const source of config.redactionPatterns ?? []) {
    const pattern = safeRegex(source);
    if (pattern) result = result.replace(pattern, "[REDACTED]");
  }
  for (const fragment of config.sensitivePaths ?? []) {
    if (!fragment) continue;
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), "[REDACTED_PATH]");
  }
  return result;
}

function pathLooksSensitive(value: string, config: RedactionConfig): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return (config.sensitivePaths ?? []).some((fragment) => {
    const needle = fragment.replaceAll("\\", "/").toLowerCase();
    return needle.length > 0 && normalized.includes(needle);
  });
}

/** Redact values recursively while retaining a JSON-safe shape. */
export function redactValue(value: unknown, config: RedactionConfig = {}, key?: string): unknown {
  if (typeof value === "string") {
    if (key && /(?:token|secret|password|api[-_]?key|authorization|privatekey|email|patient.*id|mrn|ssn|dateofbirth|dob)/i.test(key)) {
      return "[REDACTED]";
    }
    if (pathLooksSensitive(value, config) && (key?.toLowerCase().includes("path") || key?.toLowerCase().includes("cwd") || key?.toLowerCase().includes("file"))) {
      return "[REDACTED_PATH]";
    }
    return redactText(value, config);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, config));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([name, item]) => [name, redactValue(item, config, name)]));
  }
  return value;
}

export function redactJson(value: unknown, config: RedactionConfig = {}): string {
  try {
    return JSON.stringify(redactValue(value, config));
  } catch {
    return JSON.stringify({ redacted: true });
  }
}

export function redactPath(value: string, config: RedactionConfig = {}): string {
  return pathLooksSensitive(value, config) ? "[REDACTED_PATH]" : redactText(path.normalize(value), config);
}

export function boundedExcerpt(value: string | null | undefined, limit = 4000): { text: string; truncated: boolean } {
  const text = value ?? "";
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.max(1, Math.floor(limit * 0.6));
  const tail = Math.max(1, limit - head);
  return {
    text: `${text.slice(0, head)}\n...[output truncated]...\n${text.slice(-tail)}`,
    truncated: true,
  };
}
