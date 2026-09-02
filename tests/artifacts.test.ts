import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.js";
import { artifactResourceUri, decodeArtifactResourceToken, listArtifacts, loadArtifact, resolveArtifactPath } from "../src/artifacts.js";
import { StateStore } from "../src/store.js";
import { TaskManager } from "../src/task-manager.js";
import { createMcpServer } from "../src/tools.js";
import { makeConfig } from "./helpers.js";

const temporaryPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(() => {
  for (const target of temporaryPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("project artifact transfer", () => {
  it("lists files, preserves MIME metadata, and loads text and PDF bytes", () => {
    const root = temporaryDirectory("codex-bridge-artifacts-");
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "notes.txt"), "natural language result\n");
    fs.writeFileSync(path.join(root, "docs", "paper.pdf"), Buffer.from("%PDF-1.7\nmock\n", "ascii"));
    const config = makeConfig(root);

    const listing = listArtifacts(config, "default", "", true, undefined, 0, 100) as any;
    expect(listing.files.map((entry: any) => entry.path)).toEqual(["docs", "docs/paper.pdf", "notes.txt"]);
    expect(listing.files.find((entry: any) => entry.path === "docs/paper.pdf")).toMatchObject({ mime_type: "application/pdf", preview: "pdf" });

    const text = loadArtifact(config, "default", "notes.txt");
    expect(text.data.toString("utf8")).toBe("natural language result\n");
    expect(text.metadata.preview).toBe("text");
    const pdf = loadArtifact(config, "default", "docs/paper.pdf");
    expect(pdf.data.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(pdf.metadata.resource_uri).toBe(artifactResourceUri("default", "docs/paper.pdf"));
    const token = new URL(pdf.metadata.resource_uri).pathname.slice(1);
    expect(decodeArtifactResourceToken(token)).toEqual({ projectId: "default", path: "docs/paper.pdf" });
  });

  it("rejects traversal, absolute paths, sensitive paths, symlink escape, and oversized files", () => {
    const root = temporaryDirectory("codex-bridge-root-");
    const outside = temporaryDirectory("codex-bridge-outside-");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret");
    fs.writeFileSync(path.join(root, "large.bin"), Buffer.alloc(2_048));
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside");
    const config = makeConfig(root);
    config.maxArtifactBytes = 1_024;

    expect(() => resolveArtifactPath(config, "default", "../outside.txt", true)).toThrow(/escapes/);
    expect(() => resolveArtifactPath(config, "default", path.resolve(outside, "outside.txt"), true)).toThrow(/relative/);
    expect(() => loadArtifact(config, "default", ".env")).toThrow(/sensitive_paths/);
    expect(() => loadArtifact(config, "default", "large.bin")).toThrow(/max_artifact_bytes/);

    const link = path.join(root, "outside-link");
    try {
      fs.symlinkSync(outside, link, "junction");
      expect(() => resolveArtifactPath(config, "default", "outside-link/outside.txt", true)).toThrow(/outside/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  it("returns a standards-based resource plus a ChatGPT preview widget", async () => {
    const root = temporaryDirectory("codex-bridge-tool-");
    fs.writeFileSync(path.join(root, "paper.pdf"), Buffer.from("%PDF-1.7\nbridge\n", "ascii"));
    const manager = new TaskManager(new AppServerClient({ processFactory: () => new (class { } as any)() }), new StateStore(":memory:"), makeConfig(root));
    const server: any = createMcpServer(manager);
    const tool = server._registeredTools.codex_artifact;
    const result = await tool.handler({ project_id: "default", path: "paper.pdf" }, {});

    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tool._meta.ui.resourceUri).toMatch(/^ui:\/\/codex-bridge\//);
    expect(result.structuredContent.artifact).toMatchObject({ path: "paper.pdf", mime_type: "application/pdf", preview: "pdf" });
    expect(result.content.some((block: any) => block.type === "resource_link")).toBe(true);
    const embedded = result.content.find((block: any) => block.type === "resource");
    expect(Buffer.from(embedded.resource.blob, "base64").toString("ascii")).toContain("%PDF-1.7");

    const viewer = server._registeredResources[tool._meta.ui.resourceUri];
    const viewerResult = await viewer.readCallback(new URL(tool._meta.ui.resourceUri), {});
    expect(viewerResult.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    expect(viewerResult.contents[0].text).toContain("ui/notifications/tool-result");
    expect(viewerResult.contents[0].text).toContain("download");

    const uri = result.structuredContent.artifact.resource_uri;
    const token = new URL(uri).pathname.slice(1);
    const template = server._registeredResourceTemplates["codex-project-artifact"];
    const resourceResult = await template.readCallback(new URL(uri), { token }, {});
    expect(Buffer.from(resourceResult.contents[0].blob, "base64").toString("ascii")).toContain("%PDF-1.7");
  });
});
