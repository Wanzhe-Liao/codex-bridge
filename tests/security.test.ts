import { describe, expect, it } from "vitest";
import { resolveProject } from "../src/config.js";
import { redactText } from "../src/redaction.js";
import { AppServerClient } from "../src/app-server-client.js";
import { StateStore } from "../src/store.js";
import { TaskManager } from "../src/task-manager.js";
import { MockAppServerProcess } from "./helpers.js";
import { makeConfig } from "./helpers.js";

describe("allowlist and redaction", () => {
  it("rejects unregistered projects and invalid identifiers", () => {
    expect(() => resolveProject(makeConfig(), "../../outside")).toThrow();
    expect(() => resolveProject(makeConfig(), "missing")).toThrow();
  });

  it("redacts common credentials and private keys", () => {
    const credential = ["sk", "test_12345678901234567890"].join("-");
    const privateKey = ["-----BEGIN ", "PRIVATE KEY-----secret-----END PRIVATE KEY-----"].join("");
    const value = `token=${credential} Bearer abcdefghijklmnop patient@example.com MRN=ABC-123 ${privateKey}`;
    const redacted = redactText(value);
    expect(redacted).not.toContain("sk-test");
    expect(redacted).not.toContain("BEGIN PRIVATE KEY");
    expect(redacted).not.toContain("Bearer abc");
    expect(redacted).not.toContain("patient@example.com");
    expect(redacted).not.toContain("ABC-123");
  });

  it("never persists raw reasoning text deltas", async () => {
    const process = new MockAppServerProcess({ autoComplete: false });
    const client = new AppServerClient({ processFactory: () => process, requestTimeoutMs: 2_000 });
    const store = new StateStore(":memory:");
    const manager = new TaskManager(client, store, makeConfig());
    const started = await manager.startTask("default", "Reason privately.");
    process.emitNotification("item/reasoning/textDelta", { threadId: started.thread_id, turnId: started.turn_id, itemId: "reason-1", delta: "hidden chain secret" });
    process.emitNotification("item/completed", { threadId: started.thread_id, turnId: started.turn_id, completedAtMs: Date.now(), item: { type: "reasoning", id: "reason-1", summary: ["safe summary"], content: ["hidden chain secret"] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const raw = JSON.stringify(manager.inspect(started.task_id, "raw_event"));
    expect(raw).not.toContain("hidden chain secret");
    expect(raw).toContain("safe summary");
    await client.stop();
    store.close();
  });
});
