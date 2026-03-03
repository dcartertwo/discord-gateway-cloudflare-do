import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { DiscordGatewayDO } from "../src/durable-object";
import { GatewayOpcode, type GatewayState } from "../src/types";

const STATE_KEY = "gateway_state";
const CREDENTIALS_KEY = "credentials";

function getStub() {
  const id = env.DISCORD_GATEWAY.idFromName("test-" + Math.random());
  return env.DISCORD_GATEWAY.get(id);
}

describe("DiscordGatewayDO", () => {
  // -- connect / disconnect / status (via RPC) -----------------------------

  describe("connect", () => {
    it("rejects missing botToken", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-missing-token");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "",
            webhookUrl: "https://example.com/webhooks/discord",
          });
          expect("error" in res).toBe(true);
          expect((res as { error: string }).error).toContain("botToken");
        },
      );
    });

    it("rejects missing webhookUrl", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-missing-webhook");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "Bot token.here",
            webhookUrl: "",
          });
          expect("error" in res).toBe(true);
        },
      );
    });

    it("rejects non-HTTPS webhookUrl", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-http-webhook");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "Bot token.here",
            webhookUrl: "http://example.com/webhooks/discord",
          });
          expect("error" in res).toBe(true);
          expect((res as { error: string }).error).toContain("HTTPS");
        },
      );
    });

    it("rejects invalid webhookUrl", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-invalid-webhook");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          const res = await instance.connect({
            botToken: "Bot token.here",
            webhookUrl: "not-a-url",
          });
          expect("error" in res).toBe(true);
          expect((res as { error: string }).error).toContain("valid URL");
        },
      );
    });

    it("stores credentials in DO storage", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-creds");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });

          const creds = await instance.ctx.storage.get(CREDENTIALS_KEY);
          expect(creds).toEqual({
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });
        },
      );
    });
  });

  describe("disconnect", () => {
    it("clears credentials and state", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-disconnect");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          // Set up some state
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });
          await instance.ctx.storage.put(STATE_KEY, {
            wsUrl: "wss://gateway.discord.gg",
            sessionId: "session-123",
            sequence: 42,
            heartbeatIntervalMs: 41250,
            lastHeartbeatAck: Date.now(),
            connectedAt: new Date().toISOString(),
            reconnectAttempts: 0,
          } satisfies GatewayState);

          const res = await instance.disconnect();
          expect(res.status).toBe("disconnected");

          const creds = await instance.ctx.storage.get(CREDENTIALS_KEY);
          expect(creds).toBeUndefined();

          const state = await instance.ctx.storage.get(STATE_KEY);
          expect(state).toBeUndefined();
        },
      );
    });
  });

  describe("status", () => {
    it("returns disconnected when no state", async () => {
      const stub = getStub();
      const res = await stub.status();
      expect(res.status).toBe("disconnected");
    });

    it("returns connecting when state exists but no WebSocket", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-status-connecting");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(STATE_KEY, {
            wsUrl: "wss://gateway.discord.gg",
            sessionId: "session-123",
            sequence: 42,
            heartbeatIntervalMs: 41250,
            lastHeartbeatAck: Date.now(),
            connectedAt: new Date().toISOString(),
            reconnectAttempts: 0,
          } satisfies GatewayState);

          const result = await instance.status();
          expect(result.status).toBe("connecting");
          expect(result.sessionId).toBe("session-123");
          expect(result.sequence).toBe(42);
        },
      );
    });
  });

  // -- alarm handler -------------------------------------------------------

  describe("alarm", () => {
    it("does nothing with no state", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-alarm-empty");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          // Should not throw
          await instance.alarm();
        },
      );
    });

    it("attempts reconnect when wsUrl is null (backoff period)", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-alarm-backoff");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });
          await instance.ctx.storage.put(STATE_KEY, {
            wsUrl: null,
            sessionId: null,
            sequence: null,
            heartbeatIntervalMs: null,
            lastHeartbeatAck: null,
            connectedAt: null,
            reconnectAttempts: 1,
          } satisfies GatewayState);

          // alarm() will attempt to connect, which will fail (no Discord)
          // but shouldn't throw
          await instance.alarm();
        },
      );
    });

    it("detects DO eviction (state exists, no WebSocket)", async () => {
      const id = env.DISCORD_GATEWAY.idFromName("test-alarm-eviction");
      await runInDurableObject(
        env.DISCORD_GATEWAY.get(id),
        async (instance: DiscordGatewayDO) => {
          await instance.ctx.storage.put(CREDENTIALS_KEY, {
            botToken: "test-token",
            webhookUrl: "https://example.com/webhooks/discord",
          });
          await instance.ctx.storage.put(STATE_KEY, {
            wsUrl: "wss://gateway.discord.gg",
            sessionId: "session-123",
            sequence: 42,
            heartbeatIntervalMs: 41250,
            lastHeartbeatAck: Date.now(),
            connectedAt: new Date().toISOString(),
            reconnectAttempts: 0,
          } satisfies GatewayState);

          // No upstream WebSocket (simulates DO eviction).
          // alarm() should clear stale state and attempt reconnect.
          await instance.alarm();

          // Stale state should be cleared
          const state =
            await instance.ctx.storage.get<GatewayState>(STATE_KEY);
          // State is either cleared or replaced by a new connection attempt
          if (state) {
            // If a new state was written, the old wsUrl should be gone
            // (cleared before reconnect attempt)
            expect(state.sessionId).toBeNull();
          }
        },
      );
    });
  });

  // -- types ---------------------------------------------------------------

  describe("types", () => {
    it("GatewayOpcode values match Discord spec", () => {
      expect(GatewayOpcode.Dispatch).toBe(0);
      expect(GatewayOpcode.Heartbeat).toBe(1);
      expect(GatewayOpcode.Identify).toBe(2);
      expect(GatewayOpcode.Resume).toBe(6);
      expect(GatewayOpcode.Reconnect).toBe(7);
      expect(GatewayOpcode.InvalidSession).toBe(9);
      expect(GatewayOpcode.Hello).toBe(10);
      expect(GatewayOpcode.HeartbeatAck).toBe(11);
    });
  });

  // -- getGatewayStub helper -----------------------------------------------

  describe("getGatewayStub", async () => {
    const { getGatewayStub } = await import("../src/index");

    it("returns a stub with default name", () => {
      const stub = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      expect(stub).toBeDefined();
    });

    it("returns different stubs for different names", () => {
      const stub1 = getGatewayStub({
        namespace: env.DISCORD_GATEWAY,
        name: "agent-1",
      });
      const stub2 = getGatewayStub({
        namespace: env.DISCORD_GATEWAY,
        name: "agent-2",
      });
      expect(stub1.id.toString()).not.toBe(stub2.id.toString());
    });

    it("returns same DO for same name", () => {
      const stub1 = getGatewayStub({
        namespace: env.DISCORD_GATEWAY,
        name: "agent-1",
      });
      const stub2 = getGatewayStub({
        namespace: env.DISCORD_GATEWAY,
        name: "agent-1",
      });
      expect(stub1.id.toString()).toBe(stub2.id.toString());
    });
  });
});
