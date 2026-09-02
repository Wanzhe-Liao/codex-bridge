import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.js";
import { MockAppServerProcess } from "./helpers.js";

describe("AppServerClient", () => {
  it("initializes before sending initialized and other requests", async () => {
    const process = new MockAppServerProcess();
    const client = new AppServerClient({ processFactory: () => process, requestTimeoutMs: 2_000 });
    const outbound: Record<string, unknown>[] = [];
    client.on("outbound", (message) => outbound.push(message));
    await client.start();
    expect(outbound[0]).toMatchObject({ id: 1, method: "initialize" });
    expect(outbound[0].params).toMatchObject({ clientInfo: { name: "chatgpt_web_codex_supervisor", title: "ChatGPT Web Codex Supervisor", version: "0.1.0" } });
    expect(outbound[1]).toEqual({ jsonrpc: "2.0", method: "initialized" });
    await client.request("model/list", {});
    expect(outbound[2]).toMatchObject({ id: 2, method: "model/list" });
  });

  it("matches responses by request id and dispatches server requests separately", async () => {
    const process = new MockAppServerProcess();
    const client = new AppServerClient({ processFactory: () => process, requestTimeoutMs: 2_000 });
    await client.start();
    const serverRequest = new Promise<any>((resolve) => client.once("serverRequest", resolve));
    process.emitServerRequest(77, "item/commandExecution/requestApproval", { threadId: "t", turnId: "u", itemId: "i", command: "echo ok" });
    await expect(serverRequest).resolves.toMatchObject({ id: 77, method: "item/commandExecution/requestApproval" });
    const first = client.request("model/list", {});
    const second = client.request("model/list", {});
    await expect(first).resolves.toHaveProperty("data");
    await expect(second).resolves.toHaveProperty("data");
    expect(process.outbound.filter((message) => message.method === "model/list")).toHaveLength(2);
  });

  it("reports malformed JSON without allowing a second stdout reader", async () => {
    const process = new MockAppServerProcess();
    const errors: Error[] = [];
    const client = new AppServerClient({ processFactory: () => process, logger: () => undefined });
    client.on("protocolError", (error: Error) => errors.push(error));
    await client.start();
    process.stdout.write("not-json\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
  });

  it("restarts without an old child exit clearing the new connection", async () => {
    const first = new MockAppServerProcess();
    const second = new MockAppServerProcess();
    const queue = [first, second];
    const client = new AppServerClient({ processFactory: () => queue.shift()!, requestTimeoutMs: 2_000 });
    await client.start();
    await client.restart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isInitialized).toBe(true);
    await expect(client.request("model/list", {})).resolves.toHaveProperty("data");
    await client.stop();
  });
});
