/**
 * Regression tests for the `connect` reserved-name collision.
 *
 * `DurableObjectStub` extends `Fetcher`, and the Workers RPC dispatcher
 * resolves `Fetcher`'s built-in `{ fetch, connect }` methods before any
 * user-defined RPC method. So `stub.connect(credentials)` always routes
 * to `Fetcher.connect(SocketAddress)` and throws — the user-defined
 * method on the DO is unreachable through a stub.
 *
 * These tests pin the workaround: the public method is exposed as
 * `start()`, which has no Fetcher collision and dispatches correctly.
 * `connect()` survives as an in-class alias for `runInDurableObject`
 * callers and will be removed in 0.2.
 */
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getGatewayStub } from "../src/index";

describe("start() vs connect() through a DurableObjectStub", () => {
  it("stub.start() reaches the DO and validates credentials", async () => {
    const stub = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
    const result = await stub.start({
      botToken: "",
      webhookUrl: "https://example.com/webhook",
    });
    // Empty botToken should be caught by our validator, not by Fetcher.
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("botToken");
  });

  it("stub.connect() is shadowed by Fetcher.connect and throws", async () => {
    const stub = getGatewayStub({ namespace: env.DISCORD_GATEWAY });

    let caught: unknown;
    try {
      await (stub as unknown as { connect: (c: unknown) => Promise<unknown> }).connect({
        botToken: "fake-token",
        webhookUrl: "https://example.com/webhook",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    // Runtime throws a SocketAddress TypeError because GatewayCredentials
    // has no integer `port`. Confirms the dispatch hits Fetcher, not the DO.
    expect((caught as Error).message).toMatch(/integer|SocketAddress|port/i);
  });

  it("stub.status() and stub.disconnect() are unaffected", async () => {
    const stub = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
    const status = await stub.status();
    expect(status.status).toBe("disconnected");

    const disc = await stub.disconnect();
    expect(disc.status).toBe("disconnected");
  });
});
